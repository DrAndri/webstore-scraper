# webstore-scraper

Crawls Icelandic web stores and stores products, prices and attributes in
MariaDB and Solr. [webstore-api](https://github.com/DrAndri/webstore-api) serves
the data and has the admin interface for the scraper.

## Store configs

Each store has a config in `stores/<storeId>.jsonc` (JSON with comments). The
admin interface edits them by committing to this repository, so the history of
a store is the history of its file. Every setting is described in
[docs/store-config.md](docs/store-config.md).

When `GITHUB_CONFIG_REPO` is set the scraper loads the configs from GitHub,
otherwise from `stores/` in the image. It loads them all on start and after
that only when a reload is requested in the admin interface: **Reload config**
on a store's page reloads that store's config and **Reload all configs** on the
stores page reloads every config. A saved config is not used until it is
reloaded, the stores page and the store's page show configs that were saved but
not reloaded. Requests are rows in `configReloads`, the job runner picks them
up within 5 seconds. Scans that are running keep the config they started with.
Configs that do not parse or miss required settings keep the version loaded
before, or are skipped on start, and are shown on the admin dashboard.

## Scans

Scans are rows in the `scrapeJobs` table. The cron schedules and the admin
interface queue jobs, and the job runner in the scraper picks them up:

- `crawler` crawls a store from its start url and sitemaps.
- `list` re-scrapes the product pages seen in the last scan of a store.
- `test` scrapes one url with a draft config and saves nothing, for the config
  tester in the admin interface.

The number of stores scanned at a time is set under Settings in the admin
interface and kept in `scraperSettings`, 5 by default. The job runner reads it
every 5 seconds, when it is lowered the running scans finish and new ones wait.
A store is never scanned twice at once. Running jobs report their progress every 5
seconds and stop when they are cancelled. Jobs that were running when the
scraper stopped are marked as failed on the next start. Only one scraper
instance should run against a database.

Each store has its own schedule for full crawls and for active products, rows
in `storeSchedules` edited on the stores page of the admin interface. A
schedule queues a scan of its store while the schedule, **Scheduled scans**
of the store and **Scheduler** under Settings (`scraperSettings.schedulesEnabled`)
are on. Turning the scheduler off stops the schedules of every store, scans
started by hand still run and queued scans are not cancelled. The admin
interface creates the schedules of a store when it adds the store, the scraper
only reads them and applies changes within 30 seconds. A store without
schedules is not scanned on a schedule. Expressions are evaluated in UTC.
`migrations/2026-11-10-scheduler-switch.sql` adds the scheduler switch to an
existing database.

Scans log each page they visit to the scan log only when **Scan log** is on for
the store on its page in the admin interface (`stores.loggingEnabled`). It is
off for new stores. A config test is logged when it is on for the store being
tested. The log goes to Loki when `LOKI_URL` is set, otherwise warnings and
errors go to the console. Scans read the setting when they start.
`migrations/2026-11-08-store-logging.sql` adds the column to an existing
database.

## Solr

A scan sends a product to Solr only when it is new or changed: a field, its
price, the start or end of a sale, its category, manufacturer or attributes.
The same changes set its `lastChangeDate`. A price seen again only has its end
moved to the date of the scan, which is not a change.

The `active` field of a product in Solr is whether it was seen in the last
scan of its store, the same rule the api uses for a current price: its latest
price ends on or after the store's `lastScanDate`. A scan sends the products it
saves as active. After a scan that was not cancelled and did not fail, the
products that were active and were not seen are sent again as inactive. A
product seen again gets a new price, which sends it as active. A reindex sets
`active` from the prices, run one after the schema sync that adds the field.

A scan sends the products, categories, manufacturers and attributes it saves
to Solr in updates of up to 100 documents, at the latest 5 seconds after the
first one waits. A failed update is sent again with the next one. Documents
still not sent when the scan ends are logged as an error and need a reindex,
the scan itself does not fail.

The cores and their schemas are defined in `solr-configsets/<core>`:

- `docker-compose.yml` creates a core from each configset that does not have
  one yet when Solr starts.
- **Sync Solr schema** on the dashboard of the admin interface queues a
  `schema` job. It adds the field types, fields, dynamic fields and copy fields
  of `schema.xml` that are missing from a core, and replaces the ones that
  differ, through the Schema API. Nothing is removed. Run it after deploying a
  change to `solr-configsets`, the scraper no longer does it on start. A core
  that is missing or refuses a change fails the job, the other cores are still
  synced.
- Documents only get new fields when they are reindexed. The schema sync can
  queue a reindex when it changed something.
- **Reindex Solr** on the dashboard of the admin interface queues an `index`
  job in `scrapeJobs`. The job runner sends everything in the database to Solr
  again, next to the scans. One reindex or schema sync runs at a time. Its progress is the
  documents indexed of the documents to index, cancelling it stops it after the
  current chunk of 100. Documents of rows deleted from the database are kept.

## Database

`initMariaDb/init-db.sql` creates the database, its tables and users when the
MariaDB container starts with an empty data directory. The user passwords in it
are placeholders, change them with `ALTER USER` after the first start.

The data from the MongoDB version is copied by starting the scraper once with
`RUN_MONGO_TO_SQL_MIGRATION=true` and `MONGODB_URI` set. It copies stores,
products, manufacturers and prices, the next full crawl fills in the rest. Run
it only once, on an empty database, and use a copy of the production MongoDB
since it creates indexes there.

`products.url` is the url of the product page relative to the `startUrl` of
the store, the rest of the url after it: `/vara/x` for
`https://s4s.is/premium-outlet/vara/x` when the start url is
`https://s4s.is/premium-outlet`. A page outside the start url, on another path
or host, is saved as its absolute url. The `list` scan and the "View in store"
link of the admin interface join them back the same way
([ProductUrl.ts](crawler/ProductUrl.ts)), so changing the path or host of a
`startUrl` can break the saved urls of the store until its next full crawl.

`migrations/` holds data fixes and schema changes to run by hand.
`migrations/2026-11-11-relative-product-urls.sql` changes the saved urls of the
stores whose start url has a path, which were saved from the root of the site.
`migrations/2026-11-08-lookup-indexes.sql` adds the indexes of the category and
attribute lookups a scan makes for each product to an existing database.

## Environment variables

| Variable                                           | Used for                                                    |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `MARIADB_HOST`, `MARIADB_DATABASE`                 | Database                                                    |
| `MARIADB_SCRAPER_USER`, `MARIADB_SCRAPER_PASSWORD` | Database user                                               |
| `SOLR_URL`                                         | Solr base url, e.g. `http://solr:8983/solr`                 |
| `GITHUB_CONFIG_REPO`, `GITHUB_CONFIG_BRANCH`       | Load store configs from GitHub, branch defaults to `master` |
| `GITHUB_TOKEN`                                     | Optional read only token, raises the GitHub rate limit      |
| `STORE_CONFIG_DIR`                                 | Directory of the configs, default `stores`                  |

## TODO

- Publish common types
- Implement "fetch more products" (ok beint)
- Implement "open megamenu" (byko and advania)
- Product attributes
- Search engine
- Register when products are missing from scraping
- train/use ai to group data
- generate events for price drops
- link MongodbProductPrice to Metadata with ObjectId?
