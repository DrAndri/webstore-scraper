import { Db, MongoClient } from 'mongodb';

import * as dotenv from 'dotenv';
import migrate from './MongoToSQLMigrate.js';
import JobRunner from './JobRunner.js';
import Scheduler from './Scheduler.js';
import { syncSolrSchemas } from './SolrSchema.js';
import StoreConfigLoader from './StoreConfigLoader.js';
import { logger } from './logger.js';

dotenv.config();

const log = logger.child({ label: 'main' });

const MONGODB_URI = process.env.MONGODB_URI;

async function initMongodbCollections(db: Db): Promise<string[]> {
  return Promise.all([
    db.collection('priceChanges').createIndex({ store_id: 1, sku: 1 }),
    db.collection('productMetadata').createIndex({ store_id: 1, sku: 1 }),
    db.collection('stores').createIndex({ apiEnabled: 1 }),
    db.collection('stores').createIndex({ scraperEnabled: 1 })
  ]);
}

async function getMongodb(): Promise<Db> {
  if (MONGODB_URI === undefined) {
    throw new Error('MONGODB_URI not set');
  }
  const mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  return mongoClient.db('google-shopping-scraper');
}

if (process.env.RUN_MONGO_TO_SQL_MIGRATION === 'true') {
  log.info('Running migration');
  const mongoDb = await getMongodb();
  await initMongodbCollections(mongoDb);
  await migrate(mongoDb).catch((e) => log.error('Migration failed', e));
}

// Brings the Solr schemas in line with solr-configsets, documents indexed
// before a schema change only get the new fields when they are reindexed
let reindex = false;
if (process.env.SOLR_SYNC_SCHEMA !== 'false') {
  const changed = await syncSolrSchemas().catch((e) => {
    log.error('Syncing the Solr schemas failed', e);
    return [];
  });
  if (changed.length > 0) {
    if (process.env.SOLR_REINDEX_ON_SCHEMA_CHANGE === 'true') reindex = true;
    else
      log.warn(
        'The Solr schema changed, reindex Solr from the admin dashboard'
      );
  }
}

// The number of stores scanned at a time is set in the admin interface
const runner = new JobRunner(new StoreConfigLoader());
await runner.start();
// The reindex runs as a job, shown in the admin interface like a reindex
// queued there
if (reindex) await runner.enqueueIndex('startup');

// The schedules are edited in the admin interface
const scheduler = new Scheduler(runner.pool, (mode) =>
  runner.enqueueAll(mode, 'cron')
);
await scheduler.start();
log.info('Scheduler started');
