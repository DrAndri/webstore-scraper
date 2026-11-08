import {
  CheerioAPI,
  CheerioCrawler,
  CheerioCrawlerOptions,
  CheerioCrawlingContext,
  LoadedRequest,
  RequestHandler,
  type Request
} from 'crawlee';
import { createLogger } from '../logger.js';
import PageHtmlScraper from './PageHtmlScraper.js';
import BaseCrawler from './BaseCrawler.js';
import { categoryBanList } from './constants.js';

export default class WebshopHtmlCrawler extends BaseCrawler {
  setupCrawler(configuration: CheerioCrawlerOptions) {
    const { selectors, productPageIdentifier, sanitizers } = this.store.options;
    const store = this.store;

    const pageScraper = new PageHtmlScraper(
      selectors,
      sanitizers,
      categoryBanList
    );

    const requestHandler: RequestHandler<
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request: LoadedRequest<Request<any>>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } & Omit<CheerioCrawlingContext<any, any>, 'request'>
    > = async ({ request, $, body }) => {
      this.result.totalRequests++;

      const logger = createLogger(
        request.loadedUrl ?? 'default label',
        store,
        this.jobId
      );
      const productLocator = $(selectors.productPage);
      // The serialized html writes characters like "æ" as entities ("&#xe6;"),
      // so an identifier like "Varan fæst í" is only found in the response
      // body, while one like id="x" may only match the serialized attribute
      const html = $.root().html() ?? '';
      const identifierInHtml =
        html.includes(productPageIdentifier) ||
        body.toString().includes(productPageIdentifier);
      if (productLocator.length > 0 && identifierInHtml) {
        //TODO: check if productLocator matches multiple elements
        logger.log('debug', 'processing url');
        try {
          const scrapeResult = pageScraper.scrapeProductPage(
            $,
            request.loadedUrl,
            logger
          );

          await this.handleProductScrapeResult(logger, scrapeResult);
        } catch (e) {
          this.handleProductScrapeError(logger, e);
        }
      } else {
        this.handleNotProductPage(logger);
      }

      if (this.mode === 'crawler') await addLinksToQueue($);
    };

    const addLinksToQueue = async ($: CheerioAPI) => {
      const links: string[] = [];
      $('a').each(function (i, elem) {
        const href = $(elem).attr('href');
        if (href) links.push(href);
      });
      // Sitemap entries
      $('loc').each(function (i, elem) {
        const loc = $(elem).text().trim();
        if (loc) links.push(loc);
      });

      await this.filterAndAddLinksToQueue(links);
    };

    const crawler = new CheerioCrawler({
      ...configuration,
      requestHandler: requestHandler,
      failedRequestHandler: ({ request, log }) => {
        log.info(`Request ${request.url} failed too many times.`);
        this.pageListener?.onRequestFailed(request.errorMessages);
      }
    });
    return crawler;
  }
}
