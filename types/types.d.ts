export interface ProductScrapeResult {
  product: ProductSnapshot;
  errors: ProductScrapeErrors;
}

export interface ProductScrapeErrors {
  description: unknown;
  attributes: unknown;
  image: unknown;
  brand: unknown;
  name: unknown;
  inStock: unknown;
  categories: unknown;
}

export interface ScrapeResult {
  totalRequests: number;
  totalProcessed: number;
  totalErrored: number;
  descriptionError: number;
  attributeError: number;
  imageError: number;
  brandError: number;
  nameError: number;
  inStockError: number;
  categoriesError: number;
}

export interface ProductSnapshot {
  sku: string;
  price: number;
  title?: string;
  brand?: string;
  gtin?: string;
  salePrice?: number;
  image?: string;
  description?: string;
  inStock?: boolean;
  attributes?: ProductAttributeGroup[];
  url?: string;
  categories?: string[];
}

export interface ProductAttributeGroup {
  name?: string;
  attributes: ProductAttribute[];
}

export interface ProductAttribute {
  name: string;
  value: string | number | boolean;
}

export interface StoreUpdateResult {
  newProducts: number;
  updatedProducts: number;
  newPrices: number;
  updatedPrices: number;
  newSalePrices: number;
  updatedSalePrices: number;
  newAttributes: number;
  newAttributeGroups: number;
  newAttributesToProducts: number;
  updatedAttributesToProducts: number;
  deletedAttributesToProducts: number;
  newCategories: number;
  updatedCategories: number;
  newManufacturers: number;
  updatedManufacturers: number;

  nameUpdates: number;
  descriptionUpdates: number;
  imageUpdates: number;
  inStockUpdates: number;
  gtinUpdates: number;
  urlUpdates: number;
}

export interface UpsertManyResult {
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
}

export interface CacheItem {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  expires: number;
}

export type CacheItems = Record<string, CacheItem>;

export type ScrapeJobMode = 'crawler' | 'list' | 'test' | 'index';
export type ScrapeJobSource = 'cron' | 'manual' | 'startup';
export type ScheduledMode = Exclude<ScrapeJobMode, 'test' | 'index'>;

export interface ScrapeJob {
  id: number;
  storeId: number | null;
  mode: ScrapeJobMode;
  source: ScrapeJobSource;
  testUrl: string | null;
  testConfig: string | object | null;
}

// Result of a test job, scraping a single url without writing to the database
export interface TestResult {
  isProductPage?: boolean;
  product?: ProductSnapshot;
  fieldErrors?: Partial<Record<keyof ProductScrapeErrors, string>>;
  error?: string;
}

// Lets a test job see what the crawler did with a page
export interface PageListener {
  onProductScraped(result: ProductScrapeResult): void;
  onProductError(error: unknown): void;
  onNotProductPage(): void;
  onRequestFailed(errorMessages: string[]): void;
}
