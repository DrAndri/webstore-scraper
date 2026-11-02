import { Db, ObjectId, WithId } from 'mongodb';
import {
  DbId,
  IdLookup,
  MongodbProductMetadata,
  MongodbProductPrice,
  Product,
  ProductPrice
} from './types/db-types.js';
import { createPool, SqlError, UpsertResult } from 'mariadb';
import { logger } from './logger.js';

const log = logger.child({ label: 'MongoToSQLMigrate' });

interface MongoStoreConfig {
  name: string;
  type: 'httpcrawler' | 'crawler' | 'scraper' | 'feed';
  scraperEnabled: boolean;
  apiEnabled: boolean;
}

const pool = createPool({
  host: process.env.MARIADB_HOST,
  database: process.env.MARIADB_DATABASE,
  user: process.env.MARIADB_SCRAPER_USER,
  password: process.env.MARIADB_SCRAPER_PASSWORD,
  connectionLimit: 1
});

const currentDate = new Date();

async function getAllStores(db: Db): Promise<WithId<MongoStoreConfig>[]> {
  const cursor = db.collection<MongoStoreConfig>('stores').find();
  return await cursor.toArray();
}

async function getAllProductsFromStore(
  db: Db,
  storeId: ObjectId
): Promise<WithId<MongodbProductMetadata>[]> {
  const cursor = db
    .collection<MongodbProductMetadata>('productMetadata')
    .find({ store_id: storeId });
  return await cursor.toArray();
}

async function getAllPricesForProduct(
  db: Db,
  storeId: ObjectId,
  sku: string,
  salePrice: boolean
): Promise<WithId<MongodbProductPrice>[]> {
  const cursor = db
    .collection<MongodbProductPrice>('priceChanges')
    .find({ store_id: storeId, sku: sku, salePrice: salePrice });
  return await cursor.toArray();
}

const handleManufacturer = async (
  product: WithId<MongodbProductMetadata>,
  sqlProductId: DbId
) => {
  if (!product.brand) return;
  let sqlManufacturerId = await pool
    .getConnection()
    .then(async (conn) => {
      const res = await conn.query<IdLookup[]>(
        'SELECT id FROM manufacturers WHERE name = ?',
        [product.brand]
      );
      await conn.release();
      return res;
    })
    .then((res) => (res.length > 0 ? res[0] : null));
  if (!sqlManufacturerId) {
    const res = await pool.getConnection().then(async (conn) => {
      const res = await conn.query<UpsertResult>(
        'INSERT INTO manufacturers (name) VALUES (?)',
        [product.brand]
      );
      await conn.release();
      return res;
    });
    sqlManufacturerId = { id: res.insertId };
  }

  await pool.getConnection().then(async (conn) => {
    await conn.query('UPDATE products SET manufacturerId = ? WHERE id = ?', [
      sqlManufacturerId.id,
      sqlProductId
    ]);
    await conn.release();
  });
};

const migrate = async (mongoDb: Db) => {
  log.info('Migrating data from MongoDB to SQL...');
  const stores = await getAllStores(mongoDb);
  log.info(`Found ${stores.length} stores`, { stores });
  let migratedStores = 0;
  let migratedProducts = 0;
  let migratedPrices = 0;
  for (const store of stores) {
    const sqlStoreId = await insertStoreIntoSQL(store);
    const products = await getAllProductsFromStore(mongoDb, store._id);
    let priceCount = 0;
    for (const product of products) {
      const sqlProductId = await insertProductIntoSQL(product, sqlStoreId);
      await handleManufacturer(product, sqlProductId);
      const prices = await getAllPricesForProduct(
        mongoDb,
        store._id,
        product.sku,
        false
      );
      const salePrices = await getAllPricesForProduct(
        mongoDb,
        store._id,
        product.sku,
        true
      );
      for (const price of prices) {
        await insertPriceIntoSQL(price, sqlProductId, 'prices');
        priceCount++;
      }
      for (const salePrice of salePrices) {
        await insertPriceIntoSQL(salePrice, sqlProductId, 'salePrices');
        priceCount++;
      }
    }
    log.info(
      `Migrated store: ${store.name} with ${products.length} products and ${priceCount} prices`
    );
    migratedStores++;
    migratedProducts += products.length;
    migratedPrices += priceCount;
  }
  log.info(`Done migrating data from MongoDB to SQL`);
  log.info(
    `Migrated total ${migratedStores} stores, ${migratedProducts} products, and ${migratedPrices} prices`
  );
};

