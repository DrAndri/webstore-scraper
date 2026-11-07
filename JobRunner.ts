import { hostname } from 'node:os';
import { createPool, Pool, UpsertResult } from 'mariadb';
import { MemoryStorage, RequestList, RequestQueue } from 'crawlee';
import {
  ProductScrapeErrors,
  ProductSnapshot,
  ScheduledMode,
  ScrapeJob,
  ScrapeJobOptions,
  ScrapeJobSource,
  ScrapeResult,
  Store,
  StoreConfig,
  StoreUpdateResult,
  TestResult,
  WebshopCrawlerOptions
} from './types/index.js';
import BaseCrawler from './crawler/BaseCrawler.js';
import WebshopCrawler from './crawler/WebshopCrawler.js';
import WebshopHtmlCrawler from './crawler/WebshopHtmlCrawler.js';
import SQLStoreUpdater, {
  indexEverything,
  IndexProgress,
  poolConfig
} from './SQLStoreUpdater.js';
import { syncSolrSchemas } from './SolrSchema.js';
import StoreConfigLoader, {
  LoadedConfig,
  ReloadResult,
  validateStoreConfig
} from './StoreConfigLoader.js';
import { logger } from './logger.js';

const log = logger.child({ label: 'JobRunner' });

const POLL_INTERVAL_MS = 5000;
const MAX_RUNNING_TESTS = 2;
// Stores scanned at a time until scraperSettings is read
const DEFAULT_CONCURRENCY = 5;

interface RunningJob {
  job: ScrapeJob;
  crawler?: BaseCrawler;
  // Of an index job
  indexProgress?: IndexProgress;
  cancelled: boolean;
}

interface JobResult {
  scrapeResult?: ScrapeResult;
  // Documents indexed in each Solr core by an index job
  updateResult?: StoreUpdateResult | Record<string, number>;
  testResult?: TestResult;
  errorMessage?: string;
  // The job failed without throwing, e.g. a schema sync where a core failed
  failed?: boolean;
}

// A row of configReloads, storeId is null for a reload of every config
interface ConfigReload {
  id: number;
  storeId: number | null;
}

// The jobs that work on Solr, one of them runs at a time
const SOLR_MODES = new Set(['index', 'schema']);

const parseOptions = (job: ScrapeJob): ScrapeJobOptions =>
  (typeof job.options === 'string'
    ? (JSON.parse(job.options) as ScrapeJobOptions | null)
    : job.options) ?? {};

// The counters of an index job in the columns of a scan: the documents to
// index as requests and the documents indexed as processed
const indexCounters = ({ total, indexed }: IndexProgress) => ({
  totalRequests: total,
  totalProcessed: indexed,
  totalErrored: 0
});

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

// UTC 'YYYY-MM-DD HH:MM:SS' for DATETIME columns
const toSqlDateTime = (date: Date) =>
  date.toISOString().slice(0, 19).replace('T', ' ');

function reportResults(results: StoreUpdateResult, storeName: string): void {
  log.info(`Finished updating ${storeName}`, results);
}

// Runs the jobs queued in scrapeJobs, by cron, at startup or from the admin
// interface. Only one scraper instance should run against a database.
export default class JobRunner {
  pool: Pool;
  attributesPool: Pool;
  categoriesPool: Pool;
  manufacturersPool: Pool;
  configLoader: StoreConfigLoader;
  // Stores scanned at a time, from scraperSettings
  concurrency = DEFAULT_CONCURRENCY;
  running = new Map<number, RunningJob>();
  startedAt = new Date();
  ticking = false;

  constructor(configLoader: StoreConfigLoader) {
    this.configLoader = configLoader;
    this.pool = createPool({ ...poolConfig, connectionLimit: 2 });
    // Single connection pools so attributes, categories and manufacturers are
    // not created twice by stores scraped at the same time
    this.attributesPool = createPool(poolConfig);
    this.categoriesPool = createPool(poolConfig);
    this.manufacturersPool = createPool(poolConfig);
  }

