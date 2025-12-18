import { Log, PlaywrightCrawler, RequestQueue, type Request } from 'crawlee';
import {
  ProductSnapshot,
  StoreConfig,
  WebshopCrawlerOptions
} from '../types/index.js';
import { createProductLogger, createStoreLogger } from '../logger.js';
import PageScraper from './PageScraper.js';
import { Page } from 'playwright';
const absoluteUrlRegExp = new RegExp('^(?:[a-z+]+:)?//', 'i');
const categoryBanList = [
  'forsíða',
  'heim',
  'vörur',
  'allar vörur',
  'til baka',
  'leitarniðurstöður'
];
const blockedResourceTypes = [
  'image',
  'stylesheet',
  'media',
  'font',
  'websocket'
];
const badPathEndings = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];

export default class WebshopCrawler {
  store: StoreConfig;
  batchTimestamp: number;
  constructor(store: StoreConfig, batchTimestamp: number) {
    this.store = store;
    this.batchTimestamp = batchTimestamp;
  }

  async crawlSite(): Promise<ProductSnapshot[]> {
    const {
      startUrl,
      selectors,
      productPageIdentifier,
      sanitizers,
      urlWhitelist,
      urlBlacklist
    } = this.store.options as WebshopCrawlerOptions;
    const store = this.store;
    const batchTimestamp = this.batchTimestamp;

    let totalRequests = 0,
      totalProcessed = 0,
      totalErrored = 0,
      descriptionError = 0,
      attributeError = 0,
      imageError = 0,
      brandError = 0,
      nameError = 0,
      inStockError = 0,
      categoriesError = 0;

    const productMap: Map<string, ProductSnapshot> = new Map<
      string,
      ProductSnapshot
    >();

    const requestQueue = await RequestQueue.open(this.store.name);

    const pageScraper = new PageScraper(
      selectors,
      sanitizers,
      categoryBanList,
      batchTimestamp
    );

    const requestHandler = async ({
      request,
      page
    }: {
      request: Request;
      page: Page;
    }) => {
      await page.route('**/*', (route) => {
        if (
          blockedResourceTypes.some(
            (blocked) => route.request().resourceType() === blocked
          )
        ) {
          return route.fulfill();
        } else {
          return route.continue();
        }
      });
      totalRequests++;
      await page.waitForLoadState('load');
      await page
        .waitForLoadState('networkidle', { timeout: 10000 })
        .catch(() => {
          /* wait for 10 seconds or until network is idle */
        });

      const productLocator = page.locator(selectors.productPage);
      const count = await productLocator.count();
      const pageContent = await page.content();

      const urlParts = request.loadedUrl?.split('/') ?? [];
      const label = urlParts[urlParts.length - 1].trim()
        ? urlParts[urlParts.length - 1].trim()
        : urlParts[urlParts.length - 2].trim();
      const logger = createProductLogger(label, store.name, batchTimestamp);

      if (count > 0 && pageContent.includes(productPageIdentifier)) {
        logger.log('info', 'processing url: %s', request.loadedUrl);
        try {
          const scrapeResult = await pageScraper.scrapeProductPage(
            productLocator,
            logger
          );

          if (scrapeResult !== undefined) {
            const scrapedProduct = scrapeResult.product;
            productMap.set(scrapedProduct.sku, scrapedProduct);
            if (scrapeResult.errors.description) descriptionError++;
            if (scrapeResult.errors.attributes) attributeError++;
            if (scrapeResult.errors.image) imageError++;
            if (scrapeResult.errors.brand) brandError++;
            if (scrapeResult.errors.name) nameError++;
            if (scrapeResult.errors.inStock) inStockError++;
            if (scrapeResult.errors.categories) categoriesError++;
            totalProcessed++;
          }
        } catch (e) {
          logger.log(
            'error',
            'Error processing product from url %s',
            request.loadedUrl
          );
          logger.log('error', '%O', e);
          totalErrored++;
        }
      } else {
        logger.log('info', 'url is not a product page: %s', request.loadedUrl);
      }

      logger.close();

      await addLinksToQueue(page);
    };

    const addLinksToQueue = async (page: Page) => {
      const links = await page
        .getByRole('link')
        .all()
        .then((links) =>
          Promise.all(
            links.map(async (locator) => await locator.getAttribute('href'))
          )
        )
        .then((links) => links.filter((link) => link !== null));

      // Besides resolving the URLs, we now also need to
      // grab their hostname for filtering.
      const { hostname } = new URL(startUrl);
      const hostnameIncludesWww = hostname.startsWith('www.');
      const absoluteUrls = links.map((link) => {
        if (absoluteUrlRegExp.test(link)) return URL.parse(link);
        else return new URL(link, startUrl);
      });

      // Filter out urls that do not match whitelist or match blacklist
      let filteredUrls = absoluteUrls.filter((url) => url !== null);
      if (urlWhitelist !== undefined && urlWhitelist.length > 0) {
        filteredUrls = filteredUrls.filter((url) => {
          return urlWhitelist.some((whitelistEntry) => {
            return url.href.includes(whitelistEntry);
          });
        });
      }

      if (urlBlacklist !== undefined && urlBlacklist.length > 0) {
        filteredUrls = filteredUrls.filter((url) => {
          return !urlBlacklist.some((blacklistEntry) => {
            return url.href.includes(blacklistEntry);
          });
        });
      }

      // We use the hostname to filter links that point
      // to a different domain, even subdomain.
      const sameHostnameLinks = filteredUrls
        .filter(
          (url) =>
            url.hostname === hostname ||
            (hostnameIncludesWww
              ? 'www.' + url.hostname === hostname
              : url.hostname === 'www.' + hostname)
        )
        .map((url) => url.href);

      // Finally, we have to add the URLs to the queue
      await crawler.addRequests(
        sameHostnameLinks.filter(
          (url) => !badPathEndings.find((ending) => url.endsWith(ending))
        )
      );
    };

    const crawlLog = new Log({ prefix: store.name });

    const crawler = new PlaywrightCrawler({
      failedRequestHandler({ request, log }) {
        log.info(`Request ${request.url} failed too many times.`);
      },
      // Default is to reuse requestQueue from all crawl instances
      requestQueue: requestQueue,
      statisticsOptions: {
        logIntervalSecs: 1800 // 30 minutes
      },
      sessionPoolOptions: {
        persistStateKey: `${store.name.replace(/[^a-zA-Z0-9!-_.'()]/g, '-')}-session-pool`
      },
      maxRequestsPerCrawl: 5000,
      maxRequestsPerMinute: 20,
      maxRequestRetries: 3,
      requestHandlerTimeoutSecs: 10000,
      respectRobotsTxtFile: false,
      retryOnBlocked: true,
      requestHandler: requestHandler,
      autoscaledPoolOptions: { loggingIntervalSecs: 1800 },
      log: crawlLog,
      headless: true,
      launchContext: {
        launchOptions: {
          headless: true
        }
      }
    });

    // Run the crawler with initial request
    await crawler.run([startUrl]);

    await requestQueue.drop();

    const storeLogger = createStoreLogger(store.name);

    storeLogger.log('info', `Crawl of store ${store.name} completed.`);
    storeLogger.log('info', `Total requests: ${totalRequests}`);
    storeLogger.log('info', `Total processed: ${totalProcessed}`);
    storeLogger.log('info', `Total errored: ${totalErrored}`);
    storeLogger.log('info', `Description errors: ${descriptionError}`);
    storeLogger.log('info', `Attribute errors: ${attributeError}`);
    storeLogger.log('info', `Image errors: ${imageError}`);
    storeLogger.log('info', `Brand errors: ${brandError}`);
    storeLogger.log('info', `Name errors: ${nameError}`);
    storeLogger.log('info', `InStock errors: ${inStockError}`);
    storeLogger.log('info', `Categories errors: ${categoriesError}`);
    storeLogger.close();

    return Array.from(productMap, ([, value]) => value);
  }
}
