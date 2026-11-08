import { ProductFeed } from '../types/index.js';

const placeholder = /\{(\w+)(?::(\d+))?\}/g;
const pagePlaceholder = '{page}';
const fetchAttempts = 3;

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

// Fills the {field} placeholders of a template with the fields of an item,
// undefined when the item misses one of them. The placeholders named in keep
// are left as they are.
export const fillTemplate = (
  template: string,
  item: unknown,
  keep: string[] = []
) => {
  let missing = false;
  const url = template.replace(
    placeholder,
    (match, field: string, length?: string) => {
      if (keep.includes(field)) return match;
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

const fetchJson = async (url: URL): Promise<unknown> => {
  // The feed of a store can take hundreds of requests, a failed one is retried
  // before it fails the scan
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        // ASP.NET script services only answer requests that say they are JSON
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=utf-8'
        }
      });
      if (!response.ok)
        throw new Error(
          `Product feed ${url.href} returned ${response.status} ${response.statusText}`
        );
      return await response.json();
    } catch (e) {
      if (attempt >= fetchAttempts) throw e;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
};

// The list at path in the response of url
const listAt = (json: unknown, path: string, url: string): unknown[] => {
  const items = getPath(json, path);
  if (!Array.isArray(items))
    throw new Error(`Product feed ${url} has no list at ${path}`);
  return items as unknown[];
};

const fetchList = async (url: string, path: string, baseUrl: string) =>
  listAt(await fetchJson(new URL(url, baseUrl)), path, url);

// Returns the items of every page of the feed at url
const fetchFeedItems = async (
  feed: ProductFeed,
  url: string,
  baseUrl: string
): Promise<unknown[]> => {
  const { pageCount } = feed;
  if (pageCount === undefined) return fetchList(url, feed.items, baseUrl);

  const items: unknown[] = [];
  let lastPage = 1;
  for (let page = 1; page <= lastPage; page++) {
    const pageUrl = url.replaceAll(pagePlaceholder, String(page));
    const json = await fetchJson(new URL(pageUrl, baseUrl));
    items.push(...listAt(json, feed.items, pageUrl));
    const count = getPath(json, pageCount);
    if (typeof count !== 'number')
      throw new Error(`Product feed ${pageUrl} has no number at ${pageCount}`);
    lastPage = count;
  }
  return items;
};

// Returns the absolute product page urls of the items in the feed
export const fetchProductFeedUrls = async (
  feed: ProductFeed,
  baseUrl: string
): Promise<string[]> => {
  if (feed.pageCount !== undefined && !feed.url.includes(pagePlaceholder))
    throw new Error(
      `Product feed ${feed.url} has a pageCount but no ${pagePlaceholder}`
    );

  let feedUrls = [feed.url];
  if (feed.feedList) {
    const { url, items = '' } = feed.feedList;
    feedUrls = (await fetchList(url, items, baseUrl))
      .map((item) => fillTemplate(feed.url, item, ['page']))
      .filter((url) => url !== undefined);
    if (feedUrls.length === 0)
      throw new Error(`Product feed list ${url} has no feeds`);
  }

  const urls = new Set<string>();
  // One feed at a time, to not flood the store with requests
  for (const feedUrl of feedUrls) {
    for (const item of await fetchFeedItems(feed, feedUrl, baseUrl)) {
      const url = fillTemplate(feed.productUrl, item);
      // A product can be listed in several feeds, e.g. several categories
      if (url !== undefined) urls.add(new URL(url, baseUrl).href);
    }
  }
  if (urls.size === 0)
    throw new Error(`Product feed ${feed.url} has no product urls`);
  return [...urls];
};
