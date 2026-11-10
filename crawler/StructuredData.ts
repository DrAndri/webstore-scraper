import { CheerioAPI } from 'crawlee';
import {
  StructuredDataField,
  StructuredDataOptions
} from '../types/db-types.js';

export interface StructuredProduct {
  sku?: string;
  gtin?: string;
  name?: string;
  brand?: string;
  image?: string;
  description?: string;
  price?: number;
  inStock?: boolean;
  categories?: string[];
}

// schema.org Product paths used when a jsonld field is not configured
const jsonLdDefaults: Record<StructuredDataField, string[]> = {
  sku: ['sku'],
  gtin: ['gtin13', 'gtin', 'gtin14', 'gtin12', 'gtin8'],
  name: ['name'],
  brand: ['brand'],
  image: ['image'],
  description: ['description'],
  price: ['offers.price', 'offers.lowPrice', 'offers.priceSpecification.price'],
  inStock: ['offers.availability'],
  categories: []
};

const inStockAvailability = /InStock|LimitedAvailability|OnlineOnly/i;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Arrays are stepped into at their first element unless the key is an index
export const getPath = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((value, key) => {
    if (Array.isArray(value) && !/^\d+$/.test(key)) value = value[0];
    if (value === null || typeof value !== 'object') return undefined;
    return (value as Json)[key];
  }, root);

export const toText = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return toText(value[0]);
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  // An empty name is skipped, e.g. an ImageObject with "name": "" and a url
  if (isObject(value))
    return toText(value.name) ?? toText(value.title) ?? toText(value.url);
  return undefined;
};

const toPrice = (value: unknown): number | undefined => {
  if (Array.isArray(value)) return toPrice(value[0]);
  if (typeof value === 'number') return Math.round(value);
  if (typeof value !== 'string') return undefined;
  const number = Number(value);
  if (Number.isFinite(number)) return Math.round(number);
  const digits = parseInt(value.replace(/\D/g, ''));
  return Number.isNaN(digits) ? undefined : digits;
};

const toInStock = (value: unknown): boolean | undefined => {
  if (Array.isArray(value)) return toInStock(value[0]);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') return inStockAvailability.test(value);
  return undefined;
};

const toList = (value: unknown, splitter?: string): string[] | undefined => {
  if (Array.isArray(value)) {
    const list = value.map(toText).filter((v) => v !== undefined);
    return list.length > 0 ? list : undefined;
  }
  const text = toText(value);
  if (text === undefined) return undefined;
  return splitter ? text.split(splitter) : [text];
};

const hasType = (item: unknown, type: string) =>
  isObject(item) && ([] as unknown[]).concat(item['@type']).includes(type);

const flattenJsonLd = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (isObject(value) && Array.isArray(value['@graph']))
    return flattenJsonLd(value['@graph']);
  return [value];
};

const readJsonLd = ($: CheerioAPI) => {
  const items = $('script[type="application/ld+json"]')
    .toArray()
    .flatMap((script) => {
      try {
        return flattenJsonLd(JSON.parse($(script).text()));
      } catch {
        return [];
      }
    });
  const product =
    items.find((item) => hasType(item, 'Product')) ??
    items.find((item) => hasType(item, 'ProductGroup'));
  return { root: product, items };
};

const readNextData = ($: CheerioAPI) => {
  const script = $('script#__NEXT_DATA__').text();
  const items: unknown[] = [];
  try {
    return {
      root: script ? (JSON.parse(script) as unknown) : undefined,
      items
    };
  } catch {
    return { root: undefined, items };
  }
};

const pathOf = (url: unknown, base: string) => {
  try {
    return new URL(String(url), base).pathname.replace(/\/$/, '');
  } catch {
    return undefined;
  }
};

const breadcrumbs = (items: unknown[], pageUrl: string) => {
  const list = items.find((item) => hasType(item, 'BreadcrumbList'));
  if (!isObject(list) || !Array.isArray(list.itemListElement)) return undefined;
  const elements = (list.itemListElement as unknown[])
    .filter(isObject)
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
  // The last crumb is usually the product page itself
  const last = elements[elements.length - 1];
  const lastItem = isObject(last?.item) ? last.item['@id'] : last?.item;
  if (
    last &&
    (!lastItem || pathOf(lastItem, pageUrl) === pathOf(pageUrl, pageUrl))
  )
    elements.pop();
  return elements.map((element) => toText(element.name ?? element.item));
};

export const extractStructuredProduct = (
  $: CheerioAPI,
  options: StructuredDataOptions,
  pageUrl: string
): StructuredProduct | undefined => {
  const { root, items } =
    options.source === 'jsonld' ? readJsonLd($) : readNextData($);
  if (root === undefined) return undefined;

  const read = (field: StructuredDataField): unknown => {
    const configured = options.fields?.[field];
    if (configured === false) return undefined;
    const paths =
      configured !== undefined
        ? ([] as string[]).concat(configured)
        : options.source === 'jsonld'
          ? jsonLdDefaults[field]
          : [];
    for (const path of paths) {
      const value =
        path === 'breadcrumbs'
          ? breadcrumbs(items, pageUrl)
          : getPath(root, path);
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  };

  return {
    sku: toText(read('sku')),
    gtin: toText(read('gtin')),
    name: toText(read('name')),
    brand: toText(read('brand')),
    image: toText(read('image')),
    description: toText(read('description')),
    price: toPrice(read('price')),
    inStock: toInStock(read('inStock')),
    categories: toList(read('categories'), options.categorySplitter)
  };
};
