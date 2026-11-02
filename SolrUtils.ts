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
  const url = `${SOLR_URL}/${core}/update?commit=true`;
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
