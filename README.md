# webstore-scraper

Crawls Icelandic web stores and stores products, prices and attributes in
MariaDB and Solr. [webstore-api](https://github.com/DrAndri/webstore-api) serves
the data and has the admin interface for the scraper.

## Store configs

Each store has a config in `stores/<storeId>.jsonc` (JSON with comments). The
admin interface edits them by committing to this repository, so the history of
a store is the history of its file.

When `GITHUB_CONFIG_REPO` is set the scraper loads the configs from GitHub,
checking for new commits at most once a minute, so a saved config is used from
the next scan without a redeploy. Otherwise they are read from `stores/` in the
image. Configs that do not parse or miss required settings are skipped and
shown on the admin dashboard.

## Scans

Scans are rows in the `scrapeJobs` table. The cron schedules, the admin
interface and `RUN_STARTUP_UPDATE` all queue jobs, and the job runner in the
scraper picks them up:

- `crawler` crawls a store from its start url and sitemaps.
- `list` re-scrapes the product pages seen in the last scan of a store.
- `test` scrapes one url with a draft config and saves nothing, for the config
  tester in the admin interface.

At most `STORE_CONCURRENCY_LIMIT` stores are scanned at a time and a store is
never scanned twice at once. Running jobs report their progress every 5
seconds and stop when they are cancelled. Jobs that were running when the
scraper stopped are marked as failed on the next start. Only one scraper
instance should run against a database.

The schedules are in `scraperSchedules`. `CRON_SCHEDULE` (full crawl) and
`CRON_ACTIVE_SCHEDULE` (active products) create them on the first start, after
that they are edited in the admin interface. Expressions are evaluated in UTC.

## Solr

The cores and their schemas are defined in `solr-configsets/<core>`:

- `docker-compose.yml` creates a core from each configset that does not have
  one yet when Solr starts.
- On startup the scraper adds the field types, fields, dynamic fields and copy
  fields of `schema.xml` that are missing from a core, and replaces the ones
  that differ, through the Schema API. Nothing is removed. Set
  `SOLR_SYNC_SCHEMA=false` to skip this.
- Documents only get new fields when they are reindexed. Start once with
  `INDEX_EVERYTHING=true` after a schema change, or set
  `SOLR_REINDEX_ON_SCHEMA_CHANGE=true` to reindex automatically when the sync
  changed something.

## Database

`initMariaDb/init-db.sql` creates the database, its tables and users when the
MariaDB container starts with an empty data directory. The user passwords in it
are placeholders, change them with `ALTER USER` after the first start.

The data from the MongoDB version is copied by starting the scraper once with
`RUN_MONGO_TO_SQL_MIGRATION=true` and `MONGODB_URI` set. It copies stores,
products, manufacturers and prices, the next full crawl fills in the rest. Run
it only once, on an empty database, and use a copy of the production MongoDB
since it creates indexes there.

`migrations/` holds data fixes to run by hand.

## Environment variables

| Variable                                               | Used for                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| `MARIADB_HOST`, `MARIADB_DATABASE`                     | Database                                                         |
| `MARIADB_SCRAPER_USER`, `MARIADB_SCRAPER_PASSWORD`     | Database user                                                    |
| `SOLR_URI`                                             | Solr base url, e.g. `http://solr:8983/solr`                      |
| `STORE_CONCURRENCY_LIMIT`                              | Stores scanned at a time, default 5                              |
| `CRON_SCHEDULE`, `CRON_ACTIVE_SCHEDULE`                | Schedules created on the first start                             |
| `RUN_STARTUP_UPDATE`                                   | Queue an active products scan of every store on start            |
| `GITHUB_CONFIG_REPO`, `GITHUB_CONFIG_BRANCH`           | Load store configs from GitHub, branch defaults to `master`      |
| `GITHUB_TOKEN`                                         | Optional read only token, raises the GitHub rate limit           |
| `STORE_CONFIG_DIR`                                     | Directory of the configs, default `stores`                       |
| `SOLR_SYNC_SCHEMA`, `SOLR_REINDEX_ON_SCHEMA_CHANGE`    | See Solr above                                                   |
| `INDEX_EVERYTHING`                                     | Reindex everything in Solr on start                              |

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
