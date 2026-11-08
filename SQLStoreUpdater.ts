import {
  createPool,
  Pool,
  PoolConfig,
  PoolConnection,
  UpsertResult
} from 'mariadb';
import {
  ProductPrice,
  Category,
  StoreConfig,
  Product,
  AttributeToProduct,
  DbId,
  IdLookup,
  Manufacturer,
  AttributeGroup,
  Attribute
} from './types/db-types.js';
import {
  ProductSnapshot,
  ProductAttributeGroup,
  StoreUpdateResult
} from './types/types.js';
import {
  getSolrProduct,
  indexAttributeGroups,
  indexAttributes,
  indexCategories,
  indexManufacturers,
  indexProducts,
  SOLR_CHUNK_SIZE,
  SolrProduct,
  SolrUpdateBuffer
} from './SolrUtils.js';
import { logger } from './logger.js';

const log = logger.child({ label: 'SQLStoreUpdater' });

export const poolConfig: PoolConfig = {
  host: process.env.MARIADB_HOST,
  database: process.env.MARIADB_DATABASE,
  user: process.env.MARIADB_SCRAPER_USER,
  password: process.env.MARIADB_SCRAPER_PASSWORD,
  connectionLimit: 1,
  acquireTimeout: 30000
};

const getFirstDbId = (res: IdLookup[]): DbId | undefined => {
  return getFirstResult(res)?.id;
};

const getFirstResult = <T>(res: T[]): T | undefined => {
  return res.length > 0 ? res[0] : undefined;
};

// A field the scrape did not find is undefined in the scraped product and NULL
// in the database
const differs = (scraped: unknown, stored: unknown): boolean =>
  (scraped ?? null) !== (stored ?? null);

// The database returns inStock, a BOOLEAN column, as 0 or 1
const toProduct = (row: Product): Product => ({
  ...row,
  inStock: row.inStock == null ? row.inStock : Boolean(row.inStock)
});

const getLatestPrice = async (
  conn: PoolConnection,
  table: 'prices' | 'salePrices',
  productId: DbId
): Promise<ProductPrice | undefined> => {
  return await conn
    .query<ProductPrice[]>(
      `SELECT price, start, end FROM ${table} WHERE productId = ? ORDER BY start DESC LIMIT 1`,
      [productId]
    )
    .then((res) => getFirstResult(res));
};
const getAttriButesToProducts = async (
  conn: PoolConnection,
  product: Product
): Promise<AttributeToProduct[]> => {
  return await conn.query<AttributeToProduct[]>(
    'SELECT * FROM attributeToProducts WHERE productId = ?',
    [product.id]
  );
};

export interface IndexProgress {
  // Documents to index in all the cores
  total: number;
  indexed: number;
}

export interface IndexEverythingOptions {
  onProgress?: (progress: IndexProgress) => void;
  // Checked before each chunk, indexing stops when it returns true
  isCancelled?: () => boolean;
}

// Documents indexed in each core
export interface IndexResult {
  products: number;
  categories: number;
  manufacturers: number;
  attributeGroups: number;
  attributes: number;
}

// The latest price of each of the products that has one, by product id
const getLatestPrices = async (
  conn: PoolConnection,
  table: 'prices' | 'salePrices',
  productIds: DbId[]
): Promise<Map<string, ProductPrice>> => {
  const rows = await conn.query<ProductPrice[]>(
    `SELECT p.productId, p.price, p.start, p.end FROM ${table} p JOIN (SELECT productId, MAX(start) AS start FROM ${table} WHERE productId IN (?) GROUP BY productId) latest ON latest.productId = p.productId AND latest.start = p.start`,
    [productIds]
  );
  return new Map(rows.map((row) => [String(row.productId), row]));
};

