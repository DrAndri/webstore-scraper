# webstore-scraper

Crawls Icelandic web stores with crawlee and saves products, prices, categories
and attributes to MariaDB and Solr. The admin interface and public API are in
the sibling repo `../webstore-api` (Next.js). Operations, scans, Solr and
environment variables are described in [README.md](README.md).

## Documentation to keep up to date

- [docs/store-config.md](docs/store-config.md): every store config setting,
  what it does, which settings go together, and the gotchas. Read it before
  writing or debugging a store config.
- [README.md](README.md): scans, schedules, config reloads, Solr, database,
  environment variables.

**When a change alters what these documents describe, update them in the same
change**: a new, changed or removed config setting, a change in how a setting
behaves, a new validation rule, a new gotcha found while fixing a store, or a
change to scans, schedules, Solr or the environment. Write them as they are now,
not as a changelog.

## How it fits together

- [index.ts](index.ts): starts the `JobRunner` and the `Scheduler`.
- [JobRunner.ts](JobRunner.ts): picks queued rows from `scrapeJobs` (modes
  `crawler`, `list`, `test`, `index`, `schema`), runs scans, handles config
  reload requests.
- [Scheduler.ts](Scheduler.ts): queues scans from each store's
  `storeSchedules`.
- [StoreConfigLoader.ts](StoreConfigLoader.ts): loads `stores/<storeId>.jsonc`
  from disk or GitHub, checks only the required settings.
- [crawler/BaseCrawler.ts](crawler/BaseCrawler.ts): crawlee settings, link
  filtering, product feed, result counters.
  - `httpcrawler`: [WebshopHtmlCrawler.ts](crawler/WebshopHtmlCrawler.ts)
    (Cheerio) + [PageHtmlScraper.ts](crawler/PageHtmlScraper.ts)
  - `crawler`: [WebshopCrawler.ts](crawler/WebshopCrawler.ts) (Playwright) +
    [PageScraper.ts](crawler/PageScraper.ts)
  - Shared: [BaseScraper.ts](crawler/BaseScraper.ts) (SKU, sanitizers,
    categories), [StructuredData.ts](crawler/StructuredData.ts) (JSON-LD,
    `__NEXT_DATA__`), [ProductFeed.ts](crawler/ProductFeed.ts),
    [constants.ts](crawler/constants.ts)
- [SQLStoreUpdater.ts](SQLStoreUpdater.ts): writes scraped products to MariaDB
  and indexes them in Solr. [SolrSchema.ts](SolrSchema.ts) syncs the Solr
  schemas.
- [types/db-types.d.ts](types/db-types.d.ts): the config types
  (`WebshopCrawlerOptions`).

## Config settings live in two repos

`../webstore-api` mirrors the config types and validates and edits configs.
A config setting added or changed here must also be changed there:

- `utils/admin/types.ts`: the types
- `utils/admin/storeConfig.ts`: the validator (unknown keys are rejected, so a
  setting missing there makes every config using it invalid in the admin) and
  `pruneConfig`
- `components/admin/configFormValues.ts` and `StoreConfigForm.tsx`: the form
- `i18n/locales/en/stores.json` and `i18n/locales/is/stores.json`: labels,
  help and validation messages, both languages must have the same keys

## Checking changes

There are no tests. Run `npx tsc -p .` and `npx eslint .` (yarn is not on the
PATH in every shell). Prettier: single quotes, no trailing commas, semicolons.

Test a config against the live site without a database: build, then from a
scratch script import `dist/crawler/PageHtmlScraper.js` and
`dist/crawler/constants.js` (for `categoryBanList`), load a page with
`cheerio.load(body, { xmlMode: false, _useHtmlParser2: true })` and call
`scrapeProductPage`. `fetchProductFeedUrls` from `dist/crawler/ProductFeed.js`
can be run the same way. Check `robots.txt` before crawling a new store.
