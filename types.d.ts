import { type Document, type InsertManyResult } from 'mongodb';

export interface GoogleMerchantFeed {
  rss: {
    channel: {
      item: GoogleMerchantProduct[];
    };
  };
}

export interface GoogleMerchantProduct {
  'g:id': string;
  'g:price': number;
  'g:title': string;
  'g:brand': string;
  'g:gtin': string;
  'g:sale_price'?: number;
}

export interface StoreConfig extends Document {
  feedUrl: string;
  name: string;
}

export interface MongodbProductMetadata extends Document {
  sku: string;
  store: string;
  lastSeen: number;
  salePriceLastSeen?: number;
  name?: string;
  brand?: string;
  ean?: string;
}

export interface MongodbProductPrice extends MongodbDocument {
  sku: string;
  store: string;
  sale_price: boolean;
  price: number;
  timestamp: number;
}

export interface StoreUpdateResult {
  productMetadataResult: UpsertManyResult | undefined;
  priceChangesResult: InsertManyResult | undefined;
  store: StoreConfig;
}

export interface UpsertManyResult {
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
}
