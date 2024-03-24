import { type StoreConfig } from './types.js';

const config: StoreConfig[] = [
  {
    name: 'Origo',
    feedUrl: 'https://api-verslun.origo.is/google_merchant_feed_origo.xml'
  },
  {
    name: 'Tölvutek',
    feedUrl: 'https://tolvutek.is/google_merchant_feed_tolvutek.xml'
  }
];

export default config;
