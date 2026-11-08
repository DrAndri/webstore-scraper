import {
  PlaywrightCrawler,
  PlaywrightCrawlerOptions,
  PlaywrightCrawlingContext,
  PlaywrightGotoOptions,
  type Request
} from 'crawlee';
import { CacheItems } from '../types/index.js';
import { createLogger, logger as appLogger } from '../logger.js';
import PageScraper from './PageScraper.js';
import { errors, Page } from 'playwright';
import BaseCrawler from './BaseCrawler.js';
import {
  blockedPagePathEndings,
  blockedPageResourceTypes,
  blockedPageUrlPatterns,
  categoryBanList,
  defaultImage
} from './constants.js';

export default class WebshopCrawler extends BaseCrawler {
  setupCrawler(configuration: PlaywrightCrawlerOptions) {
    const cache: CacheItems = {};
    const {
      startUrl,
      selectors,
      productPageIdentifier,
      sanitizers,
      scrollPagesToBottom,
      menuClicker
    } = this.store.options;
    const store = this.store;
    const storeLog = appLogger.child({ label: store.name });

    const pageScraper = new PageScraper(selectors, sanitizers, categoryBanList);

    // const once = (
    //   checkFn: () => Promise<false | Locator>,
    //   opts: { numberOfChecks: number; interval: number }
    // ): Promise<false | Locator> => {
    //   return new Promise((resolve, reject) => {
    //     const numberOfChecks = opts.numberOfChecks;
    //     const interval = opts.interval;
    //     let checksPerformed = 0;
    //     const intervalID = setInterval(() => {
    //       void checkFn()
    //         .then((locator) => {
    //           if (locator) {
    //             clearInterval(intervalID);
    //             resolve(locator);
    //           } else if (checksPerformed >= numberOfChecks) {
    //             clearInterval(intervalID);
    //             resolve(false);
    //           }
    //           checksPerformed++;
    //         })
    //         .catch(() => reject(new Error('Error in once function')));
    //     }, interval);
    //   });
    // };

    // const findProductLocator = async (page: Page) => {
    //   try {
    //     const productLocator = page.locator(selectors.productPage);
    //     const count = await productLocator.count();
    //     if (count > 0) {
    //       const pageContent = await page.content();
    //       // eslint-disable-next-line @typescript-eslint/prefer-includes
    //       if (pageContent.indexOf(productPageIdentifier) > -1) {
    //         return productLocator;
    //       }
    //     }
    //     return false;
    //   } catch (e) {
    //     storeLog.error(`Error finding the product on ${page.url()}`, e);
    //     return false;
    //   }
    // };

    const findProductLocator = async (page: Page, timeout = 5000) => {
      const productLocator = page.locator(selectors.productPage);
      try {
        await productLocator.first().waitFor({ state: 'attached', timeout });
        await page.waitForFunction(
          (identifier) =>
            document.documentElement.outerHTML.includes(identifier),
          productPageIdentifier,
          { timeout, polling: 1000 }
        );
        return productLocator;
      } catch (e) {
        if (e instanceof errors.TimeoutError) return false; // not a product page
        storeLog.error(`Error finding the product on ${page.url()}`, e);
        return false;
      }
    };

    const requestHandler = async ({
      request,
      page
    }: {
      request: Request;
      page: Page;
    }) => {
      this.result.totalRequests++;
      await page.waitForLoadState('load');
      // await page
      //   .waitForLoadState('networkidle', { timeout: 30000 })
      //   .catch(() => {
      //     /* wait for 30 seconds or until network is idle */
      //   });

      // const productLocator = await once(() => findProductLocator(page), {
      //   interval: 3000,
      //   numberOfChecks: 7
      // });

      const productLocator = await findProductLocator(page);

      const logger = createLogger(
        request.loadedUrl ?? 'default label',
        store,
        this.jobId
      );

      if (productLocator) {
        //TODO: check if productLocator matches multiple elements
        logger.log('debug', 'Processing...');
        try {
          const scrapeResult = await pageScraper.scrapeProductPage(
            productLocator,
            logger
          );

          await this.handleProductScrapeResult(logger, scrapeResult);
        } catch (e) {
          this.handleProductScrapeError(logger, e);
        }
      } else {
        this.handleNotProductPage(logger);
      }

      if (menuClicker && request.url === startUrl) {
        try {
          const menuLocator = page.locator(menuClicker);
          await menuLocator.click();
        } catch (e) {
          logger.log('error', 'Error clicking menu');
          logger.log('error', '%O', e);
        }
      }

      // Only listing pages are scrolled to load more products
      if (this.mode === 'crawler')
        await addLinksToQueue(page, scrollPagesToBottom && !productLocator);
      await page.close();
    };
    const scrollToBottom = async (
      page: Page,
      lastScrollHeight?: number,
      counter = 0
    ) => {
      const scrollHeight =
        lastScrollHeight ??
        (await page.evaluate(
          () => window.document.documentElement.scrollHeight
        ));

      await page.evaluate((scrollHeight) => {
        window.scrollTo({ top: scrollHeight, behavior: 'instant' });
      }, scrollHeight);
      // Wait up to 10 seconds for more products, Advania takes 6 seconds to
      // load the next 100
      let scrollHeightAfter = scrollHeight;
      for (let i = 0; i < 20 && scrollHeightAfter <= scrollHeight; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        scrollHeightAfter = await page.evaluate(
          () => window.document.documentElement.scrollHeight
        );
      }
      // A store can load a page of products every other scroll, Advania
      // needs 22 for its 1100 products
      if (counter >= 30) return;
      counter++;
      if (scrollHeightAfter > scrollHeight)
        return scrollToBottom(page, lastScrollHeight, counter);
    };

    const addLinksToQueue = async (page: Page, scroll?: boolean) => {
      if (scroll) await scrollToBottom(page);
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
      // Sitemap entries, the browser keeps the XML elements of a sitemap
      const locs = await page.locator('loc').allTextContents();
      links.push(...locs.map((loc) => loc.trim()).filter((loc) => loc));

      await this.filterAndAddLinksToQueue(links);
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
          void route.fulfill({
            status: 200,
            contentType: 'image/png',
            body: defaultImage
          });
        } else if (
          blockedPageResourceTypes.some(
            (blocked) => route.request().resourceType() === blocked
          ) ||
          blockedPagePathEndings.some((ending) =>
            route.request().url().endsWith(ending)
          ) ||
          blockedPageUrlPatterns.some((pattern) =>
            route.request().url().includes(pattern)
          )
        ) {
          void route.fulfill({ status: 200 });
        } else if (
          (route.request().resourceType() === 'script' ||
            route.request().url().endsWith('.js')) &&
          route.request().url().includes(startUrl)
        ) {
          const cachedResponse = cache[route.request().url()];
          if (cachedResponse && cachedResponse.expires > Date.now()) {
            void route.fulfill({
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
              void route.fulfill({
                status: status,
                headers: headers,
                body: body
              });
            } catch (e) {
              storeLog.error(
                `Failed to cache script: ${route.request().url()}`,
                e
              );
            }
          }
        } else {
          void route.continue();
        }
      });
    };

    // const config = Configuration.getGlobalConfig();

    // config.set('persistStorage', 'false');
    // config.set('storageDir', '/dev/shm');

    const crawler = new PlaywrightCrawler({
      ...configuration,
      failedRequestHandler: ({ request, log }) => {
        log.info(`Request ${request.url} failed too many times.`);
        this.pageListener?.onRequestFailed(request.errorMessages);
      },
      requestHandler: requestHandler,
      headless: true,
      browserPoolOptions: {
        maxOpenPagesPerBrowser: 10,
        retireBrowserAfterPageCount: 100,
        retireInactiveBrowserAfterSecs: 10,
        closeInactiveBrowserAfterSecs: 1000,
        useFingerprints: false,
        fingerprintOptions: {
          useFingerprintCache: false
        }
      },
      launchContext: {
        //userDataDir: '/dev/shm/chrome-user-' + new Date().getTime(),
        launchOptions: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            // '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--no-pings',
            '--no-zygote',
            '--disable-application-cache',
            '--disable-offline-load-stale-cache',
            '--disable-gpu-shader-disk-cache',
            '--disable-web-security',
            '--disable-translate',
            '--disable-session-crashed-bubble',
            '--no-first-run',
            // '--single-process',
            '--noerrdialogs',
            '--disk-cache-dir=/dev/shm/chrome-cache-' + new Date().getTime(),
            // Additional RAM-friendly options
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',

            // Minimize disk I/O
            '--disable-logging',
            '--log-level=3'
          ]
        }
      },
      preNavigationHooks: [myHook]
    });

    return crawler;
  }
}