// The Solr documents of the products with their current price and attributes,
// read with one query for each table instead of one for each product
const toSolrProducts = async (
  conn: PoolConnection,
  products: Product[]
): Promise<SolrProduct[]> => {
  const ids = products.map((product) => product.id);
  const attributeRows = await conn.query<AttributeToProduct[]>(
    'SELECT * FROM attributeToProducts WHERE productId IN (?)',
    [ids]
  );
  const prices = await getLatestPrices(conn, 'prices', ids);
  const salePrices = await getLatestPrices(conn, 'salePrices', ids);

  const attributesByProduct = new Map<string, AttributeToProduct[]>();
  for (const row of attributeRows) {
    const key = String(row.productId);
    const list = attributesByProduct.get(key);
    if (list) list.push(row);
    else attributesByProduct.set(key, [row]);
  }

  return products.map((product) => {
    const key = String(product.id);
    const latestPrice = prices.get(key);
    const latestSalePrice = salePrices.get(key);
    let price;
    if (latestPrice && latestSalePrice) {
      price =
        latestSalePrice.end >= latestPrice.end
          ? latestSalePrice.price
          : latestPrice.price;
    } else if (latestPrice) {
      price = latestPrice.price;
    } else if (latestSalePrice) {
      price = latestSalePrice.price;
    }
    return getSolrProduct(product, price, attributesByProduct.get(key) ?? []);
  });
};

const indexAll = async (
  conn: PoolConnection,
  { onProgress, isCancelled }: IndexEverythingOptions
): Promise<IndexResult> => {
  // The products are read a chunk at a time, so the descriptions of every
  // product are not in memory at once
  const [{ productCount }] = await conn.query<{ productCount: bigint }[]>(
    'SELECT COUNT(*) AS productCount FROM products'
  );
  const categories = await conn.query<Category[]>('SELECT * FROM categories');
  const manufacturers = await conn.query<Manufacturer[]>(
    'SELECT * FROM manufacturers'
  );
  const attributeGroups = await conn.query<AttributeGroup[]>(
    'SELECT * FROM attributeGroups'
  );
  const attributes = await conn.query<Attribute[]>('SELECT * FROM attributes');

  const result: IndexResult = {
    products: 0,
    categories: 0,
    manufacturers: 0,
    attributeGroups: 0,
    attributes: 0
  };
  const total =
    Number(productCount) +
    categories.length +
    manufacturers.length +
    attributeGroups.length +
    attributes.length;
  let indexed = 0;
  // Products added by a scan while indexing are indexed too, past the total
  const reportProgress = () =>
    onProgress?.({ total: Math.max(total, indexed), indexed });
  const counted = (core: keyof IndexResult, count: number) => {
    result[core] += count;
    indexed += count;
    reportProgress();
  };
  reportProgress();

  // Indexes the rows of one core in chunks, false when it was cancelled
  const indexCore = async <T>(
    core: keyof IndexResult,
    rows: T[],
    submit: (chunk: T[]) => Promise<void>
  ): Promise<boolean> => {
    for (let i = 0; i < rows.length; i += SOLR_CHUNK_SIZE) {
      if (isCancelled?.()) return false;
      const chunk = rows.slice(i, i + SOLR_CHUNK_SIZE);
      await submit(chunk);
      counted(core, chunk.length);
    }
    return true;
  };

  // Indexes the products in chunks by id, false when it was cancelled
  const indexProductChunks = async (): Promise<boolean> => {
    let lastId: DbId = 0;
    for (;;) {
      if (isCancelled?.()) return false;
      const chunk: Product[] = (
        await conn.query<Product[]>(
          'SELECT * FROM products WHERE id > ? ORDER BY id LIMIT ?',
          [lastId, SOLR_CHUNK_SIZE]
        )
      ).map(toProduct);
      if (chunk.length === 0) return true;
      await indexProducts(await toSolrProducts(conn, chunk));
      lastId = chunk[chunk.length - 1].id;
      counted('products', chunk.length);
    }
  };

  log.info(`Indexing ${productCount} products`);
  const completed =
    (await indexProductChunks()) &&
    (await indexCore('categories', categories, indexCategories)) &&
    (await indexCore('manufacturers', manufacturers, indexManufacturers)) &&
    (await indexCore(
      'attributeGroups',
      attributeGroups,
      indexAttributeGroups
    )) &&
    (await indexCore('attributes', attributes, indexAttributes));
  log.info(
    `${completed ? 'Indexed' : 'Cancelled after indexing'} ${result.products} products, ${result.categories} categories, ${result.manufacturers} manufacturers, ${result.attributeGroups} attribute groups and ${result.attributes} attributes`
  );
  return result;
};

