import {
  Attribute,
  AttributeGroup,
  AttributeToProduct,
  Category,
  DbId,
  Manufacturer,
  Product
} from './types/db-types.js';
import { logger } from './logger.js';

// Every product the scraper saves is indexed, so these are debug logs
const log = logger.child({ label: 'Solr' });

interface SolrResponse {
  responseHeader: {
    status: number;
    QTime: number;
  };
}

export type SolrProduct = Omit<Product, 'firstSeenDate' | 'lastChangeDate'> & {
  price?: number;
  // Solr doesn't support Date objects, so we convert to string
  firstSeenDate: string;
  lastChangeDate: string;
  // Ids of the attributes below, faceted by the advanced search
  attrIds?: DbId[];
  [key: `attr_${string}`]: string | undefined;
};

// Without a trailing slash, Solr answers 400 to a double slash in the path
const SOLR_URL = (process.env.SOLR_URL ?? 'http://localhost:8983/solr').replace(
  /\/+$/,
  ''
);

const submitUpdate = async (
  core: string,
  data:
    SolrProduct[] | Manufacturer[] | Category[] | AttributeGroup[] | Attribute[]
): Promise<SolrResponse> => {
  // No commit, the autoSoftCommit in solrconfig.xml makes the documents
  // searchable. A commit per update opens a new searcher every time.
  const url = `${SOLR_URL}/${core}/update`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    // The replacer gets the key first, returning it would send "" as the body
    body: JSON.stringify(data, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  });
  if (!response.ok) {
    log.error(
      `Updating Solr core ${core} failed with ${response.status}: ${await response.text()}`
    );
    throw new Error(`Failed to submit update: ${response.statusText}`);
  }
  return (await response.json()) as SolrResponse;
};
export const getSolrProduct = (
  product: Product,
  price?: number,
  attributes?: AttributeToProduct[]
): SolrProduct => {
  const solrProduct: SolrProduct = {
    ...product,
    firstSeenDate: product.firstSeenDate.toISOString(),
    lastChangeDate: product.lastChangeDate.toISOString()
  };
  if (price !== undefined) {
    solrProduct.price = price;
  }
  if (attributes !== undefined) {
    solrProduct.attrIds = attributes.map((attribute) => attribute.attributeId);
    for (const attribute of attributes) {
      solrProduct[`attr_${attribute.attributeId}`] = attribute.value;
    }
  }
  return solrProduct;
};

export const indexProduct = async (
  product: Product,
  price?: number,
  attributes?: AttributeToProduct[]
): Promise<void> => {
  const solrProduct = getSolrProduct(product, price, attributes);
  await submitUpdate('products', [solrProduct]);
  log.debug(`Indexed product ${product.sku}`);
};
export const indexProducts = async (products: SolrProduct[]): Promise<void> => {
  await submitUpdate('products', products);
  log.debug(`Indexed ${products.length} products`);
};
export const indexManufacturer = async (
  manufacturer: Manufacturer
): Promise<void> => {
  await submitUpdate('manufacturers', [manufacturer]);
  log.debug(`Indexed manufacturer ${manufacturer.name}`);
};
export const indexManufacturers = async (
  manufacturers: Manufacturer[]
): Promise<void> => {
  await submitUpdate('manufacturers', manufacturers);
  log.debug(`Indexed ${manufacturers.length} manufacturers`);
};
export const indexCategory = async (category: Category): Promise<void> => {
  await submitUpdate('categories', [category]);
  log.debug(`Indexed category ${category.name}`);
};
export const indexCategories = async (
  categories: Category[]
): Promise<void> => {
  await submitUpdate('categories', categories);
  log.debug(`Indexed ${categories.length} categories`);
};
export const indexAttributeGroup = async (
  attributeGroup: AttributeGroup
): Promise<void> => {
  await submitUpdate('attribute-groups', [attributeGroup]);
  log.debug(`Indexed attribute group ${attributeGroup.name}`);
};
export const indexAttributeGroups = async (
  attributeGroups: AttributeGroup[]
): Promise<void> => {
  await submitUpdate('attribute-groups', attributeGroups);
  log.debug(`Indexed ${attributeGroups.length} attribute groups`);
};
export const indexAttribute = async (attribute: Attribute): Promise<void> => {
  await submitUpdate('attributes', [attribute]);
  log.debug(`Indexed attribute ${attribute.name}`);
};
export const indexAttributes = async (
  attributes: Attribute[]
): Promise<void> => {
  await submitUpdate('attributes', attributes);
  log.debug(`Indexed ${attributes.length} attributes`);
};

// Documents sent to Solr in one update
export const SOLR_CHUNK_SIZE = 100;
// How long a document waits for more before its update is sent
const SOLR_FLUSH_INTERVAL_MS = 5000;

// Collects the documents of one core and sends them in updates of up to
// SOLR_CHUNK_SIZE, when that many are waiting or SOLR_FLUSH_INTERVAL_MS after
// the first one, instead of one update per document. The documents of a
// failed update are sent again with the next one.
export class SolrUpdateBuffer<T> {
  private docs: T[] = [];
  private timer?: NodeJS.Timeout;
  private sending: Promise<void> = Promise.resolve();
  // A background flush is waiting for the update being sent
  private flushQueued = false;

  constructor(
    private readonly core: string,
    private readonly submit: (docs: T[]) => Promise<void>
  ) {}

  add(doc: T): void {
    this.docs.push(doc);
    if (this.docs.length >= SOLR_CHUNK_SIZE) this.flushInBackground();
    else if (!this.timer) {
      this.timer = setTimeout(
        () => this.flushInBackground(),
        SOLR_FLUSH_INTERVAL_MS
      );
      // A waiting update does not keep the process alive
      this.timer.unref();
    }
  }

  private flushInBackground(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    this.flush().catch((e: unknown) =>
      log.warn(
        `Updating Solr core ${this.core} failed, ${this.docs.length} documents are sent again with the next update`,
        e
      )
    );
  }

  // Sends the waiting documents, after the update already being sent.
  // Rejects when an update fails, its documents stay waiting.
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const flushed = this.sending
      .catch(() => undefined)
      .then(async () => {
        this.flushQueued = false;
        const docs = this.docs;
        this.docs = [];
        for (let i = 0; i < docs.length; i += SOLR_CHUNK_SIZE) {
          try {
            await this.submit(docs.slice(i, i + SOLR_CHUNK_SIZE));
          } catch (e) {
            // Before the documents added while it was sent, a later version
            // of a document replaces the earlier one
            this.docs = [...docs.slice(i), ...this.docs];
            throw e;
          }
        }
      });
    this.sending = flushed;
    return flushed;
  }
}
