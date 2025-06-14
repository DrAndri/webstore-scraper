import { PlaywrightCrawler, RequestQueue } from 'crawlee';
import {
  ProductAttribute,
  ProductAttributeGroup,
  ProductSnapshot,
  StoreConfig,
  WebshopCrawlerOptions
} from './types/index.js';
import { Locator, Page } from 'playwright';
import { createLogger } from './logger.js';
import { Logger } from 'winston';
const absoluteUrlRegExp = new RegExp('^(?:[a-z+]+:)?//', 'i');

export default class WebshopCrawler {
  store: StoreConfig;
  options: WebshopCrawlerOptions;
  constructor(store: StoreConfig) {
    this.store = store;
    this.options = store.options as WebshopCrawlerOptions;
  }

  // isInternalURL(url: string, origin: string): boolean {
  //   return new URL(url).origin === origin;
  // }

  async crawlSite(): Promise<ProductSnapshot[]> {
    const { startUrl, selectors, productPageIdentifier } = this.options;

    async function scrapeProductPage(page: Page, logger: Logger) {
      const productLocator = page.locator(selectors.productPage);
      if ((await productLocator.count()) > 0) {
        if (selectors.clickers) {
          for (const selector of selectors.clickers) {
            await productLocator.locator(selector).click();
          }
        }
        const oldPriceLocator = selectors.oldPrice
          ? productLocator.locator(selectors.oldPrice)
          : null;
        const oldPrice =
          oldPriceLocator && (await oldPriceLocator?.count()) > 0
            ? parseInt(await evalPrice(selectors.oldPrice, productLocator))
            : undefined;
        const price = parseInt(
          await evalPrice(selectors.listPrice, productLocator)
        );
        const listPrice = oldPrice ?? price;
        const salePrice = price;

        const inStock = selectors.inStock
          ? (await productLocator.locator(selectors.inStock).count()) > 0
            ? true
            : false
          : undefined;

        let attributeGroups: ProductAttributeGroup[] = [];
        if (
          selectors.attributes?.attribute &&
          selectors.attributes.attributeLabel &&
          selectors.attributes.attributeValue &&
          selectors.attributes.attributesTable
        ) {
          logger.log('debug', 'checking attributes');
          const attributeTableLocator = productLocator
            .locator(selectors.attributes.attributesTable)
            .filter({
              has: selectors.attributes.attributeGroup
                ? page
                    .locator(selectors.attributes.attributeGroup)
                    .locator(selectors.attributes.attribute)
                    .locator(selectors.attributes.attributeValue)
                : page
                    .locator(selectors.attributes.attribute)
                    .locator(selectors.attributes.attributeValue)
            });
          if ((await attributeTableLocator.count()) == 1) {
            logger.log('debug', 'found table');
            const attributeGroupsLocator = selectors.attributes.attributeGroup
              ? attributeTableLocator
                  .locator(selectors.attributes.attributeGroup)
                  .filter({
                    has: page
                      .locator(selectors.attributes.attribute)
                      .locator(selectors.attributes.attributeLabel)
                  })
              : attributeTableLocator;
            const groupCount = await attributeGroupsLocator.count();
            logger.log('debug', 'group count %d', groupCount);
            if (groupCount > 0) {
              attributeGroups = [];
              for (const attributeGroupLocator of await attributeGroupsLocator.all()) {
                const groupName = selectors.attributes.attributeGroupName
                  ? await evalText(
                      selectors.attributes.attributeGroupName,
                      attributeGroupLocator
                    )
                  : 'Eiginleikar';
                const attributeLocator = attributeGroupLocator
                  .locator(selectors.attributes.attribute)
                  .filter({
                    has: page.locator(selectors.attributes.attributeLabel)
                  });
                const attributes: ProductAttribute[] = [];
                for (const oneAttribute of await attributeLocator.all()) {
                  try {
                    attributes.push({
                      value: await evalText(
                        selectors.attributes.attributeValue,
                        oneAttribute
                      ),
                      name: await evalText(
                        selectors.attributes.attributeLabel,
                        oneAttribute
                      )
                    });
                  } catch (e) {
                    logger.log('debug', 'Error getting attribute: %O', e);
                    logger.log(
                      'debug',
                      'Attribute: %s',
                      await oneAttribute.textContent()
                    );
                  }
                }
                attributeGroups.push({
                  name: groupName,
                  attributes: attributes
                });
              }
            } else {
              logger.log('debug', 'No groups found');
            }
          } else {
            logger.log(
              'debug',
              'Table count %d != 1',
              await attributeTableLocator.count()
            );
          }
        }
        logger.log('info', 'evaluating product');
        const product: ProductSnapshot = {
          sku: await evalSku(selectors.sku, productLocator),
          price: listPrice,
          sale_price: salePrice,
          title: await evalText(selectors.name, productLocator),
          brand: selectors.brand
            ? await evalText(selectors.brand, productLocator)
            : undefined,
          image: selectors.image
            ? await evalText(selectors.image, productLocator)
            : undefined,
          description: await evalText(selectors.description, productLocator),
          inStock: inStock,
          attributes: attributeGroups.length > 0 ? attributeGroups : undefined,
          url: page.url()
        };
        logger.log('info', 'Found product: %O', product);
        if (product.attributes) {
          for (const attributeGroup of product.attributes) {
            logger.log('debug', attributeGroup.name);
            logger.log('debug', '%O', attributeGroup.attributes);
          }
        }
        return product;
      }
    }

    async function evalText(selector: string, locator: Locator) {
      const textLocator = locator.locator(selector);
      const text = await textLocator.textContent();
      return text ?? '';
    }

    async function evalPrice(selector: string, locator: Locator) {
      const string = await evalText(selector, locator);
      return string.replace(/\D/g, '');
    }

    async function evalSku(selector: string, locator: Locator) {
      const string = await evalText(selector, locator);
      // if (this.options.sanitizers?.sku) {
      //   string = string.replace(
      //     this.options.sanitizers.sku.value,
      //     this.options.sanitizers.sku.replace
      //   );
      // }
      return string;
    }

    const productMap: Map<string, ProductSnapshot> = new Map<
      string,
      ProductSnapshot
    >();

    const requestQueue = await RequestQueue.open(this.store.name);

    const crawler = new PlaywrightCrawler({
      // failedRequestHandler({ request, log }) {
      //   log.info(`Request ${request.url} failed too many times.`);
      // },
      // Default is to reuse requestQueue from all crawl instances
      requestQueue: requestQueue,
      async requestHandler({ request, page }) {
        const logger = createLogger(page.url());
        await page.waitForLoadState('load');
        await page.waitForTimeout(10000);
        const content = await page.content();

        if (content.includes(productPageIdentifier)) {
          logger.log('info', 'processing url: %s', request.loadedUrl);
          try {
            const scrapedProduct = await scrapeProductPage(page, logger);
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

        // Finally, we have to add the URLs to the queue
        await crawler.addRequests(sameHostnameLinks);
      },
      maxRequestsPerCrawl: 500, // Limitation for only 10 requests (do not use if you want to crawl all links)
      maxRequestsPerMinute: 10,
      requestHandlerTimeoutSecs: 1800
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
