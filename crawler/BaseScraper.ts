import {
  ProductSanitizers,
  ProductSelector,
  ProductSelectors
} from '../types/db-types.js';
import { ProductAttributeGroup } from '../types/types.js';
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

  // "Litur:" and "Litur :" are the same attribute as "Litur"
  cleanAttributeName(name: string): string {
    return name.trim().replace(/\s*:+$/, '');
  }

  // A page can show the same attribute twice, e.g. a table rendered for both
  // mobile and desktop. The database keeps one value per attribute and
  // product, and MariaDB compares names case-insensitively, so groups with the
  // same name are merged and the first value of an attribute name is kept.
  dedupeAttributeGroups(
    attributeGroups: ProductAttributeGroup[]
  ): ProductAttributeGroup[] | undefined {
    const groups = new Map<
      string,
      { group: ProductAttributeGroup; names: Set<string> }
    >();
    for (const attributeGroup of attributeGroups) {
      // An empty group name is no group, like in the database
      const trimmed = attributeGroup.name?.trim();
      const groupName = trimmed === '' ? undefined : trimmed;
      const groupKey = groupName?.toLocaleLowerCase() ?? '';
      let entry = groups.get(groupKey);
      if (!entry) {
        entry = {
          group: { name: groupName, attributes: [] },
          names: new Set()
        };
        groups.set(groupKey, entry);
      }
      for (const attribute of attributeGroup.attributes) {
        const nameKey = attribute.name.toLocaleLowerCase();
        if (entry.names.has(nameKey)) continue;
        entry.names.add(nameKey);
        entry.group.attributes.push(attribute);
      }
    }
    const deduped = [...groups.values()]
      .map((entry) => entry.group)
      .filter((group) => group.attributes.length > 0);
    return deduped.length > 0 ? deduped : undefined;
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
