import { PlaywrightCrawler, RequestQueue } from 'crawlee';
import {
  ProductAttribute,
  ProductAttributeGroup,
  ProductSnapshot,
  StoreConfig,
  WebshopCrawlerOptions
} from './types/index.js';
import { Locator } from 'playwright';
import { createLogger } from './logger.js';
import { Logger } from 'winston';
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

    async function scrapePrices(productLocator: Locator): Promise<{
      listPrice: number;
      salePrice: number;
    }> {
      const oldPriceLocator = selectors.oldPrice
        ? productLocator.locator(selectors.oldPrice)
        : null;
      const oldPrice =
        oldPriceLocator && (await oldPriceLocator.count()) > 0
          ? await evalPrice(selectors.oldPrice, productLocator)
          : undefined;
      const price = await evalPrice(selectors.listPrice, productLocator);
      const listPrice = oldPrice ?? price;
      const salePrice = price;

      return { listPrice, salePrice };
    }

    function isValidCategory(category: string) {
      if (category.length < 2) return false;
      const lowerCased = category.toLocaleLowerCase();
      if (categoryBanList.find((item) => item == lowerCased)) return false;
      return true;
    }

    async function scrapeCategories(
      productLocator: Locator,
      productName: string | undefined
    ) {
      const { categorySplitter, categoryItemLocator } = selectors;

      const locator = productLocator.locator(selectors.categories);

      if (categoryItemLocator) {
        const categories = [];
        const categoryItems = locator.locator(categoryItemLocator);
        for (const categoryItemLocator of await categoryItems.all()) {
          const category = await categoryItemLocator.textContent();
          if (
            category != null &&
            isValidCategory(category) &&
            category != productName
          )
            categories.push(category);
        }
        return categories;
      } else {
        const categoriesString = await locator.textContent();
        if (!categoriesString) return [];
        if (categorySplitter) return categoriesString.split(categorySplitter);
        return [categoriesString];
      }
    }

    async function scrapeAttributes(productLocator: Locator, logger: Logger) {
      let attributeGroups: ProductAttributeGroup[] = [];
      if (
        selectors.attributes?.attribute &&
        selectors.attributes.attributeLabel &&
        selectors.attributes.attributeValue &&
        selectors.attributes.attributesTable
      ) {
        const attributeTableLocator = productLocator
          .locator(selectors.attributes.attributesTable)
          .filter({
            has: selectors.attributes.attributeGroup
              ? productLocator
                  .page()
                  .locator(selectors.attributes.attributeGroup)
                  .locator(selectors.attributes.attribute)
                  .locator(selectors.attributes.attributeValue)
              : productLocator
                  .page()
                  .locator(selectors.attributes.attribute)
                  .locator(selectors.attributes.attributeValue)
          });
        if ((await attributeTableLocator.count()) == 1) {
          logger.log('debug', 'found table');
          const attributeGroupsLocator = selectors.attributes.attributeGroup
            ? attributeTableLocator
                .locator(selectors.attributes.attributeGroup)
                .filter({
                  has: attributeTableLocator
                    .page()
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
                  has: attributeGroupLocator
                    .page()
                    .locator(selectors.attributes.attributeLabel)
                })
                .filter({
                  has: attributeGroupLocator
                    .page()
                    .locator(selectors.attributes.attributeValue)
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
      return attributeGroups;
    }

    async function scrapeInStock(productLocator: Locator) {
      if (!selectors.inStock) return undefined;
      const count = await productLocator
        .locator(selectors.inStock)
        .filter({ hasText: selectors.inStockText })
        .count();
      return count > 0;
    }

    async function scrapeImage(productLocator: Locator) {
      if (!selectors.image) return undefined;
      const locator = productLocator.locator(selectors.image);
      const src = await locator.getAttribute('src');
      return src ?? undefined;
    }

    async function scrapeBrand(productLocator: Locator) {
      return selectors.brand
        ? await evalText(selectors.brand, productLocator)
        : undefined;
    }

    async function scrapeProductPage(productLocator: Locator, logger: Logger) {
      if ((await productLocator.count()) > 0) {
        if (selectors.clickers) {
          for (const selector of selectors.clickers) {
            try {
              const clickLocator = productLocator.locator(selector);
              if ((await clickLocator.count()) != 1)
                logger.log(
                  'warn',
                  'Clicker %s did not match 1 element',
                  selector
                );
              await clickLocator.click({ force: true, timeout: 5000 });
            } catch (e) {
              logger.log('warn', 'Clicker %s errored', selector);
              logger.log('debug', e);
            }
          }
        }
        const sku = await evalSku(productLocator);
        const { listPrice, salePrice } = await scrapePrices(productLocator);

        const inStock = await scrapeInStock(productLocator).catch((e) => {
          logger.log('warn', 'Error scraping inStock: %O', e);
          return undefined;
        });
        const image = await scrapeImage(productLocator).catch((e) => {
          logger.log('warn', 'Error scraping image: %O', e);
          return undefined;
        });
        const attributeGroups = await scrapeAttributes(productLocator, logger);

        const name = await evalText(selectors.name, productLocator).catch(
          (e) => {
            logger.log('warn', 'Error scraping name: %O', e);
            return undefined;
          }
        );
        const brand = await scrapeBrand(productLocator).catch((e) => {
          logger.log('warn', 'Error scraping brand: %O', e);
          return undefined;
        });

        const description = await evalText(
          selectors.description,
          productLocator
        ).catch((e) => {
          logger.log('warn', 'Error scraping description: %O', e);
          return undefined;
        });
        const categories = await scrapeCategories(productLocator, name).catch(
          (e) => {
            logger.log('warn', 'Error scraping categories: %O', e);
            return undefined;
          }
        );

        logger.log('info', 'evaluating product');
        const product: ProductSnapshot = {
          sku: sku,
          price: listPrice,
          sale_price: salePrice,
          title: name,
          brand: brand,
          image: image,
          description: description,
          inStock: inStock,
          attributes: attributeGroups.length > 0 ? attributeGroups : undefined,
          url: productLocator.page().url(),
          categories: categories
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
      return parseInt(string.replace(/\D/g, ''));
    }

    async function evalSku(locator: Locator) {
      let string = await evalText(selectors.sku, locator);
      if (sanitizers?.sku) {
        string = string.replace(sanitizers.sku.value, sanitizers.sku.replace);
      }
      if (string.length < 2) throw new Error(`Sku ${string} is not valid`);
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
        await productLocator.waitFor({ timeout: 5000 });
        const count = await productLocator.count();

        if (
          count > 0 &&
          (await page.content()).includes(productPageIdentifier)
        ) {
          logger.log('info', 'processing url: %s', request.loadedUrl);
          try {
            const scrapedProduct = await scrapeProductPage(
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
