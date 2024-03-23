import { type StoreConfig } from './types';

const config: StoreConfig[] = [
  {
    storeName: 'Origo',
    feedUrl: 'https://api-verslun.origo.is/google_merchant_feed_origo.xml'
  },
  {
    storeName: 'Tölvutek',
    feedUrl: 'https://tolvutek.is/google_merchant_feed_tolvutek.xml'
  }
];

export default config;
