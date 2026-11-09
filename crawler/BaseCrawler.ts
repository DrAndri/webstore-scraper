import {
  CheerioCrawler,
  CheerioCrawlerOptions,
  Configuration,
  Log,
  MemoryStorage,
  PlaywrightCrawler,
  PlaywrightCrawlerOptions
} from 'crawlee';
import {
  PageListener,
  ProductScrapeResult,
  ProductSnapshot,
  ScrapeResult,
  StoreConfig
} from '../types/index.js';
import { createLogger } from '../logger.js';
import { Logger } from 'winston';
import {
  absoluteUrlRegExp,
  blockedNavigationPathEndings
} from './constants.js';
import { fetchProductFeedUrls } from './ProductFeed.js';

// Pages requested a minute when the config does not set maxRequestsPerMinute
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;

export default abstract class BaseCrawler {
  store: StoreConfig;
  // The scrapeJobs row the crawl runs for, labels its log
  jobId: number;
  updateProductInDb: (scrapedProduct: ProductSnapshot) => Promise<void>;
  result: ScrapeResult;
  crawler: CheerioCrawler | PlaywrightCrawler;
  hostname: string;
  hostnameIncludesWww: boolean;
  mode: 'list' | 'crawler';
  pageListener?: PageListener;
  // Skus of the products handled in this crawl
  scrapedSkus = new Set<string>();
  // The urls a list scan or a test scrapes, nothing else is crawled
  urlList?: string[];
  // Each crawl has its own crawlee storage and configuration, so its request
  // queue, key-value stores and events are never shared with another crawl.
  // Crawlee caches storages by name in a configuration, and opens a default
  // queue in it when a crawler has none, the global one is shared by every
  // crawler in the process.
  storage: MemoryStorage;
  crawleeConfig: Configuration;

  constructor(
    store: StoreConfig,
    jobId: number,
    updateProductInDb: (scrapedProduct: ProductSnapshot) => Promise<void>,
    urlList?: string[]
  ) {
    this.store = store;
    this.jobId = jobId;
    this.updateProductInDb = updateProductInDb;
    this.result = {
      totalRequests: 0,
      totalProcessed: 0,
      totalErrored: 0,
      descriptionError: 0,
      attributeError: 0,
      imageError: 0,
      brandError: 0,
      nameError: 0,
      inStockError: 0,
      categoriesError: 0
    };
    this.urlList = urlList;
    this.mode = urlList !== undefined ? 'list' : 'crawler';
    this.storage = new MemoryStorage({
      persistStorage: false,
      writeMetadata: false
    });
    this.crawleeConfig = new Configuration({
      storageClient: this.storage,
      persistStorage: false
    });
    this.crawler = this.setupCrawler(this.getConfiguration());
    this.hostname = new URL(this.store.options.startUrl).hostname;
    this.hostnameIncludesWww = this.hostname.startsWith('www.');
  }

  async handleProductScrapeResult(
    logger: Logger,
    scrapeResult: ProductScrapeResult
  ) {
    // A product can be reached from several urls, it is only updated and
    // counted the first time. Claimed before the first await, the handlers
    // run concurrently.
    const { sku } = scrapeResult.product;
    if (this.scrapedSkus.has(sku)) {
      logger.log('debug', 'Product %s already scraped in this crawl', sku);
      return;
    }
    this.scrapedSkus.add(sku);

    const errors = scrapeResult.errors;
    if (errors.description) {
      logger.log('warn', 'Error scraping description: %O', errors.description);
      this.result.descriptionError++;
    }
    if (errors.attributes) {
      logger.log('warn', 'Error scraping attributes: %O', errors.attributes);
      this.result.attributeError++;
    }
    if (errors.image) {
      logger.log('warn', 'Error scraping image: %O', errors.image);
      this.result.imageError++;
    }
    if (errors.brand) {
      logger.log('warn', 'Error scraping brand: %O', errors.brand);
      this.result.brandError++;
    }
    if (errors.name) {
      logger.log('warn', 'Error scraping name: %O', errors.name);
      this.result.nameError++;
    }
    if (errors.inStock) {
      logger.log('warn', 'Error scraping inStock: %O', errors.inStock);
      this.result.inStockError++;
    }
    if (errors.categories) {
      logger.log('warn', 'Error scraping categories: %O', errors.categories);
      this.result.categoriesError++;
    }

    this.pageListener?.onProductScraped(scrapeResult);
    try {
      await this.updateProductInDb(scrapeResult.product);
    } catch (e) {
      // Let another url of the product try again
      this.scrapedSkus.delete(sku);
      throw e;
    }
    this.result.totalProcessed++;
  }

