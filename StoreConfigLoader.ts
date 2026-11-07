import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import { WebshopCrawlerOptions } from './types/index.js';
import { logger } from './logger.js';

const CONFIG_FILE = /^(\d+)\.jsonc$/;
const CRAWLER_TYPES = ['httpcrawler', 'crawler'];

const log = logger.child({ label: 'StoreConfigLoader' });

export interface ConfigError {
  file: string;
  message: string;
}

export interface LoadedConfig {
  options: WebshopCrawlerOptions;
  // Git blob sha of the file, the admin interface compares it to the file on
  // GitHub to show configs that were saved but not reloaded
  sha: string;
  // Commit the file was read at
  commit?: string;
  loadedAt: Date;
}

export interface StoreConfigs {
  configs: Map<number, LoadedConfig>;
  // Where the configs were loaded from, e.g. github:DrAndri/webstore-scraper@master/stores
  source: string;
  // Commit of the last reload of every config
  commit?: string;
  loadedAt: Date;
  // Files that failed to load, their stores keep the config loaded before
  errors: ConfigError[];
}

// What a reload loaded, errors only has the files of the reload
export interface ReloadResult {
  commit?: string;
  errors: ConfigError[];
}

interface ConfigFile {
  name: string;
  text: string;
  sha: string;
}

interface GithubContent {
  type: string;
  name: string;
  path: string;
  sha: string;
  content?: string;
}

// The sha git gives the file, so configs read from disk compare to GitHub's
const blobSha = (text: string) => {
  const content = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
};

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

const parseConfig = (
  file: ConfigFile,
  storeId: number
): { options: WebshopCrawlerOptions } | { error: string } => {
  const parseErrors: ParseError[] = [];
  const value: unknown = parse(file.text, parseErrors, {
    allowTrailingComma: true
  });
  const error = parseErrors.length
    ? parseErrors
        .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
        .join(', ')
    : validateStoreConfig(value, storeId);
  if (error) {
    log.warn(`Invalid store config ${file.name}: ${error}`);
    return { error };
  }
  return { options: value as WebshopCrawlerOptions };
};

// Loads the store configs in stores/<storeId>.jsonc, from GitHub when
// GITHUB_CONFIG_REPO is set, otherwise from disk. They are loaded on start and
// after that only when a reload is requested in the admin interface, so a
// committed config is not used until it is reloaded.
export default class StoreConfigLoader {
  repo = process.env.GITHUB_CONFIG_REPO;
  branch = process.env.GITHUB_CONFIG_BRANCH ?? 'master';
  dir = process.env.STORE_CONFIG_DIR ?? 'stores';
  token = process.env.GITHUB_TOKEN;
  current?: StoreConfigs;
  initial?: Promise<void>;
  // File contents by blob sha, so only changed files are downloaded
  blobCache = new Map<string, string>();

  get source() {
    return this.repo
      ? `github:${this.repo}@${this.branch}/${this.dir}`
      : `disk:${path.resolve(this.dir)}`;
  }

  // The configs as last loaded, loading them on the first call
  async get(): Promise<StoreConfigs> {
    await (this.initial ??= this.loadInitial());
    return this.current!;
  }

  async loadInitial() {
    try {
      await this.reloadAll();
    } catch (e) {
      if (!this.repo) throw e;
      log.error('Loading store configs from GitHub failed', e);
      // The configs in the image, until they are reloaded
      const files = await this.readAllFromDisk();
      this.current = this.applyAll(
        files,
        `disk:${path.resolve(this.dir)}`,
        process.env.GIT_COMMIT
      );
    }
  }

  async reloadAll(): Promise<ReloadResult> {
    const commit = this.repo
      ? await this.latestCommit(this.repo, this.dir)
      : process.env.GIT_COMMIT;
    const files = this.repo
      ? await this.readAllFromGithub(this.repo, commit!)
      : await this.readAllFromDisk();
    this.current = this.applyAll(files, this.source, commit);
    log.info(
      `Loaded ${this.current.configs.size} store configs from ${this.source}${commit ? ` at ${commit}` : ''}`
    );
    return { commit, errors: this.current.errors };
  }

