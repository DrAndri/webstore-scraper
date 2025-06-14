import { type ObjectId } from 'mongodb';

export interface StoreConfig {
  name: string;
  type: StoreType;
  scraperEnabled: boolean;
  apiEnabled: boolean;
  options: WebScraperOptions | FeedOptions | WebshopCrawlerOptions;
}

export interface MongodbProductMetadata {
  sku: string;
  store?: string;
  store_id: ObjectId;
  name?: string;
  brand?: string;
  ean?: string;
}

export interface MongodbProductPrice {
  sku: string;
  store?: string;
  store_id: ObjectId;
  salePrice: boolean;
  price: number;
  start: number;
  end: number;
}

export interface WebshopCrawlerOptions {
  startUrl: string;
  selectors: ProductSelectors;
  sanitizers?: ProductSanitizers;
  productPageIdentifier: string;
}

export interface WebScraperOptions {
  catalogSearchUrl: string;
  productItemClasses: ProductItemClasses;
  pageParameter: string;
  totalProductsClass: string;
  sanitizers?: ProductSanitizers;
}

export interface ProductSanitizers {
  sku: ProductSanitizer;
}

export interface ProductSanitizer {
  value: string;
  replace: string;
}

export interface ProductSelectors {
  productPage: string;
  oldPrice: string;
  listPrice: string;
  name: string;
  sku: string;
  image: string;
  brand?: string;
  description: string;
  inStock?: string;
  clickers?: string[];
  attributes: AttributeSelectors;
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

export interface StorePage {
  url: string;
  lastCrawled: number;
  store_id: ObjectId;
  sku: string;
}
