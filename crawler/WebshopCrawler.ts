import {
  Log,
  PlaywrightCrawler,
  PlaywrightCrawlingContext,
  PlaywrightGotoOptions,
  RequestQueue,
  type Request
} from 'crawlee';
import {
  CacheItems,
  ProductSnapshot,
  StoreConfig,
  WebshopCrawlerOptions
} from '../types/index.js';
import { createProductLogger, createStoreLogger } from '../logger.js';
import PageScraper from './PageScraper.js';
import { Locator, Page } from 'playwright';

const defaultImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAAXNSR0IB2cksfwAAAARnQU1BAACxjwv8YQUAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAAxJREFUCNdj+P//PwAF/gL+3MxZ5wAAAABJRU5ErkJggg==',
  'base64'
);
const absoluteUrlRegExp = new RegExp('^(?:[a-z+]+:)?//', 'i');
const categoryBanList = [
  'forsíða',
  'heim',
  'vörur',
  'allar vörur',
  'til baka',
  'leitarniðurstöður'
];
const blockedPageResourceTypes = [
  'image',
  'stylesheet',
  'media',
  'font',
  'websocket',
  'other'
];
const blockedNavigationPathEndings = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.svg',
  '.webp',
  '.mp3',
  '.mp4',
  '.zip',
  '.xlsx',
  '.xls'
];
const blockedUrlPatterns = [
  'google-analytics.com',
  'google.com',
  'google.is',
  'googleads.g.doubleclick.net',
  'googletagmanager.com',
  'adsbygoogle.js',
  'hubspot.com',
  'hubapi.com',
  'hsappstatic.net',
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'addthis.com'
];
const blockedPagePathEndings = [
  ...blockedNavigationPathEndings,
  '.css',
  '.gif',
  '.webm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf'
];

export default class WebshopCrawler {
  store: StoreConfig;
  batchTimestamp: number;
  constructor(store: StoreConfig, batchTimestamp: number) {
    this.store = store;
    this.batchTimestamp = batchTimestamp;
  }

