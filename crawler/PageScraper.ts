import { Locator } from 'playwright';
import { AttributeSelectors } from '../types/db-types.js';
import {
  ProductAttribute,
  ProductAttributeGroup,
  ProductScrapeErrors,
  ProductSnapshot
} from '../types/types.js';
import { Logger } from 'winston';
import sanitizeHtml from 'sanitize-html';
import { expect } from 'playwright/test';
import BaseScraper from './BaseScraper.js';

export default class PageScraper extends BaseScraper {
  async scrapePrices(productLocator: Locator): Promise<{
    listPrice: number;
    salePrice: number | undefined;
  }> {
    if (!this.selectors.listPrice)
      throw new Error('No listPrice selector configured');
    // First, as reading it waits for the price to be rendered. count() does
    // not wait, the old price was missed when the page rendered the product
    // number before the prices (S4S).
    const price = await this.evalPrice(
      this.selectors.listPrice,
      productLocator
    );
    expect(price).toBeTruthy();
    let oldPrice: number | undefined = undefined;
    if (this.selectors.oldPrice) {
      const oldPriceLocator = productLocator.locator(this.selectors.oldPrice);
      oldPrice =
        (await oldPriceLocator.count()) === 1
          ? await this.evalPrice(this.selectors.oldPrice, productLocator)
          : undefined;
    }
    const listPrice = oldPrice && oldPrice > 0 ? oldPrice : price;
    const salePrice = price;

    //TODO: Remove if expect is working
    if (!listPrice) throw new Error('Price not found');

    return { listPrice, salePrice };
  }

  async scrapeCategories(
    productLocator: Locator,
    productName: string | undefined
  ) {
    const { categorySplitter, categoryItemLocator, categories } =
      this.selectors;

    if (!categories) return undefined;

    const locator = productLocator.locator(categories);

    if (categoryItemLocator) {
      const categories: string[] = [];
      const categoryItems = locator.locator(categoryItemLocator);
      for (const categoryItemLocator of await categoryItems.all()) {
        const category = await categoryItemLocator
          .textContent()
          .then((str) => str?.trim());
        if (
          category != null &&
          this.isValidCategory(category) &&
          category != productName &&
          !categories.includes(category)
        )
          categories.push(category);
      }
      return categories;
    } else if (categorySplitter) {
      const categoriesString = await locator.textContent();
      if (!categoriesString) return [];
      // Trimmed and without banned names like the categoryItemLocator ones
      if (categorySplitter)
        return this.cleanCategories(
          categoriesString.split(categorySplitter),
          productName
        );
      return [categoriesString];
    } else return undefined;
  }