// Indexes every product, category, manufacturer, attribute group and attribute
// in the database to Solr. Documents of rows deleted from the database stay in
// Solr.
export const indexEverything = async (
  options: IndexEverythingOptions = {}
): Promise<IndexResult> => {
  const pool = createPool(poolConfig);
  try {
    const conn = await pool.getConnection();
    try {
      return await indexAll(conn, options);
    } finally {
      await conn.release();
    }
  } finally {
    await pool.end();
  }
};

export default class SQLStoreUpdater {
  storeConfig: StoreConfig;
  currentDate: Date;
  productsPool: Pool;
  pricePool: Pool;
  salePricePool: Pool;
  attributesPool: Pool;
  categoriesPool: Pool;
  manufacturersPool: Pool;
  result: StoreUpdateResult;
  // The documents of the products, categories, manufacturers and attributes
  // the scan saves, sent to Solr together
  solrProducts = new SolrUpdateBuffer('products', indexProducts);
  solrCategories = new SolrUpdateBuffer('categories', indexCategories);
  solrManufacturers = new SolrUpdateBuffer('manufacturers', indexManufacturers);
  solrAttributeGroups = new SolrUpdateBuffer(
    'attribute-groups',
    indexAttributeGroups
  );
  solrAttributes = new SolrUpdateBuffer('attributes', indexAttributes);

  constructor(
    storeConfig: StoreConfig,
    currentDate: Date,
    attributesPool: Pool,
    categoriesPool: Pool,
    manufacturersPool: Pool
  ) {
    this.storeConfig = storeConfig;
    this.currentDate = currentDate;
    this.productsPool = createPool(poolConfig);
    this.pricePool = createPool(poolConfig);
    this.salePricePool = createPool(poolConfig);
    this.attributesPool = attributesPool;
    this.categoriesPool = categoriesPool;
    this.manufacturersPool = manufacturersPool;
    this.result = {
      newProducts: 0,
      updatedProducts: 0,
      newPrices: 0,
      updatedPrices: 0,
      newSalePrices: 0,
      updatedSalePrices: 0,
      newAttributes: 0,
      newCategories: 0,
      updatedCategories: 0,
      newManufacturers: 0,
      updatedManufacturers: 0,
      newAttributeGroups: 0,
      newAttributesToProducts: 0,
      updatedAttributesToProducts: 0,
      deletedAttributesToProducts: 0,
      nameUpdates: 0,
      descriptionUpdates: 0,
      imageUpdates: 0,
      inStockUpdates: 0,
      gtinUpdates: 0,
      urlUpdates: 0
    };
  }

  // Sends the Solr documents still waiting, rejects when an update fails
  async flushSolr(): Promise<void> {
    await Promise.all([
      this.solrProducts.flush(),
      this.solrCategories.flush(),
      this.solrManufacturers.flush(),
      this.solrAttributeGroups.flush(),
      this.solrAttributes.flush()
    ]);
  }

  // Sends the Solr documents still waiting and ends the pools of this updater,
  // the shared pools stay open. A pool that is not ended keeps its connections
  // and timers, and so itself, alive forever. A failed update does not fail
  // the scan, the database has the products and a reindex sends them again.
  async close(): Promise<void> {
    try {
      await this.flushSolr();
    } catch (e) {
      log.error(
        'Sending the last documents of the scan to Solr failed, reindex to send them',
        e
      );
    }
    await Promise.all([
      this.productsPool.end(),
      this.pricePool.end(),
      this.salePricePool.end()
    ]);
  }