  async crawlSite(): Promise<ProductSnapshot[]> {
    const cache: CacheItems = {};
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

    const once = function (
      checkFn: () => Promise<false | Locator>,
      opts: { timeout?: number; interval?: number; timeoutMsg?: string }
    ): Promise<false | Locator> {
      return new Promise((resolve) => {
        const startTime = new Date().getTime();
        const timeout = opts.timeout ?? 10000;
        const interval = opts.interval ?? 100;

        const poll = function () {
          checkFn()
            .then((ready) => {
              if (ready) {
                resolve(ready);
              } else if (new Date().getTime() - startTime > timeout) {
                resolve(false);
              } else {
                setTimeout(poll, interval);
              }
            })
            .catch((e) => console.log(e));
        };

        void poll();
      });
    };

    const requestHandler = async ({
      request,
      page
    }: {
      request: Request;
      page: Page;
    }) => {
      totalRequests++;
      await page.waitForLoadState('load');
      // await page
      //   .waitForLoadState('networkidle', { timeout: 30000 })
      //   .catch(() => {
      //     /* wait for 30 seconds or until network is idle */
      //   });
      const productLocator = await once(
        async () => {
          const productLocator = page.locator(selectors.productPage);
          const count = await productLocator.count();
          if (count > 0) {
            const pageContent = await page.content();
            // eslint-disable-next-line @typescript-eslint/prefer-includes
            if (pageContent.indexOf(productPageIdentifier) > -1) {
              return productLocator;
            }
          }
          return false;
        },
        {
          interval: 2000,
          timeout: 30000
        }
      );

      // const urlParts = request.loadedUrl?.split('/') ?? [];
      // const label = urlParts[urlParts.length - 1].trim()
      //   ? urlParts[urlParts.length - 1].trim()
      //   : urlParts[urlParts.length - 2].trim();
      const logger = createProductLogger(
        request.loadedUrl ?? 'default label',
        store.name,
        batchTimestamp
      );

      if (productLocator) {
        //TODO: check if productLocator matches multiple elements
        logger.log('debug', 'processing url: %s', request.loadedUrl);
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
            links.map(
              async (locator) =>
                await locator.getAttribute('href').catch(() => null)
            )
          )
        )
        .then((links) => links.filter((link) => link !== null));

      const { hostname } = new URL(startUrl);
      const hostnameIncludesWww = hostname.startsWith('www.');
      const absoluteUrls = links.map((link) => {
        if (absoluteUrlRegExp.test(link)) return URL.parse(link);
        else return new URL(link, startUrl);
      });

      // Filter out urls that do not match whitelist or match blacklist
      //TODO: remove or implement per site filter lists
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
          (url) =>
            !blockedNavigationPathEndings.find((ending) => url.endsWith(ending))
        )
      );
    };

    const myHook = async (
      crawlingContext: PlaywrightCrawlingContext,
      gotoOptions: PlaywrightGotoOptions
    ) => {
      const { page } = crawlingContext;
      gotoOptions.waitUntil = 'load';
      // page.on('console', (msg) => {
      //   const msgType = msg.type();
      //   crawlLog.info(`Console ${msgType} on ${page.url()}: ${msg.text()}`);
      // });
      await page.route('**/*', async (route) => {
        if (route.request().resourceType() === 'image') {
          return await route.fulfill({
            status: 200,
            contentType: 'image/png',
            body: defaultImage
          });
        }
        if (
          blockedPageResourceTypes.some(
            (blocked) => route.request().resourceType() === blocked
          ) ||
          blockedPagePathEndings.some((ending) =>
            route.request().url().endsWith(ending)
          ) ||
          blockedUrlPatterns.some((pattern) =>
            route.request().url().includes(pattern)
          )
        ) {
          return await route.fulfill({ status: 200 });
        } else if (
          route.request().resourceType() === 'script' ||
          route.request().url().endsWith('.js')
        ) {
          const cachedResponse = cache[route.request().url()];
          if (cachedResponse && cachedResponse.expires > Date.now()) {
            return await route.fulfill({
              status: cachedResponse.status,
              headers: cachedResponse.headers,
              body: cachedResponse.body
            });
          } else {
            try {
              const response = await route.fetch();
              const body = await response.body();
              const url = response.url();
              const status = response.status();
              const headers = response.headers();
              const cacheControl = headers['cache-control'] || '';
              const maxAgeMatch = /max-age=(\d+)/.exec(cacheControl);
              const maxAge =
                maxAgeMatch && maxAgeMatch.length > 1
                  ? parseInt(maxAgeMatch[1])
                  : 900;
              cache[url] = {
                status: status,
                headers: headers,
                body: body,
                expires: Date.now() + maxAge * 1000
              };
              return await route.fulfill({
                status: status,
                headers: headers,
                body: body
              });
            } catch {
              crawlLog.error(
                `Failed to cache script: ${route.request().url()}`
              );
            }
          }
        }
        return await route.continue();
      });
    };

    const crawlLog = new Log({ prefix: store.name });

    const crawler = new PlaywrightCrawler({
      failedRequestHandler({ request, log }) {
        log.info(`Request ${request.url} failed too many times.`);
      },
      // Default is to reuse requestQueue from all crawl instances
      requestQueue: requestQueue,
      statisticsOptions: {
        //logIntervalSecs: 1800 // 30 minutes
        logIntervalSecs: 600 // 10 minutes
      },
      useSessionPool: true,
      sessionPoolOptions: {
        persistStateKey: `${store.name.replace(/[^a-zA-Z0-9!-_.'()]/g, '-')}-session-pool`
      },
      maxRequestsPerCrawl: 5000,
      maxRequestsPerMinute: 30,
      maxRequestRetries: 3,
      requestHandlerTimeoutSecs: 120,
      navigationTimeoutSecs: 120,
      respectRobotsTxtFile: false,
      retryOnBlocked: true,
      requestHandler: requestHandler,
      autoscaledPoolOptions: {
        loggingIntervalSecs: 600
      },
      log: crawlLog,
      headless: true,
      browserPoolOptions: {
        maxOpenPagesPerBrowser: 20,
        retireBrowserAfterPageCount: 100
      },
      launchContext: {
        launchOptions: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gl-drawing-for-tests',
            '--disable-client-side-phishing-detection',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--disable-features=InterestFeedContentSuggestions',
            '--disable-features=Translate',
            '--hide-scrollbars',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-first-run',
            '--ash-no-nudges',
            '--disable-search-engine-choice-screen',
            '--disable-ipc-flooding-protection',
            '--disable-renderer-backgrounding',
            '--allow-running-insecure-content',
            '--disable-back-forward-cache',

            '--disable-features=MediaRouter',
            '--enable-automation',
            // '--disable-background-networking',
            '--disable-component-update',
            '--disable-domain-reliability',
            '--disable-features=OptimizationHints',
            // '--no-pings',
            '--allow-pre-commit-input',
            '--disable-features=PaintHolding',
            '--in-process-gpu',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-sync',
            '--metrics-recording-only',
            '--disable-software-rasterizer'
          ]
        }
      },
      preNavigationHooks: [
        // async (crawlingContext) => {
        //   const { page } = crawlingContext;
        //   page.on('console', (msg) => {
        //     const msgType = msg.type();
        //     crawlLog.info(`Console ${msgType} on ${page.url()}: ${msg.text()}`);
        //   });
        //   await page.route('**/*', async (route) => {
        //     if (route.request().resourceType() === 'image') {
        //       console.log(`Blocking image: ${route.request().url()}`);
        //       return await route.fulfill({
        //         status: 200,
        //         contentType: 'image/png',
        //         body: defaultImage
        //       });
        //     }
        //     if (
        //       blockedPageResourceTypes.some(
        //         (blocked) => route.request().resourceType() === blocked
        //       ) ||
        //       blockedPagePathEndings.some((ending) =>
        //         route.request().url().endsWith(ending)
        //       )
        //     ) {
        //       console.log(
        //         `Blocking resource: ${route.request().url()} [${route.request().resourceType()}]`
        //       );
        //       return await route.fulfill({ status: 200 });
        //     } else return route.continue();
        //   });
        // },
        // async (crawlingContext) => {
        //   await crawlingContext.blockRequests({
        //     urlPatterns: [
        //       '.jpg',
        //       '.jpeg',
        //       '.png',
        //       '.svg',
        //       '.gif',
        //       '.webp',
        //       '.woff',
        //       '.woff2',
        //       '.ttf',
        //       '.otf',
        //       '.mp3',
        //       '.mp4',
        //       '.webm',
        //       '.pdf',
        //       '.zip',
        //       'google-analytics.com',
        //       'google.com',
        //       'google.is',
        //       'googleads.g.doubleclick.net',
        //       'googletagmanager.com',
        //       'adsbygoogle.js',
        //       'hubspot.com',
        //       'hubapi.com',
        //       'hsappstatic.net'
        //     ]
        //   });
        // },
        // (crawlingContext) => {
        //   const { page } = crawlingContext;
        //   page.on('request', (pageRequest) => {
        //     console.log(
        //       `Request: ${pageRequest.method()} ${pageRequest.url()} [${pageRequest.resourceType()}]`
        //     );
        //   });
        // },

        myHook
      ]
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
