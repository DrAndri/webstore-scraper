# Store configs

Each store has a config in `stores/<storeId>.jsonc` (JSON with comments). The
type is `WebshopCrawlerOptions` in [types/db-types.d.ts](../types/db-types.d.ts).
A config has two halves: which pages the crawler visits, and how it recognises
a product page and reads the fields from it.

The admin interface in
[webstore-api](https://github.com/DrAndri/webstore-api) edits the configs and
validates them fully (`utils/admin/storeConfig.ts`). The scraper only checks the
required settings (`validateStoreConfig` in
[StoreConfigLoader.ts](../StoreConfigLoader.ts)).

## How a scan uses the config

- **`crawler` mode** (full crawl): starts from `startUrl`, `startUrls`,
  `sitemapUrls` and the product feed. On every page the links (and sitemap
  `<loc>` entries) are collected, filtered and queued.
- **`list` mode**: re-scrapes only the urls of the products seen in the last
  scan of the store. No links are followed and the product feed is not read.
- **`test` mode**: scrapes one url with a draft config, saves nothing.

On every page the crawler decides whether it is a product page, and if so reads
the fields. Fixed for every store ([BaseCrawler.ts](../crawler/BaseCrawler.ts)):
3 retries and a shared list of category names to ignore (`categoryBanList` in
[constants.ts](../crawler/constants.ts)). Pages are requested at 60 a minute
unless `maxRequestsPerMinute` is set.

## Required settings

| Setting                 | Does                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storeId`               | Must match the file name, `11.jsonc` → `11`                                                                                                                        |
| `type`                  | `httpcrawler`: downloads the HTML and parses it with Cheerio, fast. `crawler`: opens every page in Playwright, for content that only appears after JavaScript runs |
| `startUrl`              | Where the crawl starts. Also sets the hostname, only links on the same host are followed (with or without `www.`), and product urls are saved relative to it       |
| `productPageIdentifier` | Text that must be in the page source for the page to count as a product page, e.g. `"@type":"Product"`                                                             |
| `selectors.productPage` | CSS selector of the product element, which must exist. Every other CSS selector is searched inside it                                                              |

## Finding pages

| Setting           | Does                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `urlWhitelist`    | Only follow links whose path starts with one of these                                                 |
| `urlBlacklist`    | Never follow links whose path starts with one of these                                                |
| `keepQueryParams` | Strip the query parameters of followed links except these. `[]` strips them all, unset keeps them all |
| `startUrls`       | More pages to start from, e.g. a listing with a larger page size                                      |
| `sitemapUrls`     | Sitemaps whose `<loc>` urls are queued                                                                |
| `productFeed`     | A JSON endpoint listing the products, read before the crawl, see [Product feed](#product-feed)        |

`maxRequestsPerMinute` sets how many pages a minute a scan of the store
requests, 60 when unset, a whole number from 1 to 600. It is the limit on how
fast a scan goes: at 60 a store with 20,000 products and its category pages
takes more than six hours, in `list` mode too. Raise it only for a site that
handles it, and lower it for a site that answers with 429 or 503 or whose
robots.txt has a `Crawl-delay` (a delay of 3 s is 20 a minute).

Before relying on a sitemap, check that it is current: a sitemap can be a copy
frozen years ago, without the new products and with removed ones. Sitemap urls
on another host than `startUrl` are dropped like any other link, so when a site
answers on two domains, use the one its sitemap lists. An infinite scroll
listing (`scrollPagesToBottom`) can stop loading before its end, so compare the
count reached with the count the site shows, and add smaller listings
(categories) to `startUrls`.

Links are filtered in this order (`filterAndAddLinksToQueue` in
[BaseCrawler.ts](../crawler/BaseCrawler.ts)): same host → not a file (`.pdf`,
`.jpg`, …) → whitelist → blacklist → `keepQueryParams`. The start pages,
sitemap urls and feed urls themselves are not filtered, the links found on them
are.

Look at the query parameters on the product links of a listing. A parameter
naming the listing (Jysk's `?PathId=<category>`) queues each product once per
listing it is in. It can also change the page: Jysk shows the breadcrumb of
the listing the link came from, so a product found under a sale listing got the
sale category. Strip such parameters with `keepQueryParams`, but keep any that
pagination needs.

## Reading the fields

Each field comes from structured data first, if it is set up and has a value,
then from the CSS selector. Code: [PageHtmlScraper.ts](../crawler/PageHtmlScraper.ts)
(`httpcrawler`), [PageScraper.ts](../crawler/PageScraper.ts) (`crawler`),
[BaseScraper.ts](../crawler/BaseScraper.ts) (shared).

| Field       | CSS selector                                               | Notes                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SKU         | `sku`                                                      | **Required**, the product fails without it. A selector, or an object with `source`: `url` (split the url by `delimiter`, take part `index`: a number, `first` or `last`), `attribute` (read `attribute` of `selector`, e.g. `data-productid`), `json` (read dot `path` from the JSON text of `selector`, which is searched in the whole page) |
| Price       | `listPrice`                                                | **Required**, the product fails without it, and so does a price of 0. See [Reading prices](#reading-prices)                                                                                                                                                                                                                                   |
| Old price   | `oldPrice`                                                 | Always CSS. When found it becomes the list price, and `listPrice` the sale price. With `httpcrawler`, when only the old price is found it is saved as the price                                                                                                                                                                               |
| Name        | `name`                                                     |                                                                                                                                                                                                                                                                                                                                               |
| Brand       | `brand`                                                    |                                                                                                                                                                                                                                                                                                                                               |
| Image       | `image` + `imageAttribute`                                 | Reads `src` unless `imageAttribute` is set, e.g. `data-src` for lazy loaded images                                                                                                                                                                                                                                                            |
| Description | `description`                                              | The inner HTML, cleaned with sanitize-html                                                                                                                                                                                                                                                                                                    |
| In stock    | `inStock` + `inStockText`                                  | In stock when an element matching `inStock` contains the text                                                                                                                                                                                                                                                                                 |
| Categories  | `categories` + `categoryItemLocator` or `categorySplitter` | One category per `categoryItemLocator` element, or the text of `categories` split by `categorySplitter`. Banned names, the product name and duplicates are dropped                                                                                                                                                                            |
| Attributes  | `attributes.*`                                             | See [Attributes](#attributes)                                                                                                                                                                                                                                                                                                                 |
| GTIN        | none                                                       | Only from structured data                                                                                                                                                                                                                                                                                                                     |

A failing field other than SKU or price is logged and counted, and the product
is saved without it.

### Reading prices

The two crawler types read a price element differently:

- `httpcrawler` joins every digit in the element's text, its children
  included: `1.299 kr.` → 1299. Decimals break it, and so does anything else
  inside the element, a unit (`3.488 <span>kr. / m2</span>` → 34882), a nested
  old price, or both ends of a range (`6.999 – 17.999 kr.`). Select the
  element holding only the price, e.g. the first `.amount` of a WooCommerce
  range. JSON-LD prices are read as numbers and are not affected.
- `crawler` reads the element's own text when it has digits, so
  `<div>29.750 kr<del>42.500 kr</del></div>` gives 29750, and takes the low
  end of a range (`34.998 - 41.997`).

A product whose price is on request (0 kr, or no price block) fails with
"Price not found". When such pages lack something every priced page has, use
that as `productPageIdentifier` so they count as pages without a product.

### Structured data

`selectors.structuredData`, only with `httpcrawler`
([StructuredData.ts](../crawler/StructuredData.ts)):

- `source: "jsonld"`: the schema.org `Product` (or `ProductGroup`) in
  `<script type="application/ld+json">`, `@graph` included. Default paths are
  used for every field except categories: `sku`, `gtin13`/`gtin`/…, `name`,
  `brand`, `image`, `description`, `offers.price`/`offers.lowPrice`/…,
  `offers.availability`.
- `source: "nextdata"`: the JSON in `<script id="__NEXT_DATA__">`. No default
  paths, every field must be given in `fields`, relative to the root.
- `fields`: a dot path, or a list of paths where the first one with a value
  wins. Arrays are stepped into at their first element unless the key is an
  index. `false` skips structured data for the field so the CSS selector is
  used. For categories the path `"breadcrumbs"` reads a JSON-LD
  `BreadcrumbList`, without its last crumb when that is the page itself.
- `categorySplitter`: splits a categories string, e.g. `"Snyrtivara|Förðun"`.

Structured data is read from the whole page, not only `productPage`.

- A structured value wins over the CSS selector, the SKU too: a `sku`
  selector is ignored while the JSON-LD has a `sku`. Set `fields.sku: false`
  (or any other field) to use the CSS selector instead.
- The first `Product` and the first `BreadcrumbList` in the page are used. On
  WordPress the SEO plugin's list (Yoast, All in One SEO) usually comes first
  and is only Home › Shop › product, so `"breadcrumbs"` gives no categories
  there. Read the page's own breadcrumbs with CSS instead.
- Check the JSON-LD against the page, it is often wrong: availability always
  `BackOrder` or `OutOfStock`, a brand that is an option id, a price without
  VAT, a `lowPrice` of 0 or below, names and descriptions HTML escaped twice
  (`C&amp;amp;R`), an `image` that is only an `{"@id"}` reference (the field is
  then empty and the CSS `image` is used). Turn such fields off with `false`.
- `offers` can be a list of every variant (Shopify), and the defaults read the
  first one, which may be sold out while others are not.
- Shopify writes a product with variants as a `ProductGroup` with the variants
  in `hasVariant` and no `sku`, `offers` or `image` of its own. Paths that
  work: `sku: ["sku", "productGroupID"]`, `image: ["image", "hasVariant.image"]`,
  `inStock: ["offers.availability", "hasVariant.offers.availability"]`.

### Attributes

Specification tables, `selectors.attributes`:

- Required together: `attributesTable`, `attribute` (one row), and inside the
  row `attributeLabel` and `attributeValue`.
- Optional: `attributeGroup` and `attributeGroupName`, for tables split into
  named sections. Without `attributeGroup` the table is one unnamed group.
- A trailing colon is removed from labels, `Litur:` is `Litur`.
- Attributes are deduplicated by group and name, ignoring case: groups with
  the same name (from several tables, or a table shown twice) are merged, and
  the first value of a repeated attribute name in a group is kept. An empty
  group name is the same as no group.

### Other selectors

- `sanitizers.sku`: rewrites the SKU, a list of `{ match, replace }`. `match` is
  plain text, not a regex, and only its first occurrence is replaced. A SKU
  shorter than 2 characters is rejected.
- `selectors.clickers` (`crawler` only): elements clicked before the fields are
  read, e.g. a "Specifications" tab.

## Settings for `type: "crawler"` only

| Setting               | Does                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `scrollPagesToBottom` | Scrolls listing pages to the bottom so more products load (infinite scroll) |
| `menuClicker`         | Clicked on the start page, e.g. to open a menu holding the category links   |
| `selectors.clickers`  | See above                                                                   |

## Product feed

For stores whose listings load products with JavaScript, e.g. from an API on
another host. Read once before a full crawl, the product page of each item is
queued ([ProductFeed.ts](../crawler/ProductFeed.ts)). A feed that fails fails the
scan, each request is tried 3 times.

| Field        | Does                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`        | Feed url, absolute or relative to `startUrl`                                                                                                            |
| `items`      | Dot path to the list of products, e.g. `d.data`. A JSON string on the way is parsed (ASP.NET script services)                                           |
| `productUrl` | Product page template, `{field}` is replaced with that field of the item, `{field:5}` pads it with zeros to 5 characters                                |
| `pageCount`  | Paged feed: dot path to the number of pages. `{page}` in `url` is replaced with 1, 2, …                                                                 |
| `feedList`   | `{ url, items? }`: read the feed once per item of this JSON list, `{field}` in `url` is filled from each item. `items` unset = the response is the list |

Example, Krónan ([stores/11.jsonc](../stores/11.jsonc)), one paged feed per
category:

```jsonc
"productFeed": {
  "feedList": { "url": "https://backend.kronan.is/api/store-categories/" },
  "url": "https://backend.kronan.is/api/store-categories/{slug}/details/?page={page}",
  "pageCount": "pageCount",
  "items": "products",
  "productUrl": "/vara/{slug}"
}
```

## Which settings go together

Checked by the admin interface:

- `selectors.structuredData` needs `httpcrawler`, the Playwright scraper
  ignores it.
- `crawler` needs `selectors.listPrice`.
- `httpcrawler` needs `selectors.listPrice` or `selectors.structuredData`.
- `productFeed.productUrl` must hold a `{field}`.
- `productFeed.pageCount` needs `{page}` in `productFeed.url`.
- `productFeed.feedList` needs a `{field}` in `productFeed.url`.
- The required parts of the `sku` object and of `attributes`. Unknown keys are
  rejected.
- The form drops `scrollPagesToBottom`, `menuClicker` and `clickers` when the
  type is `httpcrawler`, the HTML crawler ignores them.

Not checked anywhere, the field is just empty:

- **A SKU source:** `selectors.sku`, or structured data with a SKU. JSON-LD has
  one by default, `nextdata` only with `fields.sku`. Without one every product
  fails.
- **`categories` alone does nothing:** it needs `categoryItemLocator` or
  `categorySplitter`. `categoryItemLocator` wins when both are set.
- **`inStock`:** `httpcrawler` needs `inStockText` too. With `crawler`,
  `inStock` alone means in stock when the element exists. With `httpcrawler`
  a selector that matches nothing is an inStock error, not out of stock, so
  pick an element sold out pages have too (the form, not the cart button).
- **`imageAttribute`** only matters with `image`.
- **The whitelist must cover the way to the products**, not only product
  pages: category and listing paths, and sitemap paths when a sitemap index
  points to more sitemaps (store 42 whitelists `/sitemap/product-sitemap`).
- **The product feed** only runs in full crawls.

## Gotchas

- Product urls are saved relative to `startUrl`. Changing its path or host
  (e.g. adding `www.`) can break the saved urls of the store until the next full
  crawl saves them again, the `list` scan and the "View in store" link use
  them.
- CSS selectors are searched inside `productPage`. A price outside it is not
  found. Structured data and the `json` SKU selector read the whole page.
- With `httpcrawler` the selector is appended to `productPage`, so in a list
  `a, b` only `a` is searched inside it and `b` in the whole page. Write
  `:is(a, b)`. The `categories` selector with `categorySplitter` is searched in
  the whole page, and the parts are not trimmed, so put the spaces in the
  splitter (`" › "`).
- `httpcrawler` parses with htmlparser2, which does not add the implicit
  `<tbody>` a browser does. Do not use `tbody` in selectors. It also parses
  the content of `<template>` as ordinary elements, so selectors match copies
  kept there (e.g. a quick buy form).
- `httpcrawler` does not trim attribute values, `<td><p>900 mm</p>\n</td>` is
  saved with the line break. Select the inner element, `td p`.
- `crawler` blocks images, stylesheets and fonts. Lazy galleries (Next.js
  `<Image>`) then keep a placeholder `src`: read `data-*` attributes or
  `meta[property="og:image"]` with `imageAttribute: "content"` and
  `productPage: "html"`. A price that first shows a loading skeleton must
  exclude it (`:not(:has([data-slot="skeleton"]))`), reading waits only for
  the element.
- With `crawler`, `name`, `brand`, `sku` and `image` wait up to 30 seconds for
  an element that is missing, so a selector missing on many pages slows the
  scan. `description` and `oldPrice` do not wait.
- `structuredData` is ignored by `crawler`, but a `sku` with `source: "json"`
  pointed at `script[type="application/ld+json"]` (`path` e.g. `sku` or
  `@graph.0.sku`) still reads the JSON-LD SKU.
- `httpcrawler` matches `productPageIdentifier` in the raw response or in the
  serialized HTML. The serialized HTML escapes non-ASCII (`æ` → `&#xe6;`), so an
  Icelandic identifier only matches the raw response.
- `crawler` waits up to 5 seconds for `productPage` and the identifier before
  deciding a page is not a product page.
- Next.js and other JavaScript storefronts often render no product links in
  the HTML. Look at the network requests of a listing page; an API there can be
  read with `productFeed`. The feed is read with GET and fixed headers, so a
  POST API or one that needs a header (Magento's `Store`) cannot be used.
- Next.js app router pages are streamed: the content is in
  `<div hidden id="S:n">` blocks after `<main>`, which holds a loading
  skeleton. `httpcrawler` reads them, but `productPage` must be `body` (or an
  element inside the blocks), not `main`.
- The prefix whitelist and blacklist cannot skip urls that only extend a
  product url (`/<product>/<variantId>`), nor pick products at the site root.

## Platform notes

- **Shopify:** follow `/sitemap.xml` with the whitelist
  `["/sitemap_products", "/products/"]`, which leaves out the
  `/collections/<c>/products/` copies and other languages' sitemaps. Variant
  SKUs are often missing, repeated or per size, so the product id is the SKU
  (from JSON-LD `productID`, `input[name="product-id"]` or the theme's product
  JSON with the `json` source). Many themes render the price on the server,
  some (Sportís, Farmers Market) add the compare-at price with a script and
  need `crawler`. The store's root can be a foreign market: check
  `Shopify.currency` in the source, the ISK store can be a subfolder
  (`/is-is/`) or another host. Shopify answers too many requests with
  `429 local_rate_limited`.
- **WooCommerce:** the Product JSON-LD puts the post id in `sku` when a product
  has none, so SKUs can be mixed; the post id from `div.product[id]` is a
  steady alternative. A variable product sold out in every size, and an
  external product, have no Product JSON-LD. A page cache (LiteSpeed) can show
  a sale later than the Store API (`/wp-json/wc/store/v1/products?on_sale=true`).
