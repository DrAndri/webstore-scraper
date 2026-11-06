import { ProductFeed } from '../types/index.js';

const placeholder = /\{(\w+)(?::(\d+))?\}/g;

const getPath = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .filter((key) => key !== '')
    .reduce<unknown>((current, key) => {
      // ASP.NET script services wrap their result as a JSON string in "d"
      const parsed: unknown =
        typeof current === 'string' ? JSON.parse(current) : current;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)[key]
        : undefined;
    }, value);

// Fills the {field} placeholders of the productUrl template with the fields of
// an item, undefined when the item misses one of them
export const productUrlOf = (template: string, item: unknown) => {
  let missing = false;
  const url = template.replace(
    placeholder,
    (match, field: string, length?: string) => {
      const value = getPath(item, field);
      if (typeof value !== 'string' && typeof value !== 'number') {
        missing = true;
        return match;
      }
      const text = String(value);
      return length ? text.padStart(parseInt(length), '0') : text;
    }
  );
  return missing ? undefined : url;
};

// Returns the absolute product page urls of the items in the feed
export const fetchProductFeedUrls = async (
  feed: ProductFeed,
  baseUrl: string
): Promise<string[]> => {
  const response = await fetch(new URL(feed.url, baseUrl), {
    // ASP.NET script services only answer requests that say they are JSON
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
  if (!response.ok)
    throw new Error(
      `Product feed ${feed.url} returned ${response.status} ${response.statusText}`
    );
  const items = getPath(await response.json(), feed.items);
  if (!Array.isArray(items))
    throw new Error(`Product feed ${feed.url} has no list at ${feed.items}`);
  const urls = items
    .map((item) => productUrlOf(feed.productUrl, item))
    .filter((url) => url !== undefined)
    .map((url) => new URL(url, baseUrl).href);
  if (urls.length === 0)
    throw new Error(`Product feed ${feed.url} has no product urls`);
  return urls;
};