  async start() {
    // Fails when the scraperSettings migration has not been run
    await this.pool.query(
      'INSERT IGNORE INTO scraperSettings (id, concurrency) VALUES (1, ?)',
      [DEFAULT_CONCURRENCY]
    );
    await this.loadSettings();
    const interrupted = await this.pool.query<UpsertResult>(
      "UPDATE scrapeJobs SET status = 'failed', finishedAt = UTC_TIMESTAMP(), errorMessage = 'Interrupted, the scraper stopped while the job was running' WHERE status = 'running'"
    );
    if (interrupted.affectedRows > 0)
      log.warn(`Marked ${interrupted.affectedRows} interrupted jobs as failed`);
    await this.tick();
    setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    log.info('Job runner started');
  }

  // Queues a job for the store when it is enabled and has a config, unless it
  // already has a job of the same mode queued or running
  async enqueue(storeId: number, mode: ScheduledMode, source: ScrapeJobSource) {
    const { configs } = await this.configLoader.get();
    if (!configs.has(storeId)) {
      log.warn(`Not queueing a ${mode} job for store ${storeId}, no config`);
      return;
    }
    const result = await this.pool.query<UpsertResult>(
      `INSERT INTO scrapeJobs (storeId, mode, source, status, queuedAt)
       SELECT s.id, ?, ?, 'queued', UTC_TIMESTAMP() FROM stores s
       WHERE s.id = ? AND s.scraperEnabled = 1 AND NOT EXISTS (
         SELECT 1 FROM scrapeJobs j WHERE j.storeId = s.id AND j.mode = ? AND j.status IN ('queued', 'running')
       )`,
      [mode, source, storeId, mode]
    );
    if (result.affectedRows > 0)
      log.info(`Queued a ${mode} job for store ${storeId} (${source})`);
    else
      log.info(
        `Not queueing a ${mode} job for store ${storeId}, it is disabled or already has one`
      );
  }

