// A product url is saved relative to the start url of its store, the rest of
// the url after it: https://s4s.is/premium-outlet/vara/x with the start url
// https://s4s.is/premium-outlet is saved as /vara/x. A page outside the start
// url, on another path or host, is saved as its absolute url. The admin
// interface (webstore-api utils/storeUrls.ts) reads them the same way.

const storedAbsoluteUrl = /^https?:\/\//;

// The start url without a trailing slash, its query and hash
const startUrlBase = (startUrl: string): string => {
  const start = new URL(startUrl);
  return start.origin + start.pathname.replace(/\/$/, '');
};

export const toStoredUrl = (url: string, startUrl: string): string => {
  const href = new URL(url).href;
  const base = startUrlBase(startUrl);
  const rest = href.slice(base.length);
  // https://s4s.is/air is not the start of https://s4s.is/airline
  return href.startsWith(base) && /^[/?#]/.test(rest) ? rest : href;
};

export const fromStoredUrl = (url: string, startUrl: string): string =>
  storedAbsoluteUrl.test(url) ? url : startUrlBase(startUrl) + url;
