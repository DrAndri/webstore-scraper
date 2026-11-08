import { type ObjectId } from 'mongodb';
import { ProductAttributeGroup } from './types.js';

export interface StoreConfig extends Store {
  options: WebshopCrawlerOptions;
  safeStoreName: string;
}

export interface MongodbProductMetadata {
  sku: string;
  storeId: ObjectId;
  name?: string;
  brand?: string;
  ean?: string;
  attributes?: ProductAttributeGroup[];
  image?: string;
  description?: string;
  inStock?: boolean;
  url?: string;
}

export interface MongodbProductPrice {
  sku: string;
  storeId: ObjectId;
  salePrice: boolean;
  price: number;
  start: number;
  end: number;
}

//Mariadb types

export type DbId = number | bigint;

export interface IdLookup {
  id: DbId;
}

export interface Store {
  id: DbId;
  name: string;
  createdDate: Date;
  lastScanDate: Date;
  scraperEnabled: boolean;
  apiEnabled: boolean;
}

export interface Product {
  id: DbId;
  storeId: DbId;
  manufacturerId?: DbId;
  categoryId?: DbId;
  sku: string;
  name?: string;
  image?: string;
  ean?: string;
  description?: string;
  url?: string;
  inStock?: boolean;
  firstSeenDate: Date;
  lastChangeDate: Date;
}

export interface ProductPrice {
  productId: DbId;
  price: number;
  start: Date;
  end: Date;
}

export interface Category {
  id: DbId;
  parentId?: DbId;
  name: string;
}

export interface Manufacturer {
  id: DbId;
  name: string;
}

export interface AttributeGroup {
  id: DbId;
  name: string;
}

export interface Attribute {
  id: DbId;
  groupId?: DbId;
  name: string;
}

export interface AttributeToProduct {
  attributeId: DbId;
  productId: DbId;
  value: string;
}

//END Mariadb types

export interface WebshopCrawlerOptions {
  storeId: DbId;
  type: 'httpcrawler' | 'crawler';
  startUrl: string;
  selectors: ProductSelectors;
  sanitizers?: ProductSanitizers;
  productPageIdentifier: string;
  urlWhitelist?: string[];
  urlBlacklist?: string[];
  // Query parameters kept on links before they are queued, the others are
  // removed. [] removes the whole query string, e.g. for filter links that
  // only list a subset of a category. Unset keeps all of them.
  keepQueryParams?: string[];
  // More pages the crawl starts from, e.g. a product listing with a larger
  // page size than the one the site links to
  startUrls?: string[];
  // Sitemaps whose <loc> urls are queued when crawling
  sitemapUrls?: string[];
  productFeed?: ProductFeed;
  scrollPagesToBottom?: boolean;
  menuClicker?: string;
}

// A JSON endpoint that lists the products of a store, for stores whose
// category pages load the products with JavaScript. The product page of each
// item is queued when crawling.
export interface ProductFeed {
  url: string;
  // Dot path to the list of items, a JSON string on the way is parsed, e.g.
  // "d.data" for ASP.NET script services
  items: string;
  // Url of the product page of an item, {field} is replaced with that field of
  // the item and {field:5} pads it with zeros to 5 characters
  productUrl: string;
  // Dot path to the number of pages of a paged feed. The {page} placeholder of
  // url is replaced with each page number, starting at 1.
  pageCount?: string;
  // Reads the feed once per item of another JSON list, e.g. once per category
  // for a store that only lists products by category. The {field}
  // placeholders of url are filled with the fields of each item.
  feedList?: ProductFeedList;
}

export interface ProductFeedList {
  url: string;
  // Dot path to the list of items, unset when the response is the list
  items?: string;
}

export interface ProductSanitizers {
  sku: ProductSanitizer[];
}

export interface ProductSanitizer {
  match: string;
  replace: string;
}

export type ProductSelector =
  | {
      source: 'url';
      delimiter: string;
      index: number | 'first' | 'last';
    }
  | {
      // Read an attribute of an element, e.g. data-productid
      source: 'attribute';
      selector: string;
      attribute: string;
    }
  | {
      // Read a dot path from the JSON text of an element, e.g. "id" from a
      // Shopify theme's <script id="ProductJson-product-template">. The
      // selector is matched in the whole page, not only in productPage, since
      // such scripts are usually outside the product element.
      source: 'json';
      selector: string;
      path: string;
    };

export type StructuredDataField =
  | 'sku'
  | 'gtin'
  | 'name'
  | 'brand'
  | 'image'
  | 'description'
  | 'price'
  | 'inStock'
  | 'categories';

export interface StructuredDataOptions {
  // jsonld: the schema.org Product in <script type="application/ld+json">
  // nextdata: the JSON in <script id="__NEXT_DATA__">
  source: 'jsonld' | 'nextdata';
  // Dot paths to read each field from, the first defined one wins. For jsonld
  // they are relative to the Product and override the schema.org defaults, for
  // nextdata they are relative to the __NEXT_DATA__ root. 'breadcrumbs' reads
  // categories from a JSON-LD BreadcrumbList. false skips the field so the CSS
  // selector is used instead.
  fields?: Partial<Record<StructuredDataField, string | string[] | false>>;
  // Splits a categories string, e.g. "Snyrtivara|Förðun|Varir"
  categorySplitter?: string;
}

export interface ProductSelectors {
  productPage: string;
  // Read fields from structured data first, CSS selectors fill in the rest
  structuredData?: StructuredDataOptions;
  oldPrice?: string;
  listPrice?: string;
  name?: string;
  sku?: string | ProductSelector;
  image?: string;
  // Attribute holding the image url, e.g. data-src for lazy loaded images. Defaults to src
  imageAttribute?: string;
  brand?: string;
  description?: string;
  inStock?: string;
  inStockText?: string;
  clickers?: string[];
  categories?: string;
  categorySplitter?: string;
  categoryItemLocator?: string;
  attributes?: AttributeSelectors;
}

export interface AttributeSelectors {
  attributesTable: string;
  attributeGroup?: string;
  attribute: string;
  attributeLabel: string;
  attributeValue: string;
  attributeGroupName?: string;
}

export interface ProductItemClasses {
  itemClass: string;
  oldPriceClass: string;
  listPriceClass: string;
  nameClass: string;
  skuClass: string;
  imageClass: string;
  totalProductsClass: string;
  brandClass: string;
}

export interface FeedOptions {
  feedUrl: string;
}