  handleProductScrapeError(logger: Logger, e: unknown) {
    logger.log('error', 'Error processing product');
    logger.log('error', '%O', e);
    this.result.totalErrored++;
    this.pageListener?.onProductError(e);
  }

  handleNotProductPage(logger: Logger) {
    logger.log('info', 'Not a product page');
    this.pageListener?.onNotProductPage();
  }

  // Requests in the queue not handled yet, including the ones in progress.
  // Crawlee's in-memory estimate.
  get pendingRequests(): number {
    return this.crawler.requestQueue?.getPendingCount() ?? 0;
  }

  // Finishes the requests in progress and skips the rest
  stop() {
    this.crawler.stop();
  }

  isUrlLocal(url: URL): boolean {
    // We use the hostname to filter links that point
    // to a different domain, even subdomain.
    return (
      url.hostname === this.hostname ||
      (this.hostnameIncludesWww
        ? 'www.' + url.hostname === this.hostname
        : url.hostname === 'www.' + this.hostname)
    );
  }

  anyMatchInUrl(checkList: string[], url: URL): boolean {
    return checkList.some((entry) => {
      return url.pathname.startsWith(entry);
    });
  }

  async filterAndAddLinksToQueue(links: string[]) {
    const startUrl = this.store.options.startUrl;
    const urlWhitelist = this.store.options.urlWhitelist;
    const urlBlacklist = this.store.options.urlBlacklist;

    const absoluteUrls = links.map((link) => {
      if (absoluteUrlRegExp.test(link)) return URL.parse(link);
      else return new URL(link, startUrl);
    });

    let filteredUrls = absoluteUrls
      .filter((url) => url !== null)
      .filter((url) => this.isUrlLocal(url))
      .filter(
        (url) =>
          !blockedNavigationPathEndings.find((ending) =>
            url.href.endsWith(ending)
          )
      );
    // Filter out urls that do not match whitelist or match blacklist
    if (urlWhitelist !== undefined && urlWhitelist.length > 0) {
      filteredUrls = filteredUrls.filter((url) =>
        this.anyMatchInUrl(urlWhitelist, url)
      );
    }

    if (urlBlacklist !== undefined && urlBlacklist.length > 0) {
      filteredUrls = filteredUrls.filter(
        (url) => !this.anyMatchInUrl(urlBlacklist, url)
      );
    }

    const keepQueryParams = this.store.options.keepQueryParams;
    if (keepQueryParams !== undefined) {
      filteredUrls = filteredUrls.map((url) =>
        this.keepOnlyQueryParams(url, keepQueryParams)
      );
    }

    // Links that differed only in removed parameters are now the same
    const hrefs = [...new Set(filteredUrls.map((url) => url.href))];
    // Finally, we have to add the URLs to the queue
    await this.crawler?.addRequests(hrefs);
  }

  keepOnlyQueryParams(url: URL, keep: string[]): URL {
    // Rewriting the query re-encodes it, e.g. %20 as +, so a url with nothing
    // to remove is left as it is
    if ([...url.searchParams.keys()].every((name) => keep.includes(name)))
      return url;
    const result = new URL(url);
    for (const name of [...result.searchParams.keys()]) {
      if (!keep.includes(name)) result.searchParams.delete(name);
    }
    // Leaves no dangling "?" when every parameter is removed
    if (result.searchParams.size === 0) result.search = '';
    return result;
  }

