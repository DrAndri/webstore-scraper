import { PlaywrightCrawler, RequestQueue } from 'crawlee';
import {
  ProductSnapshot,
  StoreConfig,
  WebshopCrawlerOptions
} from '../types/index.js';
import { createLogger } from '../logger.js';
import PageScraper from './PageScraper.js';
const absoluteUrlRegExp = new RegExp('^(?:[a-z+]+:)?//', 'i');
const categoryBanList = ['forsíða', 'heim', 'vörur', 'allar vörur', 'til baka'];

export default class WebshopCrawler {
  store: StoreConfig;
  batchTimestamp: number;
  constructor(store: StoreConfig, batchTimestamp: number) {
    this.store = store;
    this.batchTimestamp = batchTimestamp;
  }

  async crawlSite(): Promise<ProductSnapshot[]> {
    const { startUrl, selectors, productPageIdentifier, sanitizers } = this
      .store.options as WebshopCrawlerOptions;
    const store = this.store;
    const batchTimestamp = this.batchTimestamp;

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

    const crawler = new PlaywrightCrawler({
      // failedRequestHandler({ request, log }) {
      //   log.info(`Request ${request.url} failed too many times.`);
      // },
      // Default is to reuse requestQueue from all crawl instances
      requestQueue: requestQueue,
      //maxRequestsPerCrawl: 500, // Limitation for only 10 requests (do not use if you want to crawl all links)
      maxRequestsPerMinute: 30,
      maxRequestRetries: 3,
      requestHandlerTimeoutSecs: 1800,
      respectRobotsTxtFile: false,
      retryOnBlocked: true,

      async requestHandler({ request, page }) {
        const urlParts = page.url().split('/');
        const logger = createLogger(
          urlParts[urlParts.length - 1],
          store.name,
          batchTimestamp
        );
        await page.waitForLoadState('load');
        const productLocator = page.locator(selectors.productPage);
        // await productLocator.waitFor({ timeout: 5000 });
        const count = await productLocator.count();

        if (
          count > 0 &&
          (await page.content()).includes(productPageIdentifier)
        ) {
          logger.log('info', 'processing url: %s', request.loadedUrl);
          try {
            const scrapedProduct = await pageScraper.scrapeProductPage(
              productLocator,
              logger
            );
            if (scrapedProduct !== undefined)
              productMap.set(scrapedProduct.sku, scrapedProduct);
          } catch (e) {
            logger.log(
              'error',
              'Error processing product from url %s',
              request.loadedUrl
            );
            logger.log('error', '%O', e);
          }
        } else {
          logger.log(
            'info',
            'url is not a product page: %s',
            request.loadedUrl
          );
        }

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
        const { hostname } = new URL(request.loadedUrl);
        const absoluteUrls = links.map((link) => {
          if (absoluteUrlRegExp.test(link)) return URL.parse(link);
          else return new URL(link, startUrl);
        });

        // We use the hostname to filter links that point
        // to a different domain, even subdomain.
        const sameHostnameLinks = absoluteUrls
          .filter((url) => url !== null)
          .filter((url) => url.hostname === hostname)
          .map((url) => url.href);

        logger.close();

        const badPathEndings = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];

        // Finally, we have to add the URLs to the queue
        await crawler.addRequests(
          sameHostnameLinks.filter(
            (url) => !badPathEndings.find((ending) => url.endsWith(ending))
          )
        );
      }
    });

    // Run the crawler with initial request
    await crawler.run([startUrl]);

    await requestQueue.drop();

    return Array.from(productMap, ([, value]) => value);
  }

  // sleep(seconds: number) {
  //   return new Promise((resolve) => {
  //     setTimeout(resolve, seconds * 1000);
  //   });
  // }
}
