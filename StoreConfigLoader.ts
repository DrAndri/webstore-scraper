import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import { WebshopCrawlerOptions } from './types/index.js';

// Configs are reloaded at most this often
const MAX_AGE_MS = 60 * 1000;
const CONFIG_FILE = /^(\d+)\.jsonc$/;
const CRAWLER_TYPES = ['httpcrawler', 'crawler'];

export interface ConfigError {
  file: string;
  message: string;
}

export interface StoreConfigs {
  configs: Map<number, WebshopCrawlerOptions>;
  // Where the configs were loaded from, e.g. github:DrAndri/webstore-scraper@master/stores
  source: string;
  commit?: string;
  errors: ConfigError[];
}

interface ConfigFile {
  name: string;
  text: string;
}

interface GithubContent {
  type: string;
  name: string;
  path: string;
  sha: string;
}

// Validates the fields the crawlers can not run without, the admin interface
// validates the whole config before committing it
export const validateStoreConfig = (
  value: unknown,
  storeId: number
): string | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return 'The config must be an object';
  const config = value as Partial<WebshopCrawlerOptions>;
  if (config.storeId !== storeId)
    return `storeId must be ${storeId} to match the file name`;
  if (!config.type || !CRAWLER_TYPES.includes(config.type))
    return `type must be one of ${CRAWLER_TYPES.join(', ')}`;
  if (typeof config.startUrl !== 'string' || !URL.canParse(config.startUrl))
    return 'startUrl must be an absolute url';
  if (typeof config.productPageIdentifier !== 'string')
    return 'productPageIdentifier must be a string';
  if (typeof config.selectors?.productPage !== 'string')
    return 'selectors.productPage must be a string';
};

// Loads the store configs in stores/<storeId>.jsonc, from GitHub when
// GITHUB_CONFIG_REPO is set so config changes are used without a redeploy,
// otherwise from disk
export default class StoreConfigLoader {
  repo = process.env.GITHUB_CONFIG_REPO;
  branch = process.env.GITHUB_CONFIG_BRANCH ?? 'master';
  dir = process.env.STORE_CONFIG_DIR ?? 'stores';
  token = process.env.GITHUB_TOKEN;
  current?: StoreConfigs;
  loadedAt = 0;
  // File contents by blob sha, so only changed files are downloaded
  blobCache = new Map<string, string>();

  async load(): Promise<StoreConfigs> {
    if (this.current && Date.now() - this.loadedAt < MAX_AGE_MS)
      return this.current;
    try {
      this.current = this.repo
        ? await this.loadFromGithub(this.repo)
        : await this.loadFromDisk();
    } catch (e) {
      console.log('Loading store configs failed', e);
      // Keep using the last configs, or the ones in the image
      this.current ??= await this.loadFromDisk();
    }
    this.loadedAt = Date.now();
    return this.current;
  }

  async loadFromDisk(): Promise<StoreConfigs> {
    const names = await fs.readdir(this.dir);
    const files = await Promise.all(
      names
        .filter((name) => CONFIG_FILE.test(name))
        .map(async (name) => ({
          name,
          text: await fs.readFile(path.join(this.dir, name), 'utf8')
        }))
    );
    return this.parseFiles(
      files,
      `disk:${path.resolve(this.dir)}`,
      process.env.GIT_COMMIT
    );
  }

  async loadFromGithub(repo: string): Promise<StoreConfigs> {
    const source = `github:${repo}@${this.branch}/${this.dir}`;
    const [latest] = await this.github<{ sha: string }[]>(
      `repos/${repo}/commits?sha=${encodeURIComponent(this.branch)}&path=${encodeURIComponent(this.dir)}&per_page=1`
    );
    if (!latest)
      throw new Error(`No commits found for ${this.dir} on ${this.branch}`);
    if (this.current?.source === source && this.current.commit === latest.sha)
      return this.current;

    const contents = await this.github<GithubContent[]>(
      `repos/${repo}/contents/${this.dir}?ref=${latest.sha}`
    );
    const files = await Promise.all(
      contents
        .filter(
          (entry) => entry.type === 'file' && CONFIG_FILE.test(entry.name)
        )
        .map(async (entry) => {
          let text = this.blobCache.get(entry.sha);
          if (text === undefined) {
            text = await this.github<string>(
              `repos/${repo}/contents/${entry.path}?ref=${latest.sha}`,
              true
            );
            this.blobCache.set(entry.sha, text);
          }
          return { name: entry.name, text };
        })
    );
    console.log(
      `Loaded ${files.length} store configs from ${source} at ${latest.sha}`
    );
    return this.parseFiles(files, source, latest.sha);
  }

  async github<T>(apiPath: string, raw = false): Promise<T> {
    const response = await fetch(`https://api.github.com/${apiPath}`, {
      headers: {
        Accept: raw
          ? 'application/vnd.github.raw+json'
          : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'webstore-scraper',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      }
    });
    if (!response.ok)
      throw new Error(`GitHub ${apiPath} returned ${response.status}`);
    return (raw ? response.text() : response.json()) as Promise<T>;
  }

  parseFiles(
    files: ConfigFile[],
    source: string,
    commit?: string
  ): StoreConfigs {
    const configs = new Map<number, WebshopCrawlerOptions>();
    const errors: ConfigError[] = [];
    for (const file of files) {
      const storeId = parseInt(CONFIG_FILE.exec(file.name)?.[1] ?? '');
      const parseErrors: ParseError[] = [];
      const value: unknown = parse(file.text, parseErrors, {
        allowTrailingComma: true
      });
      const message = parseErrors.length
        ? parseErrors
            .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
            .join(', ')
        : validateStoreConfig(value, storeId);
      if (message) {
        console.log(`Invalid store config ${file.name}: ${message}`);
        errors.push({ file: file.name, message });
      } else {
        configs.set(storeId, value as WebshopCrawlerOptions);
      }
    }
    return { configs, source, commit, errors };
  }
}