  async queryPool<T>(
    pool: Pool,
    query: (conn: PoolConnection) => Promise<T>
  ): Promise<T> {
    const conn = await pool.getConnection();
    let res;
    try {
      res = await query(conn);
    } finally {
      await conn.release();
    }
    return res;
  }

  async updateLastChangeDate(product: Product): Promise<void> {
    if (product.lastChangeDate < this.currentDate) {
      await this.queryPool(this.productsPool, async (productsConn) => {
        return await productsConn.query<UpsertResult>(
          'UPDATE products SET lastChangeDate = ? WHERE id = ?',
          [this.currentDate, product.id]
        );
      });
    }
  }

  async updateProductInDb(scrapedProduct: ProductSnapshot): Promise<void> {
    const existingProductResult = await this.queryPool(
      this.productsPool,
      async (productsConn) => this.upsertProduct(productsConn, scrapedProduct)
    );

    const existingProduct = existingProductResult.product;

    const promises = [];
    promises.push(
      this.queryPool(this.pricePool, async (priceConn) => {
        const priceResult = await this.upsertPrice(
          priceConn,
          existingProduct.id,
          scrapedProduct.price,
          'prices'
        );
        if (priceResult === 'newPrice') this.result.newPrices++;
        else if (priceResult === 'updatedPrice') this.result.updatedPrices++;
        return priceResult;
      })
    );
    if (
      scrapedProduct.salePrice !== undefined &&
      scrapedProduct.salePrice < scrapedProduct.price
    ) {
      const salePrice = scrapedProduct.salePrice;
      promises.push(
        this.queryPool(this.salePricePool, async (priceConn) => {
          const salePriceResult = await this.upsertPrice(
            priceConn,
            existingProduct.id,
            salePrice,
            'salePrices'
          );
          if (salePriceResult === 'newPrice') this.result.newSalePrices++;
          else if (salePriceResult === 'updatedPrice')
            this.result.updatedSalePrices++;
          return salePriceResult;
        })
      );
    }

    promises.push(
      this.queryPool(this.categoriesPool, async (categoriesConn) => {
        let categoryChanged = false;
        if (scrapedProduct.categories && scrapedProduct.categories.length > 0) {
          categoryChanged = await this.updateCategories(
            categoriesConn,
            existingProduct,
            scrapedProduct.categories
          );
        } else if (existingProduct.categoryId) {
          await categoriesConn.query(
            'UPDATE products SET categoryId = NULL WHERE id = ?',
            [existingProduct.id]
          );
          categoryChanged = true;
        }
        if (categoryChanged) {
          if (existingProduct.categoryId) this.result.updatedCategories++;
          else this.result.newCategories++;
        }
        return categoryChanged;
      })
    );

    promises.push(
      this.queryPool(this.manufacturersPool, async (manufacturersConn) => {
        let manufacturerChanged = false;
        if (scrapedProduct.brand) {
          manufacturerChanged = await this.updateManufacturer(
            manufacturersConn,
            existingProduct,
            scrapedProduct.brand
          );
        } else if (existingProduct.manufacturerId) {
          await manufacturersConn.query(
            'UPDATE products SET manufacturerId = NULL WHERE id = ?',
            [existingProduct.id]
          );
          manufacturerChanged = true;
        }
        if (manufacturerChanged) {
          if (existingProduct.manufacturerId)
            this.result.updatedManufacturers++;
          else this.result.newManufacturers++;
        }
        return manufacturerChanged;
      })
    );

    // The attribute values of the product after the upsert, for its Solr
    // document
    let attributeRows: AttributeToProduct[] | undefined;
    if (scrapedProduct.attributes && scrapedProduct.attributes.length > 0) {
      const attributes = scrapedProduct.attributes;
      promises.push(
        this.queryPool(this.attributesPool, async (attributesConn) => {
          const upserted = await this.upsertAttributes(
            attributesConn,
            existingProduct,
            attributes
          );
          attributeRows = upserted.rows;
          return upserted.changed;
        })
      );
    }

    const results = await Promise.all(promises);
    const anyUpdate = results.some((r) => r);
    if (
      existingProductResult.result === 'new' ||
      existingProductResult.result === 'updated' ||
      anyUpdate
    ) {
      const attributes =
        attributeRows ??
        (await this.queryPool(this.attributesPool, (attributesConn) =>
          getAttriButesToProducts(attributesConn, existingProduct)
        ));
      this.solrProducts.add(
        getSolrProduct(
          existingProduct,
          scrapedProduct.salePrice ?? scrapedProduct.price,
          attributes
        )
      );
    }
    //Update last changed date if there was a update and it hasn't been updated by product update logic already
    if (anyUpdate && !existingProductResult.result) {
      await this.updateLastChangeDate(existingProduct);
    }
  }

