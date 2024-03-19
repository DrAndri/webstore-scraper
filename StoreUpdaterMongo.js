import { MongoClient } from "mongodb";

class StoreUpdaterMongo {
  constructor(mongoClient, store) {
    // this.mongoClient = mongoClient;
    this.mongoClient = new MongoClient(MONGODB_URL);
    this.store = store;
  }

  updateAmountIfDifferent(sku, measurement, amount, timestamp) {
    if (!amount) return null;
  }

  writeDataPointIfPriceIsDifferent(item, timestamp) {
    const sku = item["g:id"];
    const price = item["g:price"];
    let salePrice = item["g:sale_price"];

    if (salePrice >= price) salePrice = null;

    const listUpdate = this.updateAmountIfDifferent(
      sku,
      "price",
      price,
      timestamp
    );
    const saleUpdate = this.updateAmountIfDifferent(
      sku,
      "sale_price",
      salePrice,
      timestamp
    );

    return Promise.all([listUpdate, saleUpdate]);
  }

  writeNewPoint(sku, measurement, price, timestamp) {}
}

export default StoreUpdaterMongo;
