import { Document } from "mongodb";

export interface Env {
  MONGODB_URI: string;
}

export interface StoreConfig {
  feedUrl: string;
  storeName: string;
}

export interface GoogleMerchantFeed {
  rss: {
    channel: {
      item: GoogleMerchantProduct[];
    };
  };
}

export interface GoogleMerchantProduct {
  "g:id": string;
  "g:price": number;
  "g:sale_price"?: number;
}

export interface MongodbDocument extends Document {
  sku: string;
  store: string;
  [key: string]: any;
}

export interface MongodbProductInfo extends MongodbDocument {
  sku: string;
  on_sale: boolean;
  lastSeen: number;
}

export interface MongodbProductPrice extends MongodbDocument {
  sku: string;
  sale_price: boolean;
  price: number;
  timestamp: number;
}
