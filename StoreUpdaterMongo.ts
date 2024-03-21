import {
  Collection,
  Db,
  MongoClient,
  Document,
  UpdateResult,
  InsertManyResult,
} from "mongodb";
import {
  GoogleMerchantProduct,
  MongodbDocument,
  MongodbProductInfo,
  MongodbProductPrice,
} from "./types";

class StoreUpdaterMongo {
  database: Db;
  store: string;
  priceDocuments: MongodbProductPrice[];
  productDocuments: MongodbProductInfo[];
  constructor(mongoClient: MongoClient, store: string) {
    this.store = store;
    this.priceDocuments = [];
    this.productDocuments = [];
    this.database = mongoClient.db("google-shopping-scraper");
  }
  isNumber(val: any) {
    return typeof val === "number" && val === val;
  }

  updateProduct(product: GoogleMerchantProduct, timestamp: number) {
    let promises = [];
    const document = this.upsertProductInfo(product, timestamp);
    promises.push(
      new Promise<void>((resolve, reject) => {
        this.hasPriceChanged(product, false).then((changed) => {
          if (changed) this.insertPriceChange(product, false, timestamp);
          resolve();
        });
      })
    );
    if (document.on_sale) {
      promises.push(
        new Promise<void>((resolve, reject) => {
          this.hasPriceChanged(product, true).then((changed) => {
            if (changed) this.insertPriceChange(product, true, timestamp);
            resolve();
          });
        })
      );
    }
    return promises;
  }

  isOnSale(product: GoogleMerchantProduct) {
    return (
      product["g:sale_price"] !== undefined &&
      product["g:sale_price"] < product["g:price"]
    );
  }

  async hasPriceChanged(
    product: GoogleMerchantProduct,
    salePrice: boolean
  ): Promise<boolean> {
    const cursor = this.database
      .collection<MongodbProductPrice>("priceChanges")
      .find({ sku: product["g:id"], sale_price: salePrice, store: this.store })
      .sort({ timestamp: -1 })
      .limit(1);
    let price: number = 0;
    if (salePrice) {
      price = product["g:sale_price"] ? product["g:sale_price"] : 0;
    } else {
      price = product["g:price"];
    }
    const doc = await cursor.next();
    if (doc) {
      return Promise.resolve(price !== doc?.price);
    } else {
      return Promise.resolve(true);
    }
  }

  upsertProductInfo(
    product: GoogleMerchantProduct,
    timestamp: number
  ): MongodbProductInfo {
    const productInfo: MongodbProductInfo = {
      sku: product["g:id"],
      lastSeen: timestamp,
      on_sale: this.isOnSale(product),
      store: this.store,
    };
    this.productDocuments.push(productInfo);
    return productInfo;
  }

  insertPriceChange(
    product: GoogleMerchantProduct,
    sale_price: boolean,
    timestamp: number
  ) {
    const price: any = sale_price
      ? product["g:sale_price"]
      : product["g:price"];
    if (this.isNumber(price)) {
      const numberPrice: number = price;
      const document: MongodbProductPrice = {
        sku: product["g:id"],
        price: numberPrice,
        store: this.store,
        sale_price: sale_price,
        timestamp: timestamp,
      };
      this.priceDocuments.push(document);
    }
  }

  async submitAllDocuments() {
    let results: {
      productInfoResult: UpdateResult | undefined;
      priceChangeResult: InsertManyResult | undefined;
    } = { productInfoResult: undefined, priceChangeResult: undefined };
    if (this.priceDocuments.length > 0)
      results.priceChangeResult = await this.insertDocumentArray(
        this.priceDocuments,
        this.database.collection("priceChanges")
      );
    if (this.productDocuments.length > 0)
      results.productInfoResult = await this.upsertDocumentArray(
        this.productDocuments,
        this.database.collection("productInfo")
      );
    return results;
  }

  async upsertDocumentArray(
    documents: MongodbDocument[],
    collection: Collection<Document>
  ) {
    const options = { upsert: true };
    for (const document of documents) {
      const filter = { sku: document.sku, store: document.store };
      const update = { $set: document };
      return await collection.updateOne(filter, update, options);
    }
  }

  async insertDocumentArray(
    documents: MongodbDocument[],
    collection: Collection<Document>
  ) {
    return await collection.insertMany(documents);
  }
}

export default StoreUpdaterMongo;