  // The crawler opens its request queue in crawleeConfig, the crawl's own
  // storage, the first time urls are added to it
  getConfiguration(): CheerioCrawlerOptions | PlaywrightCrawlerOptions {
    const crawlLog = new Log({ prefix: this.store.name });

    const configuration: CheerioCrawlerOptions | PlaywrightCrawlerOptions = {
      statisticsOptions: {
        logIntervalSecs: 600 // 10 minutes
      },

      sessionPoolOptions: {
        persistStateKeyValueStoreId: `${this.store.safeStoreName}-keyvalue`,
        persistStateKey: `${this.store.safeStoreName}-session-pool`
      },
      // maxRequestsPerCrawl: 30000,
      maxConcurrency: 50,
      maxRequestsPerMinute:
        this.store.options.maxRequestsPerMinute ??
        DEFAULT_MAX_REQUESTS_PER_MINUTE,
      maxRequestRetries: 3,
      requestHandlerTimeoutSecs: 240,
      navigationTimeoutSecs: 120,
      respectRobotsTxtFile: false,
      retryOnBlocked: true,
      autoscaledPoolOptions: {
        loggingIntervalSecs: 600,
        snapshotterOptions: {
          clientSnapshotIntervalSecs: 30,
          eventLoopSnapshotIntervalSecs: 30,
          maxBlockedMillis: 50
        }
      },
      log: crawlLog
    };
    return configuration;
  }

  async crawlSite(): Promise<void> {
    const storeLogger = createLogger('Scan log', this.store, this.jobId);
    try {
      await this.crawler.run(await this.getStartUrls(storeLogger));
    } finally {
      // Also when the crawl throws, e.g. on an unreadable product feed
      await this.crawler.requestQueue?.drop();
      await this.storage.teardown();
    }
    this.logResult(storeLogger);
  }

  async getStartUrls(storeLogger: Logger): Promise<string[]> {
    // In list mode only the urls in the list are scraped
    if (this.urlList !== undefined) return [...this.urlList];

    const { startUrl, productFeed } = this.store.options;
    const startUrls = [
      startUrl,
      ...(this.store.options.startUrls ?? []),
      ...(this.store.options.sitemapUrls ?? [])
    ];
    if (productFeed) {
      try {
        const feedUrls = await fetchProductFeedUrls(productFeed, startUrl);
        storeLogger.log(
          'info',
          `Product feed ${productFeed.url} has ${feedUrls.length} products`
        );
        startUrls.push(...feedUrls);
      } catch (e) {
        // Fail the scan, without the feed it would miss most of the products
        storeLogger.log('error', 'Error reading the product feed: %O', e);
        throw e;
      }
    }
    return startUrls;
  }

  logResult(storeLogger: Logger) {
    storeLogger.log('info', `Crawl of store ${this.store.name} completed.`);
    storeLogger.log('info', `Total requests: ${this.result.totalRequests}`);
    storeLogger.log('info', `Total processed: ${this.result.totalProcessed}`);
    storeLogger.log('info', `Total errored: ${this.result.totalErrored}`);
    storeLogger.log(
      'info',
      `Description errors: ${this.result.descriptionError}`
    );
    storeLogger.log('info', `Attribute errors: ${this.result.attributeError}`);
    storeLogger.log('info', `Image errors: ${this.result.imageError}`);
    storeLogger.log('info', `Brand errors: ${this.result.brandError}`);
    storeLogger.log('info', `Name errors: ${this.result.nameError}`);
    storeLogger.log('info', `InStock errors: ${this.result.inStockError}`);
    storeLogger.log(
      'info',
      `Categories errors: ${this.result.categoriesError}`
    );
  }
  abstract setupCrawler(
    configuration: CheerioCrawlerOptions | PlaywrightCrawlerOptions
  ): CheerioCrawler | PlaywrightCrawler;
}
