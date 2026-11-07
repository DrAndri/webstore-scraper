import {
  ProductSanitizers,
  ProductSelector,
  ProductSelectors
} from '../types/db-types.js';
import { getPath, toText } from './StructuredData.js';

export default abstract class BaseScraper {
  selectors: ProductSelectors;
  sanitizers: ProductSanitizers | undefined;
  categoryBanList: string[];
  constructor(
    selectors: ProductSelectors,
    sanitizers: ProductSanitizers | undefined,
    categoryBanList: string[]
  ) {
    this.selectors = selectors;
    this.sanitizers = sanitizers;
    this.categoryBanList = categoryBanList;
  }

  getRelativeUrl(url: string): string {
    const urlObj = new URL(url);
    return urlObj.pathname + urlObj.search + urlObj.hash;
  }

  skuFromUrl(
    url: string,
    selector: Extract<ProductSelector, { source: 'url' }>
  ): string | undefined {
    const parts = url.split(selector.delimiter);
    if (selector.index === 'first') return parts[0];
    if (selector.index === 'last') return parts[parts.length - 1];
    return parts[selector.index];
  }

  skuFromJson(
    json: string | null | undefined,
    selector: Extract<ProductSelector, { source: 'json' }>
  ): string | undefined {
    if (!json) return undefined;
    return toText(getPath(JSON.parse(json), selector.path));
  }

  sanitizeSku(sku: string | null | undefined): string {
    let string = sku ?? undefined;
    if (this.sanitizers?.sku) {
      for (const sanitizer of this.sanitizers.sku) {
        string = string?.replace(sanitizer.match, sanitizer.replace);
      }
    }
    string = string?.trim();
    if (!string || string.length < 2)
      throw new Error(`Sku ${string} is not valid`);
    return string;
  }

  isValidCategory(category: string) {
    if (category.length < 2) return false;
    const lowerCased = category.toLocaleLowerCase();
    if (this.categoryBanList.find((item) => item == lowerCased)) return false;
    return true;
  }

  cleanCategories(categories: string[], productName: string | undefined) {
    const cleaned: string[] = [];
    for (const category of categories.map((c) => c.trim())) {
      if (
        this.isValidCategory(category) &&
        category != productName &&
        !cleaned.includes(category)
      )
        cleaned.push(category);
    }
    return cleaned;
  }
}