async function insertStoreIntoSQL(store: WithId<MongoStoreConfig>) {
  return await pool.getConnection().then(async (conn) => {
    const res = await conn.query<UpsertResult>(
      'INSERT INTO stores (name, scraperEnabled, apiEnabled) VALUES (?, ?, ?)',
      [store.name, store.scraperEnabled, store.apiEnabled]
    );
    await conn.release();
    return res.insertId;
  });
}

async function insertProductIntoSQL(
  product: WithId<MongodbProductMetadata>,
  sqlStoreId: DbId
) {
  return await pool.getConnection().then(async (conn) => {
    const res = await conn
      .query<UpsertResult>(
        'INSERT INTO products (name, sku, storeId, ean, firstSeenDate, lastChangeDate) VALUES (?, ?, ?, ?, ?, ?)',
        [
          product.name,
          product.sku,
          sqlStoreId,
          product.ean,
          product._id.getTimestamp(),
          currentDate
        ]
      )
      .catch(async (e) => {
        if (e instanceof SqlError && e.errno === 1062) {
          log.debug(`Linking product ${product.sku} to an existing product`);
          const existingProduct = await conn
            .query<
              Product[]
            >('SELECT id FROM products WHERE storeId = ? AND sku = ?', [sqlStoreId, product.sku])
            .then((res) => (res.length > 0 ? res[0] : null));
          if (!existingProduct) throw new Error("Couldn't find the product...");
          return { insertId: existingProduct.id };
        }
        throw e;
      });
    await conn.release();
    return res.insertId;
  });
}

async function insertPriceIntoSQL(
  price: WithId<MongodbProductPrice>,
  sqlProductId: DbId,
  table: 'prices' | 'salePrices'
) {
  if (price.price > 16777215) {
    log.warn(`Price ${price.price} is too large, skipping it`);
    return;
  }
  const mongoPriceStart = new Date(price.start * 1000);
  mongoPriceStart.setHours(0, 0, 0, 0);
  const mongoPriceEnd = new Date(price.end * 1000);
  mongoPriceEnd.setHours(0, 0, 0, 0);
  return await pool.getConnection().then(async (conn) => {
    let res;
    try {
      res = await conn.query<UpsertResult>(
        `INSERT INTO ${table} (productId, price, start, end) VALUES (?, ?, ?, ?)`,
        [sqlProductId, price.price, mongoPriceStart, mongoPriceEnd]
      );
    } catch (e) {
      if (e instanceof SqlError && e.errno === 1062) {
        const existingPrice = await conn.query<ProductPrice>(
          `SELECT price, end FROM ${table} WHERE productId = ? AND start = ? `,
          [sqlProductId, mongoPriceStart]
        );
        if (existingPrice.price !== price.price) {
          log.warn(`Price of product ${sqlProductId} is inconsistent`);
        }
        if (mongoPriceEnd > existingPrice.end) {
          log.debug(`Updating the end of price for product ${sqlProductId}`);
          res = await conn.query<UpsertResult>(
            `UPDATE ${table} SET end = ? WHERE productId = ? AND start = ?`,
            [mongoPriceEnd, sqlProductId, mongoPriceStart]
          );
        } else {
          log.debug(`Ignoring duplicate price for product ${sqlProductId}`);
        }
      } else {
        log.error(`Inserting price for product ${sqlProductId} failed`, e);
      }
    }
    await conn.release();
    return res?.insertId;
  });
}
export default migrate;