  async insertProduct(
    productsConn: PoolConnection,
    scrapedProduct: ProductSnapshot
  ): Promise<Product> {
    const res = await productsConn.query<UpsertResult>(
      'INSERT INTO products (storeId, sku, name, image, ean, description, url, inStock, firstSeenDate, lastChangeDate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        this.storeConfig.id,
        scrapedProduct.sku,
        scrapedProduct.title,
        scrapedProduct.image,
        scrapedProduct.gtin,
        scrapedProduct.description,
        scrapedProduct.url,
        scrapedProduct.inStock,
        this.currentDate,
        this.currentDate
      ]
    );
    this.result.newProducts++;
    return {
      id: res.insertId,
      storeId: this.storeConfig.id,
      sku: scrapedProduct.sku,
      name: scrapedProduct.title,
      image: scrapedProduct.image,
      ean: scrapedProduct.gtin,
      description: scrapedProduct.description,
      url: scrapedProduct.url,
      inStock: scrapedProduct.inStock,
      firstSeenDate: this.currentDate,
      lastChangeDate: this.currentDate
    };
  }

  async updateProduct(
    productsConn: PoolConnection,
    existingProduct: Product,
    scrapedProduct: ProductSnapshot
  ): Promise<{ product: Product; result?: 'updated' }> {
    const colsToUpdate = [];
    if (differs(scrapedProduct.title, existingProduct.name)) {
      colsToUpdate.push({ name: 'name', value: scrapedProduct.title });
      this.result.nameUpdates++;
    }
    if (differs(scrapedProduct.image, existingProduct.image)) {
      colsToUpdate.push({ name: 'image', value: scrapedProduct.image });
      this.result.imageUpdates++;
    }
    if (differs(scrapedProduct.gtin, existingProduct.ean)) {
      colsToUpdate.push({ name: 'ean', value: scrapedProduct.gtin });
      this.result.gtinUpdates++;
    }
    if (differs(scrapedProduct.description, existingProduct.description)) {
      colsToUpdate.push({
        name: 'description',
        value: scrapedProduct.description
      });
      this.result.descriptionUpdates++;
    }
    if (differs(scrapedProduct.url, existingProduct.url)) {
      colsToUpdate.push({ name: 'url', value: scrapedProduct.url });
      this.result.urlUpdates++;
    }
    if (differs(scrapedProduct.inStock, existingProduct.inStock)) {
      colsToUpdate.push({ name: 'inStock', value: scrapedProduct.inStock });
      this.result.inStockUpdates++;
    }
    if (colsToUpdate.length === 0)
      return { product: existingProduct, result: undefined };
    await productsConn.query(
      'UPDATE products SET ' +
        colsToUpdate.map((c) => `${c.name} = ?`).join(', ') +
        ', lastChangeDate = ? WHERE id = ?',
      [
        ...colsToUpdate.map((c) => c.value),
        this.currentDate,
        existingProduct.id
      ]
    );
    this.result.updatedProducts++;

    // if (
    //   scrapedProduct.title !== existingProduct.name ||
    //   scrapedProduct.image !== existingProduct.image ||
    //   scrapedProduct.gtin !== existingProduct.ean ||
    //   scrapedProduct.description !== existingProduct.description ||
    //   scrapedProduct.url !== existingProduct.url ||
    //   scrapedProduct.inStock !== existingProduct.inStock
    // ) {
    //   //TODO: optimise by only updating changed fields
    //   await productsConn.query(
    //     'UPDATE products SET name = ?, image = ?, ean = ?, description = ?, url = ?, inStock = ?, lastChangeDate = ? WHERE id = ?',
    //     [
    //       scrapedProduct.title,
    //       scrapedProduct.image,
    //       scrapedProduct.gtin,
    //       scrapedProduct.description,
    //       scrapedProduct.url,
    //       scrapedProduct.inStock,
    //       this.currentDate,
    //       existingProduct.id
    //     ]
    //   );
    existingProduct.name = scrapedProduct.title;
    existingProduct.image = scrapedProduct.image;
    existingProduct.ean = scrapedProduct.gtin;
    existingProduct.description = scrapedProduct.description;
    existingProduct.url = scrapedProduct.url;
    existingProduct.inStock = scrapedProduct.inStock;
    existingProduct.lastChangeDate = this.currentDate;
    // }
    return { product: existingProduct, result: 'updated' };
  }

  async upsertProduct(
    productsConn: PoolConnection,
    scrapedProduct: ProductSnapshot
  ): Promise<{ product: Product; result?: 'new' | 'updated' }> {
    const existingProduct = await productsConn
      .query<Product[]>(
        'SELECT * FROM products WHERE sku = ? AND storeId = ? LIMIT 1',
        [scrapedProduct.sku, this.storeConfig.id]
      )
      .then((res) => getFirstResult(res));
    if (existingProduct) {
      return await this.updateProduct(
        productsConn,
        toProduct(existingProduct),
        scrapedProduct
      );
    } else {
      return {
        product: await this.insertProduct(productsConn, scrapedProduct),
        result: 'new'
      };
    }
  }

  async upsertPrice(
    conn: PoolConnection,
    productId: DbId,
    newPrice: number,
    table: 'prices' | 'salePrices'
  ): Promise<'newPrice' | 'updatedPrice' | false> {
    const lastPrice = await getLatestPrice(conn, table, productId);
    if (
      lastPrice?.price !== newPrice ||
      this.storeConfig.lastScanDate > lastPrice.end
    ) {
      //If the scraped price is different from the last price or the product was not found during last scan, insert a new price entry
      await conn.query(
        `INSERT INTO ${table} (productId, price, start, end) VALUES (?, ?, ?, ?)`,
        [productId, newPrice, this.currentDate, this.currentDate]
      );
      return 'newPrice';
    } else if (
      lastPrice.price === newPrice &&
      lastPrice.end < this.currentDate
    ) {
      await conn.query(
        `UPDATE ${table} SET end = ? WHERE productId = ? AND start = ?`,
        [this.currentDate, productId, lastPrice.start]
      );
      return 'updatedPrice';
    }
    return false;
  }

  async assignProductToCategory(
    conn: PoolConnection,
    productId: DbId,
    categoryId: DbId
  ): Promise<void> {
    await conn.query('UPDATE products SET categoryId = ? WHERE id = ?', [
      categoryId,
      productId
    ]);
  }
  async upsertCategories(
    conn: PoolConnection,
    categories: string[]
  ): Promise<DbId> {
    let existingRootId = await conn
      .query<IdLookup[]>(
        'SELECT id FROM categories WHERE name = ? AND parentId IS NULL LIMIT 1',
        [categories[0]]
      )
      .then((res) => getFirstDbId(res));
    if (!existingRootId) {
      const res = await conn.query<UpsertResult>(
        'INSERT INTO categories (name) VALUES (?)',
        [categories[0]]
      );
      this.solrCategories.add({ id: res.insertId, name: categories[0] });
      existingRootId = res.insertId;
    }

    let parentId = existingRootId;
    for (let i = 1; i < categories.length; i++) {
      const existingCategoryId = await conn
        .query<IdLookup[]>(
          'SELECT id FROM categories WHERE name = ? AND parentId = ? LIMIT 1',
          [categories[i], parentId]
        )
        .then((res) => getFirstDbId(res));
      if (!existingCategoryId) {
        const res = await conn.query<UpsertResult>(
          'INSERT INTO categories (name, parentId) VALUES (?, ?)',
          [categories[i], parentId]
        );
        this.solrCategories.add({ id: res.insertId, name: categories[i] });
        parentId = res.insertId;
      } else {
        parentId = existingCategoryId;
      }
    }
    return parentId;
  }

  async updateCategories(
    conn: PoolConnection,
    product: Product,
    categories: string[]
  ): Promise<boolean> {
    const leafCategoryName = categories[categories.length - 1];
    const existingCategories = await conn.query<Category[]>(
      'SELECT id, parentId, name FROM categories WHERE name = ?',
      [leafCategoryName]
    );
    let match = false;
    for (const category of existingCategories) {
      let i = categories.length - 2;
      let currentCategory = category;
      while (i >= 0 && !match) {
        if (!currentCategory.parentId) {
          match = true;
          break;
        }
        const parent = await conn
          .query<Category[]>(
            'SELECT id, parentId FROM categories WHERE id = ? AND name = ? LIMIT 1',
            [currentCategory.parentId, categories[i]]
          )
          .then((res) => getFirstResult(res));
        if (parent) {
          i--;
          currentCategory = parent;
        } else match = true;
      }
      if (match) {
        if (category.id !== product.categoryId) {
          await this.assignProductToCategory(conn, product.id, category.id);
          return true;
        } else return false;
      }
    }
    if (!match) {
      const lastCategoryId = await this.upsertCategories(conn, categories);
      await this.assignProductToCategory(conn, product.id, lastCategoryId);
      return true;
    }
    return false;
  }

  async updateManufacturer(
    conn: PoolConnection,
    product: Product,
    manufacturer: string
  ): Promise<boolean> {
    let existingManufacturerId = await conn
      .query<IdLookup[]>(
        'SELECT id FROM manufacturers WHERE name = ? LIMIT 1',
        [manufacturer]
      )
      .then((res) => getFirstDbId(res));
    if (!existingManufacturerId) {
      const res = await conn.query<UpsertResult>(
        'INSERT INTO manufacturers (name) VALUES (?)',
        [manufacturer]
      );
      this.solrManufacturers.add({ id: res.insertId, name: manufacturer });
      existingManufacturerId = res.insertId;
    }
    if (existingManufacturerId !== product.manufacturerId) {
      await conn.query('UPDATE products SET manufacturerId = ? WHERE id = ?', [
        existingManufacturerId,
        product.id
      ]);
      return true;
    }
    return false;
  }

  async insertAttribute(
    conn: PoolConnection,
    attributeName: string,
    attributeGroupId?: DbId
  ): Promise<DbId> {
    const params: (string | DbId)[] = [attributeName];
    let insertQuery;
    if (attributeGroupId) {
      insertQuery = 'INSERT INTO attributes (name, groupId) VALUES (?, ?)';
      params.push(attributeGroupId);
    } else {
      insertQuery = 'INSERT INTO attributes (name) VALUES (?)';
    }

    const res = await conn.query<UpsertResult>(insertQuery, params);
    return res.insertId;
  }

  async selectAttributeId(
    conn: PoolConnection,
    attributeName: string,
    attributeGroupId?: DbId
  ): Promise<DbId | undefined> {
    let query = 'SELECT id FROM attributes WHERE name = ?';
    const params: (string | DbId)[] = [attributeName];
    if (attributeGroupId) {
      query += ' AND groupId = ?';
      params.push(attributeGroupId);
    } else {
      query += ' AND groupId IS NULL';
    }
    query += ' LIMIT 1';
    return await conn
      .query<IdLookup[]>(query, params)
      .then((res) => getFirstDbId(res));
  }

  // Saves the scraped attribute values of the product. Returns whether any
  // changed and the values the product has now.
  async upsertAttributes(
    conn: PoolConnection,
    product: Product,
    attributes: ProductAttributeGroup[]
  ): Promise<{ changed: boolean; rows: AttributeToProduct[] }> {
    const existingAttributeToProduct = await conn.query<AttributeToProduct[]>(
      'SELECT * FROM attributeToProducts WHERE productId = ?',
      [product.id]
    );

    let attributesChanged = false;
    //TODO: dont create a group for óflokkað

    for (const attributeGroup of attributes) {
      let existingAttributeGroupId: DbId | undefined = undefined;
      if (attributeGroup.name) {
        existingAttributeGroupId = await conn
          .query<IdLookup[]>(
            'SELECT id FROM attributeGroups WHERE name = ? LIMIT 1',
            [attributeGroup.name]
          )
          .then((res) => getFirstDbId(res));

        if (!existingAttributeGroupId) {
          const res = await conn.query<UpsertResult>(
            'INSERT INTO attributeGroups (name) VALUES (?)',
            [attributeGroup.name]
          );
          existingAttributeGroupId = res.insertId;
          this.result.newAttributeGroups++;
          this.solrAttributeGroups.add({
            id: res.insertId,
            name: attributeGroup.name
          });
        }
      }

      for (const attribute of attributeGroup.attributes) {
        try {
          let existingAttributeId = await this.selectAttributeId(
            conn,
            attribute.name,
            existingAttributeGroupId
          );
          if (!existingAttributeId) {
            existingAttributeId = await this.insertAttribute(
              conn,
              attribute.name,
              existingAttributeGroupId
            );
            this.result.newAttributes++;
            this.solrAttributes.add({
              id: existingAttributeId,
              name: attribute.name,
              groupId: existingAttributeGroupId
            });
          }
          // The column is text, a value is read back as a string
          const value = String(attribute.value);
          const existingAttributeToProductEntry =
            existingAttributeToProduct.find(
              (a) => a.attributeId === existingAttributeId
            );
          if (!existingAttributeToProductEntry) {
            await conn.query(
              'INSERT INTO attributeToProducts (attributeId, productId, value) VALUES (?, ?, ?)',
              [existingAttributeId, product.id, value]
            );
            existingAttributeToProduct.push({
              attributeId: existingAttributeId,
              productId: product.id,
              value
            });
            attributesChanged = true;
            this.result.newAttributesToProducts++;
          } else if (existingAttributeToProductEntry.value !== value) {
            await conn.query(
              'UPDATE attributeToProducts SET value = ? WHERE attributeId = ? AND productId = ?',
              [value, existingAttributeId, product.id]
            );
            existingAttributeToProductEntry.value = value;
            attributesChanged = true;
            this.result.updatedAttributesToProducts++;
          }
        } catch (e) {
          log.error(
            `Error upserting attribute ${attributeGroup.name} / ${attribute.name} = ${attribute.value} for product ${product.id}`,
            e
          );
        }
      }
      //TODO: delete attributeToProduct entries that are not present in scraped data anymore
    }
    return { changed: attributesChanged, rows: existingAttributeToProduct };
  }
}
