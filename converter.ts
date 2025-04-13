import { Db } from 'mongodb';
import {
  MongodbProductMetadata,
  MongodbProductPrice,
  StoreConfig
} from './types/index.js';
async function getAllStores(db: Db): Promise<StoreConfig[]> {
  const cursor = db
    .collection<StoreConfig>('stores')
    .find(
      {},
      { projection: { _id: 1, feedUrl: 1, name: 1, options: 1, type: 1 } }
    );
  return await cursor.toArray();
}

export const addStoreObjectIdFieldToCollections = async (mongodb: Db) => {
  const stores = await getAllStores(mongodb);
  for (const store of stores) {
    const filter = { store: store.name };
    const update = { $set: { store_id: store._id } };
    await mongodb
      .collection<MongodbProductMetadata>('productMetadata')
      .updateMany(filter, update);
    await mongodb
      .collection<MongodbProductPrice>('productPrices')
      .updateMany(filter, update);
  }
};
