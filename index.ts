// import pLimit from "p-limit";
import https from 'https';
import { MongoClient } from 'mongodb';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import cron from 'node-cron';

import StoreUpdater from './StoreUpdaterMongo';
import config from './config.js';

import * as dotenv from 'dotenv';
import {
  type Env,
  type GoogleMerchantFeed,
  type GoogleMerchantProduct
} from './types';

dotenv.config();

const env: Env = {
  MONGODB_URI: process.env.MONGODB_URI || ''
};

const MONGODB_URI = env.MONGODB_URI;

// const limit = pLimit(4);

// TODO make proper interface for google shopping feed
// https://github.com/xcommerceweb/google-merchant-feed/tree/main/src/models
async function downloadFeed(url: URL): Promise<GoogleMerchantFeed> {
  return await new Promise<GoogleMerchantFeed>((resolve, reject) => {
    let buffer = '';
    https
      .get(url, (resp) => {
        resp.on('error', (err: string) => {
          console.log('Error while reading', err);
          reject(new Error('Error while reading ' + err));
        });

        resp.on('data', (data) => {
          buffer += data;
        });

        resp.on('end', function () {
          if (XMLValidator.validate(buffer) === true) {
            const parser = new XMLParser();
            resolve(parser.parse(buffer));
          } else reject();
        });
      })
      .end();
  });
}

function updateAllStores(): void {
  const mongoClient = new MongoClient(MONGODB_URI);
  mongoClient.connect().then(() => {
    for (const store of config) {
      console.log('UPDATING', store.storeName);
      const storeUpdater = new StoreUpdater(mongoClient, store.storeName);
      const timestamp = new Date().getTime();
      downloadFeed(new URL(store.feedUrl)).then((jsonObj) => {
        let promises: Array<Promise<void>> = [];
        for (const item of jsonObj.rss.channel.item) {
          const product: GoogleMerchantProduct = {
            'g:id': item['g:id'].toString(),
            'g:price': item['g:price'],
            'g:sale_price': item['g:sale_price']
          };
          promises = promises.concat(
            storeUpdater.updateProduct(product, timestamp)
          );
        }
        Promise.all(promises).then(async () => {
          const results = await storeUpdater.submitAllDocuments();
          console.log('FINISHED UPDATING', store.storeName);
          console.log(
            results.priceChangesResult?.insertedCount || 0,
            ' prices changes inserted'
          );
          console.log(
            results.productMetadataResult?.matchedCount || 0,
            ' productMetadata matched'
          );
          console.log(
            results.productMetadataResult?.upsertedCount || 0,
            ' productMetadata upserted'
          );
          console.log(
            results.productMetadataResult?.modifiedCount || 0,
            ' productMetadata modified'
          );
        });
      });
    }
  });
  
}
console.log('Running startup update');
updateAllStores();

cron.schedule('00 12 * * *', () => {
  console.log('Updating all stores');
  updateAllStores();
});
console.log('Cron schedule started');