  async scrapeAttributes(
    productLocator: Locator,
    selectors: AttributeSelectors | undefined,
    logger: Logger
  ) {
    const attributeGroups: ProductAttributeGroup[] = [];
    if (
      !selectors?.attribute ||
      !selectors.attributeLabel ||
      !selectors.attributeValue ||
      !selectors.attributesTable
    ) {
      return undefined;
    }
    const attributeTableLocator = productLocator
      .locator(selectors.attributesTable)
      .filter({
        has: selectors.attributeGroup
          ? productLocator
              .page()
              .locator(selectors.attributeGroup)
              .locator(selectors.attribute)
              .locator(selectors.attributeValue)
          : productLocator
              .page()
              .locator(selectors.attribute)
              .locator(selectors.attributeValue)
      });
    if ((await attributeTableLocator.count()) > 0) {
      for (const oneTable of await attributeTableLocator.all()) {
        const attributeGroupsLocator = selectors.attributeGroup
          ? oneTable.locator(selectors.attributeGroup).filter({
              has: oneTable
                .page()
                .locator(selectors.attribute)
                .locator(selectors.attributeLabel)
            })
          : oneTable;
        const groupCount = await attributeGroupsLocator.count();
        if (groupCount > 0) {
          for (const attributeGroupLocator of await attributeGroupsLocator.all()) {
            const groupName = selectors.attributeGroupName
              ? ((await this.evalText(
                  selectors.attributeGroupName,
                  attributeGroupLocator
                )) ?? undefined)
              : undefined;
            const attributeLocator = attributeGroupLocator
              .locator(selectors.attribute)
              .filter({
                has: attributeGroupLocator
                  .page()
                  .locator(selectors.attributeLabel)
              })
              .filter({
                has: attributeGroupLocator
                  .page()
                  .locator(selectors.attributeValue)
              });
            const attributes: ProductAttribute[] = [];
            for (const oneAttribute of await attributeLocator.all()) {
              try {
                const value = await this.evalText(
                  selectors.attributeValue,
                  oneAttribute
                );
                const name = await this.evalText(
                  selectors.attributeLabel,
                  oneAttribute
                );
                if (!value) throw new Error('Attribute value not found');
                if (!name) throw new Error('Attribute name not found');
                attributes.push({
                  value: value,
                  name: name
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
          throw new Error('No attribute groups found');
        }
      }
    } else {
      throw new Error('No attribute tables found');
    }

    return attributeGroups.length > 0 ? attributeGroups : undefined;
  }

  async scrapeInStock(productLocator: Locator) {
    if (!this.selectors.inStock) return undefined;
    const count = await productLocator
      .locator(this.selectors.inStock)
      .filter({ hasText: this.selectors.inStockText })
      .count();
    return count > 0;
  }

  async scrapeImage(productLocator: Locator) {
    if (!this.selectors.image) return undefined;
    const locator = productLocator.locator(this.selectors.image).first();
    const src = await locator.getAttribute(
      this.selectors.imageAttribute ?? 'src'
    );
    return src ?? undefined;
  }

  async scrapeBrand(productLocator: Locator) {
    if (!this.selectors.brand) return undefined;
    return await this.evalText(this.selectors.brand, productLocator);
  }

  async scrapeDescription(productLocator: Locator) {
    if (!this.selectors.description) return undefined;
    const locator = productLocator.locator(this.selectors.description);
    // Products without a description, innerHTML() would wait for one until
    // it times out (30s). The prices are read first, so the page is rendered.
    if ((await locator.count()) === 0) return undefined;
    const html = await locator.innerHTML();
    return sanitizeHtml(html);
  }

  async scrapeProductPage(productLocator: Locator, logger: Logger) {
    const errors: ProductScrapeErrors = {
      description: false,
      attributes: false,
      image: false,
      brand: false,
      name: false,
      inStock: false,
      categories: false
    };
    if (this.selectors.clickers) {
      for (const selector of this.selectors.clickers) {
        try {
          const clickLocator = productLocator.locator(selector);
          if ((await clickLocator.count()) != 1)
            logger.log('warn', 'Clicker %s did not match 1 element', selector);
          await clickLocator.click({ force: true, timeout: 5000 });
        } catch (e) {
          logger.log('warn', 'Clicker %s errored', selector);
          logger.log('debug', e);
        }
      }
    }
    const sku = await this.evalSku(productLocator);
    const { listPrice, salePrice } = await this.scrapePrices(productLocator);

    const inStock = await this.scrapeInStock(productLocator).catch((e) => {
      errors.inStock = e;
      return undefined;
    });
    const image = await this.scrapeImage(productLocator).catch((e) => {
      errors.image = e;
      return undefined;
    });
    const attributeGroups = await this.scrapeAttributes(
      productLocator,
      this.selectors.attributes,
      logger
    ).catch((e) => {
      errors.attributes = e;
      return undefined;
    });

    const name = this.selectors.name
      ? await this.evalText(this.selectors.name, productLocator).catch((e) => {
          errors.name = e;
          return undefined;
        })
      : undefined;
    const brand = await this.scrapeBrand(productLocator).catch((e) => {
      errors.brand = e;
      return undefined;
    });

    const description = await this.scrapeDescription(productLocator).catch(
      (e) => {
        errors.description = e;
        return undefined;
      }
    );
    const categories = await this.scrapeCategories(productLocator, name).catch(
      (e) => {
        errors.categories = e;
        return undefined;
      }
    );

    const product: ProductSnapshot = {
      sku: sku,
      price: listPrice,
      salePrice: salePrice,
      title: name,
      brand: brand,
      image: image,
      description: description,
      inStock: inStock,
      attributes: attributeGroups,
      url: this.getRelativeUrl(productLocator.page().url()),
      categories: categories,
      gtin: undefined
    };
    logger.log('info', 'Found product: %O', product);
    if (product.attributes) {
      for (const attributeGroup of product.attributes) {
        logger.log('debug', attributeGroup.name);
        logger.log('debug', '%O', attributeGroup.attributes);
      }
    }
    return { product, errors };
  }

  async evalText(selector: string, locator: Locator) {
    const textLocator = locator.locator(selector);
    const text = await textLocator.textContent();
    return text?.trim();
  }

  async evalPrice(selector: string, locator: Locator) {
    // The element's own text when it holds the price, without the old price
    // in a child element, e.g. <app-price>1.256 <span>1.795</span></app-price>
    const string = await locator.locator(selector).evaluate((element) => {
      const ownText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === 3) // text nodes
        .map((node) => node.textContent)
        .join('');
      return /\d/.test(ownText) ? ownText : element.textContent;
    });
    if (!string) return undefined;
    // The lowest price of a range, "34.998 - 41.997"
    const price = string.split(/\s[-–]\s/)[0];
    return parseInt(price.replace(/\D/g, ''));
  }

  async evalSku(locator: Locator) {
    const { sku } = this.selectors;
    let string;
    if (typeof sku === 'string') {
      string = await this.evalText(sku, locator);
    } else if (sku?.source === 'url') {
      string = this.skuFromUrl(locator.page().url(), sku);
    } else if (sku?.source === 'attribute') {
      string = await locator
        .locator(sku.selector)
        .first()
        .getAttribute(sku.attribute);
    }
    return this.sanitizeSku(string);
  }
}
