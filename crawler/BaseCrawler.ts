import {
  CheerioCrawler,
  CheerioCrawlerOptions,
  Log,
  PlaywrightCrawler,
  PlaywrightCrawlerOptions,
  RequestList,
  RequestQueue
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

  constructor(
    store: StoreConfig,
    jobId: number,
    updateProductInDb: (scrapedProduct: ProductSnapshot) => Promise<void>,
    requestQueue?: RequestQueue,
    requestList?: RequestList
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
    this.crawler = this.setupCrawler(
      this.getConfiguration(requestQueue, requestList)
    );
    this.hostname = new URL(this.store.options.startUrl).hostname;
    this.hostnameIncludesWww = this.hostname.startsWith('www.');
    this.mode = requestList !== undefined ? 'list' : 'crawler';
  }

  async handleProductScrapeResult(
    logger: Logger,
    scrapeResult: ProductScrapeResult
  ) {
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
    await this.updateProductInDb(scrapeResult.product);
    this.result.totalProcessed++;
  }

  handleProductScrapeError(logger: Logger, e: unknown, url?: string) {
    logger.log('error', 'Error processing product from url %s', url);
    logger.log('error', '%O', e);
    this.result.totalErrored++;
    this.pageListener?.onProductError(e);
  }

  handleNotProductPage(logger: Logger, url?: string) {
    logger.log('info', 'url is not a product page: %s', url);
    this.pageListener?.onNotProductPage();
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

    // Finally, we have to add the URLs to the queue
    await this.crawler?.addRequests(filteredUrls.map((url) => url.href));
  }

  getConfiguration(
    requestQueue?: RequestQueue,
    requestList?: RequestList
  ): CheerioCrawlerOptions | PlaywrightCrawlerOptions {
    const crawlLog = new Log({ prefix: this.store.name });

    // const config = Configuration.getGlobalConfig();

    // config.set('persistStorage', 'false');
    // config.set('storageDir', '/dev/shm');

    const configuration: CheerioCrawlerOptions | PlaywrightCrawlerOptions = {
      requestList: requestList,
      requestQueue: requestQueue,
      statisticsOptions: {
        logIntervalSecs: 600 // 10 minutes
      },

      sessionPoolOptions: {
        persistStateKeyValueStoreId: `${this.store.safeStoreName}-keyvalue`,
        persistStateKey: `${this.store.safeStoreName}-session-pool`
      },
      // maxRequestsPerCrawl: 30000,
      maxConcurrency: 50,
      maxRequestsPerMinute: 30,
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
    const { startUrl, productFeed } = this.store.options;
    const storeLogger = createLogger('Scan log', this.store.name, this.jobId);

    // In list mode only the urls in the request list are scraped
    const startUrls =
      this.mode === 'crawler'
        ? [
            startUrl,
            ...(this.store.options.startUrls ?? []),
            ...(this.store.options.sitemapUrls ?? [])
          ]
        : [];
    if (this.mode === 'crawler' && productFeed) {
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
    await this.crawler.run(startUrls);

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

    return;
  }
  abstract setupCrawler(
    configuration: CheerioCrawlerOptions | PlaywrightCrawlerOptions
  ): CheerioCrawler | PlaywrightCrawler;
}