  // Queues a reindex of everything in the database to Solr, unless one is
  // already queued
  async enqueueIndex(source: ScrapeJobSource, requestedBy: string | null) {
    const result = await this.pool.query<UpsertResult>(
      `INSERT INTO scrapeJobs (storeId, mode, source, status, requestedBy, queuedAt)
       SELECT NULL, 'index', ?, 'queued', ?, UTC_TIMESTAMP() FROM DUAL
       WHERE NOT EXISTS (
         SELECT 1 FROM scrapeJobs WHERE mode = 'index' AND status = 'queued'
       )`,
      [source, requestedBy]
    );
    if (result.affectedRows > 0) log.info(`Queued a Solr reindex (${source})`);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.loadSettings();
      await this.reloadConfigs();
      await this.reportStatus();
      await this.updateRunningJobs();
      await this.pool.query(
        "UPDATE scrapeJobs SET status = 'cancelled', finishedAt = UTC_TIMESTAMP() WHERE status = 'queued' AND cancelRequested = 1"
      );
      await this.claimJobs();
    } catch (e) {
      log.error('Job runner tick failed', e);
    } finally {
      this.ticking = false;
    }
  }

  // Lowering the concurrency lets the running scans finish, new ones wait
  async loadSettings() {
    const [settings] = await this.pool.query<{ concurrency: number }[]>(
      'SELECT concurrency FROM scraperSettings WHERE id = 1'
    );
    const concurrency = Number(settings?.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1) return;
    if (concurrency !== this.concurrency)
      log.info(`Scanning at most ${concurrency} stores at a time`);
    this.concurrency = concurrency;
  }

  // Reloads the store configs as requested in the admin interface, they are
  // not reloaded otherwise. Running jobs keep the config they started with.
  async reloadConfigs() {
    const queued = await this.pool.query<ConfigReload[]>(
      "SELECT id, storeId FROM configReloads WHERE status = 'queued' ORDER BY id"
    );
    if (queued.length === 0) return;
    const reload = async (
      load: () => Promise<ReloadResult>
    ): Promise<ReloadResult | Error> => {
      try {
        return await load();
      } catch (e) {
        log.error('Reloading store configs failed', e);
        return e instanceof Error ? e : new Error(String(e));
      }
    };
    // A reload of every config covers the stores queued with it
    const all = queued.some((row) => row.storeId === null)
      ? await reload(() => this.configLoader.reloadAll())
      : undefined;
    const byStore = new Map<number, ReloadResult | Error>();
    if (!all) {
      for (const { storeId } of queued) {
        if (storeId !== null && !byStore.has(storeId))
          byStore.set(
            storeId,
            await reload(() => this.configLoader.reloadStore(storeId))
          );
      }
    }
    for (const row of queued) {
      const result = all ?? byStore.get(row.storeId!)!;
      const errors =
        result instanceof Error
          ? [result.message]
          : result.errors
              // A store's reload only reports the errors of its file
              .filter(
                (e) => row.storeId === null || e.file === `${row.storeId}.jsonc`
              )
              .map((e) => `${e.file}: ${e.message}`);
      await this.pool.query(
        'UPDATE configReloads SET status = ?, finishedAt = UTC_TIMESTAMP(), configCommit = ?, errorMessage = ? WHERE id = ?',
        [
          errors.length ? 'failed' : 'succeeded',
          result instanceof Error ? null : (result.commit ?? null),
          errors.length ? errors.join('\n') : null,
          row.id
        ]
      );
    }
  }

  async reportStatus() {
    const { source, commit, loadedAt, configs, errors } =
      await this.configLoader.get();
    // The blob sha of each store's config, compared to GitHub in the admin
    // interface to show configs that were saved but not reloaded
    const storeConfigs = Object.fromEntries(
      [...configs].map(([storeId, config]) => [
        storeId,
        {
          sha: config.sha,
          commit: config.commit ?? null,
          loadedAt: config.loadedAt.toISOString()
        }
      ])
    );
    await this.pool.query(
      `INSERT INTO scraperStatus (id, startedAt, lastSeenAt, hostname, concurrency, configSource, configCommit, configLoadedAt, configErrors, storeConfigs)
       VALUES (1, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE startedAt = VALUES(startedAt), lastSeenAt = VALUES(lastSeenAt),
         hostname = VALUES(hostname), concurrency = VALUES(concurrency), configSource = VALUES(configSource),
         configCommit = VALUES(configCommit), configLoadedAt = VALUES(configLoadedAt),
         configErrors = VALUES(configErrors), storeConfigs = VALUES(storeConfigs)`,
      [
        toSqlDateTime(this.startedAt),
        hostname(),
        this.concurrency,
        source,
        commit ?? null,
        toSqlDateTime(loadedAt),
        JSON.stringify(errors),
        JSON.stringify(storeConfigs)
      ]
    );
  }

  // Saves progress and stops jobs that were cancelled in the admin interface
  async updateRunningJobs() {
    if (this.running.size === 0) return;
    for (const [id, { crawler, indexProgress }] of this.running) {
      const result =
        crawler?.result ?? (indexProgress && indexCounters(indexProgress));
      await this.pool.query(
        `UPDATE scrapeJobs SET heartbeatAt = UTC_TIMESTAMP()${result ? ', totalRequests = ?, totalProcessed = ?, totalErrored = ?, pendingRequests = ?' : ''} WHERE id = ?`,
        result
          ? [
              result.totalRequests,
              result.totalProcessed,
              result.totalErrored,
              crawler?.pendingRequests ?? null,
              id
            ]
          : [id]
      );
    }
    const cancelled = await this.pool.query<{ id: number }[]>(
      'SELECT id FROM scrapeJobs WHERE id IN (?) AND cancelRequested = 1',
      [[...this.running.keys()]]
    );
    for (const { id } of cancelled) {
      const entry = this.running.get(id);
      if (entry && !entry.cancelled) {
        log.info(`Cancelling job ${id}`);
        entry.cancelled = true;
        entry.crawler?.stop();
      }
    }
  }

  async claimJobs() {
    const runningJobs = [...this.running.values()].map((entry) => entry.job);
    const busyStoreIds = new Set(runningJobs.map((job) => job.storeId));
    let storeSlots =
      this.concurrency -
      runningJobs.filter((job) => job.mode !== 'test').length;
    let testSlots =
      MAX_RUNNING_TESTS -
      runningJobs.filter((job) => job.mode === 'test').length;
    // One reindex or schema sync at a time, they don't take the slot of a store
    let solrSlots = runningJobs.some((job) => SOLR_MODES.has(job.mode)) ? 0 : 1;
    if (storeSlots <= 0 && testSlots <= 0 && solrSlots <= 0) return;

    const queued = await this.pool.query<ScrapeJob[]>(
      "SELECT id, storeId, mode, source, requestedBy, testUrl, testConfig, options FROM scrapeJobs WHERE status = 'queued' AND cancelRequested = 0 ORDER BY id LIMIT 100"
    );
    for (const job of queued) {
      if (job.mode === 'test') {
        if (testSlots <= 0) continue;
      } else if (SOLR_MODES.has(job.mode)) {
        if (solrSlots <= 0) continue;
      } else if (storeSlots <= 0 || busyStoreIds.has(job.storeId)) continue;

      const claimed = await this.pool.query<UpsertResult>(
        "UPDATE scrapeJobs SET status = 'running', startedAt = UTC_TIMESTAMP(), heartbeatAt = UTC_TIMESTAMP() WHERE id = ? AND status = 'queued'",
        [job.id]
      );
      if (claimed.affectedRows !== 1) continue;
      if (job.mode === 'test') testSlots--;
      else if (SOLR_MODES.has(job.mode)) solrSlots--;
      else {
        storeSlots--;
        busyStoreIds.add(job.storeId);
      }
      this.running.set(job.id, { job, cancelled: false });
      void this.runJob(job);
    }
  }

  async runJob(job: ScrapeJob) {
    const entry = this.running.get(job.id);
    if (!entry) return;
    let status = 'succeeded';
    let result: JobResult = {};
    let commit: string | undefined;
    try {
      const configs = await this.configLoader.get();
      // A store's config can be reloaded on its own, so its commit can differ
      // from the one of the last reload of every config
      commit =
        job.storeId !== null && job.mode !== 'test'
          ? configs.configs.get(Number(job.storeId))?.commit
          : configs.commit;
      if (job.mode === 'test') result = await this.runTest(job, entry);
      else if (job.mode === 'index') result = await this.runIndex(entry);
      else if (job.mode === 'schema') result = await this.runSchemaSync(job);
      else result = await this.runStoreJob(job, configs.configs, entry);
      if (result.failed) status = 'failed';
      // A schema sync doesn't stop when it is cancelled, it finished
      else if (entry.cancelled && job.mode !== 'schema') status = 'cancelled';
    } catch (e) {
      log.error(`Job ${job.id} failed`, e);
      status = 'failed';
      result.errorMessage = errorMessage(e);
    }
    try {
      const scrape: Partial<ScrapeResult> | undefined =
        result.scrapeResult ??
        entry.crawler?.result ??
        (entry.indexProgress && indexCounters(entry.indexProgress));
      await this.pool.query(
        `UPDATE scrapeJobs SET status = ?, finishedAt = UTC_TIMESTAMP(), heartbeatAt = UTC_TIMESTAMP(), configCommit = ?,
           totalRequests = ?, totalProcessed = ?, totalErrored = ?, descriptionError = ?, attributeError = ?,
           imageError = ?, brandError = ?, nameError = ?, inStockError = ?, categoriesError = ?,
           pendingRequests = ?, updateResult = ?, testResult = ?, errorMessage = ?
         WHERE id = ?`,
        [
          status,
          commit ?? null,
          scrape?.totalRequests ?? 0,
          scrape?.totalProcessed ?? 0,
          scrape?.totalErrored ?? 0,
          scrape?.descriptionError ?? 0,
          scrape?.attributeError ?? 0,
          scrape?.imageError ?? 0,
          scrape?.brandError ?? 0,
          scrape?.nameError ?? 0,
          scrape?.inStockError ?? 0,
          scrape?.categoriesError ?? 0,
          // What a cancelled or failed scan didn't get to
          entry.crawler?.pendingRequests ?? null,
          result.updateResult ? JSON.stringify(result.updateResult) : null,
          result.testResult ? JSON.stringify(result.testResult) : null,
          result.errorMessage ?? null,
          job.id
        ]
      );
    } catch (e) {
      log.error(`Saving the result of job ${job.id} failed`, e);
    } finally {
      this.running.delete(job.id);
    }
  }

  async runStoreJob(
    job: ScrapeJob,
    configs: Map<number, LoadedConfig>,
    entry: RunningJob
  ): Promise<JobResult> {
    const [store] = await this.pool.query<Store[]>(
      'SELECT * FROM stores WHERE id = ?',
      [job.storeId]
    );
    if (!store) throw new Error(`Store ${job.storeId} not found`);
    const options = configs.get(Number(store.id))?.options;
    if (!options) throw new Error(`No config found for store ${store.name}`);

    let urlList: string[] | undefined;
    if (job.mode === 'list') {
      // Products whose price was seen in the last scan of the store
      const products = await this.pool.query<{ url: string }[]>(
        'SELECT url FROM products JOIN prices ON products.id = prices.productId JOIN stores ON products.storeId = stores.id WHERE products.storeId = ? AND prices.end = stores.lastScanDate AND products.url IS NOT NULL',
        [store.id]
      );
      if (products.length === 0)
        return { errorMessage: 'No active products to scrape' };
      urlList = products.map((product) => options.startUrl + product.url);
      log.info(`Scraping ${urlList.length} products for store ${store.name}`);
    } else {
      log.info(`Crawling store ${store.name}`);
    }

    const result = await this.updateStore(store, options, entry, urlList);
    reportResults(result.updateResult, store.name);
    return result;
  }

  createCrawler(
    store: StoreConfig,
    jobId: number,
    updateProductInDb: (product: ProductSnapshot) => Promise<void>,
    requestQueue?: RequestQueue,
    requestList?: RequestList
  ): BaseCrawler {
    if (store.options.type === 'crawler')
      return new WebshopCrawler(
        store,
        jobId,
        updateProductInDb,
        requestQueue,
        requestList
      );
    if (store.options.type === 'httpcrawler')
      return new WebshopHtmlCrawler(
        store,
        jobId,
        updateProductInDb,
        requestQueue,
        requestList
      );
    throw new Error('Type not supported for store ' + store.name);
  }

  async updateStore(
    store: Store,
    options: WebshopCrawlerOptions,
    entry: RunningJob,
    urlList?: string[]
  ): Promise<{ scrapeResult: ScrapeResult; updateResult: StoreUpdateResult }> {
    const currentDate = new Date();
    currentDate.setHours(0, 0, 0, 0);
    const safeStoreName = store.name.replace(/[^a-zA-Z0-9]/g, '-');
    const storeConfig: StoreConfig = {
      options: options,
      safeStoreName: safeStoreName,
      ...store
    };
    const storeUpdater = new SQLStoreUpdater(
      storeConfig,
      currentDate,
      this.attributesPool,
      this.categoriesPool,
      this.manufacturersPool
    );
    const memoryStorage = new MemoryStorage({
      persistStorage: false,
      writeMetadata: false
    });
    const requestQueue = urlList
      ? undefined
      : await RequestQueue.open(safeStoreName, {
          storageClient: memoryStorage
        });
    const requestList = urlList
      ? await RequestList.open(safeStoreName, urlList)
      : undefined;
    const crawler = this.createCrawler(
      storeConfig,
      entry.job.id,
      (scrapedProduct) => storeUpdater.updateProductInDb(scrapedProduct),
      requestQueue,
      requestList
    );
    entry.crawler = crawler;
    try {
      await crawler.crawlSite();
    } finally {
      // Also when the crawl throws, e.g. on an unreadable product feed
      await requestQueue?.drop();
      await memoryStorage.teardown();
      await storeUpdater.close();
    }
    // Products not reached by a cancelled scan would look inactive
    if (!entry.cancelled) {
      await this.pool.query('UPDATE stores SET lastScanDate = ? WHERE id = ?', [
        currentDate,
        store.id
      ]);
    }
    return { scrapeResult: crawler.result, updateResult: storeUpdater.result };
  }

  // Indexes everything in the database to Solr, queued from the admin interface
  async runIndex(entry: RunningJob): Promise<JobResult> {
    log.info(`Reindexing Solr, job ${entry.job.id}`);
    const indexed = await indexEverything({
      onProgress: (progress) => {
        entry.indexProgress = progress;
      },
      isCancelled: () => entry.cancelled
    });
    return { updateResult: { ...indexed } };
  }

  // Syncs the Solr schemas with solr-configsets, queued from the admin
  // interface. It is quick, so it doesn't stop when it is cancelled.
  async runSchemaSync(job: ScrapeJob): Promise<JobResult> {
    log.info(`Syncing the Solr schemas, job ${job.id}`);
    const { changes, failed } = await syncSolrSchemas();
    const changed = Object.values(changes).some((count) => count > 0);
    if (changed && parseOptions(job).reindex)
      await this.enqueueIndex(job.source, job.requestedBy);
    return {
      // Changes made to the schema of each core
      updateResult: changes,
      failed: failed.length > 0,
      errorMessage: failed.length
        ? failed.map(({ core, error }) => `${core}: ${error}`).join('\n')
        : undefined
    };
  }

  // Scrapes a single url with a draft config, nothing is written to the database
  async runTest(job: ScrapeJob, entry: RunningJob): Promise<JobResult> {
    if (!job.testUrl) throw new Error('testUrl is missing');
    const options = (
      typeof job.testConfig === 'string'
        ? JSON.parse(job.testConfig)
        : job.testConfig
    ) as WebshopCrawlerOptions;
    const invalid = validateStoreConfig(options, Number(options?.storeId));
    if (invalid) throw new Error(`Invalid config: ${invalid}`);

    const currentDate = new Date();
    const store: StoreConfig = {
      id: job.storeId ?? 0,
      name: `test-${job.id}`,
      createdDate: currentDate,
      lastScanDate: currentDate,
      scraperEnabled: false,
      apiEnabled: false,
      options,
      safeStoreName: `test-${job.id}`
    };
    const testResult: TestResult = {};
    const requestList = await RequestList.open(null, [job.testUrl]);
    const crawler = this.createCrawler(
      store,
      job.id,
      () => Promise.resolve(),
      undefined,
      requestList
    );
    crawler.pageListener = {
      onProductScraped: ({ product, errors }) => {
        testResult.isProductPage = true;
        testResult.product = product;
        testResult.fieldErrors = {};
        for (const [field, error] of Object.entries(errors)) {
          if (error)
            testResult.fieldErrors[field as keyof ProductScrapeErrors] =
              errorMessage(error);
        }
      },
      onProductError: (error) => {
        testResult.isProductPage = true;
        testResult.error = errorMessage(error);
      },
      onNotProductPage: () => {
        testResult.isProductPage = false;
      },
      onRequestFailed: (errorMessages) => {
        testResult.error = errorMessages.join('\n');
      }
    };
    entry.crawler = crawler;
    await crawler.crawlSite();
    return { scrapeResult: crawler.result, testResult };
  }
}
