import { Db, MongoClient } from 'mongodb';

import * as dotenv from 'dotenv';
import migrate from './MongoToSQLMigrate.js';
import JobRunner from './JobRunner.js';
import Scheduler from './Scheduler.js';
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

// The number of stores scanned at a time is set in the admin interface, the
// Solr schemas are synced and reindexed by jobs queued there
const runner = new JobRunner(new StoreConfigLoader());
await runner.start();

// The schedules are edited in the admin interface
const scheduler = new Scheduler(runner.pool, (mode) =>
  runner.enqueueAll(mode, 'cron')
);
await scheduler.start();
log.info('Scheduler started');