  // A store whose file was removed no longer has a config
  async reloadStore(storeId: number): Promise<ReloadResult> {
    const current = await this.get();
    const name = `${storeId}.jsonc`;
    const filePath = `${this.dir}/${name}`;
    const commit = this.repo
      ? await this.latestCommit(this.repo, filePath)
      : process.env.GIT_COMMIT;
    const file = this.repo
      ? commit && (await this.readFromGithub(this.repo, filePath, commit))
      : await this.readFromDisk(name);

    const configs = new Map(current.configs);
    const errors = current.errors.filter((e) => e.file !== name);
    const reloadErrors: ConfigError[] = [];
    if (!file) {
      configs.delete(storeId);
      log.info(`Store ${storeId} has no config file, its config was removed`);
    } else {
      const parsed = parseConfig(file, storeId);
      if ('error' in parsed)
        reloadErrors.push({ file: name, message: parsed.error });
      else {
        configs.set(storeId, {
          options: parsed.options,
          sha: file.sha,
          commit,
          loadedAt: new Date()
        });
        log.info(
          `Loaded the config of store ${storeId}${commit ? ` at ${commit}` : ''}`
        );
      }
    }
    this.current = {
      ...current,
      configs,
      errors: [...errors, ...reloadErrors]
    };
    return { commit, errors: reloadErrors };
  }

  // Configs that fail to load keep the version loaded before
  applyAll(files: ConfigFile[], source: string, commit?: string): StoreConfigs {
    const previous = this.current?.configs;
    const configs = new Map<number, LoadedConfig>();
    const errors: ConfigError[] = [];
    const loadedAt = new Date();
    for (const file of files) {
      const storeId = parseInt(CONFIG_FILE.exec(file.name)?.[1] ?? '');
      const parsed = parseConfig(file, storeId);
      if ('error' in parsed) {
        errors.push({ file: file.name, message: parsed.error });
        const loaded = previous?.get(storeId);
        if (loaded) configs.set(storeId, loaded);
      } else {
        configs.set(storeId, {
          options: parsed.options,
          sha: file.sha,
          commit,
          loadedAt
        });
      }
    }
    return { configs, source, commit, loadedAt, errors };
  }

  async readAllFromDisk(): Promise<ConfigFile[]> {
    const names = await fs.readdir(this.dir);
    const files = await Promise.all(
      names
        .filter((name) => CONFIG_FILE.test(name))
        .map((name) => this.readFromDisk(name))
    );
    return files.filter((file) => file !== undefined);
  }

  async readFromDisk(name: string): Promise<ConfigFile | undefined> {
    try {
      const text = await fs.readFile(path.join(this.dir, name), 'utf8');
      return { name, text, sha: blobSha(text) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  // The last commit that changed the path, undefined when none has
  async latestCommit(repo: string, filePath: string) {
    const commits = await this.github<{ sha: string }[]>(
      `repos/${repo}/commits?sha=${encodeURIComponent(this.branch)}&path=${encodeURIComponent(filePath)}&per_page=1`
    );
    // Not a missing file, it would remove the config of a store
    if (!commits)
      throw new Error(`${repo} or its branch ${this.branch} not found`);
    const sha = commits[0]?.sha;
    if (!sha && filePath === this.dir)
      throw new Error(`No commits found for ${this.dir} on ${this.branch}`);
    return sha;
  }

  async readAllFromGithub(repo: string, commit: string) {
    const contents = await this.github<GithubContent[]>(
      `repos/${repo}/contents/${this.dir}?ref=${commit}`
    );
    if (!contents) throw new Error(`${this.dir} not found at ${commit}`);
    return Promise.all(
      contents
        .filter(
          (entry) => entry.type === 'file' && CONFIG_FILE.test(entry.name)
        )
        .map(async (entry): Promise<ConfigFile> => {
          let text = this.blobCache.get(entry.sha);
          if (text === undefined) {
            text = await this.github<string>(
              `repos/${repo}/contents/${entry.path}?ref=${commit}`,
              true
            );
            if (text === undefined)
              throw new Error(`${entry.path} not found at ${commit}`);
            this.blobCache.set(entry.sha, text);
          }
          return { name: entry.name, text, sha: entry.sha };
        })
    );
  }

  // Undefined when the commit removed the file
  async readFromGithub(
    repo: string,
    filePath: string,
    commit: string
  ): Promise<ConfigFile | undefined> {
    const entry = await this.github<GithubContent>(
      `repos/${repo}/contents/${filePath}?ref=${commit}`
    );
    if (!entry) return undefined;
    let text = this.blobCache.get(entry.sha);
    if (text === undefined) {
      // GitHub leaves out the content of files over 1 MB
      text =
        entry.content !== undefined && entry.content !== ''
          ? Buffer.from(entry.content, 'base64').toString('utf8')
          : await this.github<string>(
              `repos/${repo}/contents/${filePath}?ref=${commit}`,
              true
            );
      if (text === undefined)
        throw new Error(`${filePath} not found at ${commit}`);
      this.blobCache.set(entry.sha, text);
    }
    return { name: entry.name, text, sha: entry.sha };
  }

  // Undefined when GitHub returns 404
  async github<T>(apiPath: string, raw = false): Promise<T | undefined> {
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
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(`GitHub ${apiPath} returned ${response.status}`);
    return (raw ? response.text() : response.json()) as Promise<T>;
  }
}
