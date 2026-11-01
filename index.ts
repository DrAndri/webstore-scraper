import { Db, MongoClient } from 'mongodb';

import * as dotenv from 'dotenv';
import { indexEverything } from './SQLStoreUpdater.js';
import migrate from './MongoToSQLMigrate.js';
import JobRunner from './JobRunner.js';
import Scheduler from './Scheduler.js';
import { syncSolrSchemas } from './SolrSchema.js';
import StoreConfigLoader from './StoreConfigLoader.js';

dotenv.config();

const storeConcurrencyLimit = parseInt(
  process.env.STORE_CONCURRENCY_LIMIT ?? '5'
);

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
  console.log('Running migration');
  const mongoDb = await getMongodb();
  await initMongodbCollections(mongoDb);
  await migrate(mongoDb).catch((error) => console.log(error));
}

// Brings the Solr schemas in line with solr-configsets, documents indexed
// before a schema change only get the new fields when they are reindexed
let reindex = process.env.INDEX_EVERYTHING === 'true';
if (process.env.SOLR_SYNC_SCHEMA !== 'false') {
  const changed = await syncSolrSchemas().catch((e) => {
    console.log('Syncing the Solr schemas failed', e);
    return [];
  });
  if (changed.length > 0) {
    if (process.env.SOLR_REINDEX_ON_SCHEMA_CHANGE === 'true') reindex = true;
    else
      console.log(
        'The Solr schema changed, start once with INDEX_EVERYTHING=true to reindex'
      );
  }
}

if (reindex) {
  console.log('Running index everything');
  await indexEverything();
}

const runner = new JobRunner(new StoreConfigLoader(), storeConcurrencyLimit);
await runner.start();

if (process.env.RUN_STARTUP_UPDATE === 'true') {
  console.log('Running startup update');
  await runner.enqueueAll('list', 'startup');
}

// CRON_SCHEDULE and CRON_ACTIVE_SCHEDULE are only used for the first start,
// after that the schedules are edited in the admin interface
const scheduler = new Scheduler(runner.pool, (mode) =>
  runner.enqueueAll(mode, 'cron')
);
await scheduler.start();
console.log('Scheduler started');
