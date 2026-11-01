// Keeps the managed schemas of the Solr cores in sync with
// solr-configsets/<core>/conf/schema.xml. Field types, fields, dynamic fields
// and copy fields that are missing are added and the ones that differ are
// replaced. Nothing is removed.
import fs from 'node:fs/promises';
import path from 'node:path';

const SOLR_URL = process.env.SOLR_URL ?? 'http://localhost:8983/solr';
const CONFIGSET_DIR = process.env.SOLR_CONFIGSET_DIR ?? 'solr-configsets';

interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
}

type SchemaObject = Record<string, unknown>;

interface Schema {
  fieldTypes: SchemaObject[];
  fields: SchemaObject[];
  dynamicFields: SchemaObject[];
  copyFields: { source: string; dest: string }[];
}

const decode = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

// Elements and attributes only, text content is not needed for the schema
export const parseXml = (text: string): XmlElement => {
  const source = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  const root: XmlElement = { name: '#root', attributes: {}, children: [] };
  const stack = [root];
  const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  for (const [, closing, name, attributeText, selfClosing] of source.matchAll(
    tag
  )) {
    if (closing) {
      stack.pop();
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const [, key, value] of attributeText.matchAll(
      /([\w:.-]+)\s*=\s*"([^"]*)"/g
    ))
      attributes[key] = decode(value);
    const element = { name, attributes, children: [] };
    stack[stack.length - 1].children.push(element);
    if (!selfClosing) stack.push(element);
  }
  const schema = root.children.find((child) => child.name === 'schema');
  if (!schema) throw new Error('No <schema> element');
  return schema;
};

// Field and field type properties are booleans in the Schema API
const typed = (attributes: Record<string, string>): SchemaObject =>
  Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      value === 'true' ? true : value === 'false' ? false : value
    ])
  );

const ANALYZER_KEYS: Record<string, string> = {
  index: 'indexAnalyzer',
  query: 'queryAnalyzer',
  multiterm: 'multiTermAnalyzer'
};

const toFieldType = (element: XmlElement): SchemaObject => {
  const fieldType = typed(element.attributes);
  for (const analyzer of element.children.filter(
    (c) => c.name === 'analyzer'
  )) {
    const { type, ...attributes } = analyzer.attributes;
    const json: SchemaObject = { ...attributes };
    const of = (name: string) =>
      analyzer.children.filter((c) => c.name === name).map((c) => c.attributes);
    const tokenizer = of('tokenizer')[0];
    if (tokenizer) json.tokenizer = tokenizer;
    if (of('filter').length) json.filters = of('filter');
    if (of('charFilter').length) json.charFilters = of('charFilter');
    fieldType[type ? (ANALYZER_KEYS[type] ?? 'analyzer') : 'analyzer'] = json;
  }
  return fieldType;
};

export const schemaFromXml = (text: string): Schema => {
  const schema = parseXml(text);
  const all = (name: string) => schema.children.filter((c) => c.name === name);
  return {
    fieldTypes: all('fieldType').map(toFieldType),
    fields: all('field').map((e) => typed(e.attributes)),
    dynamicFields: all('dynamicField').map((e) => typed(e.attributes)),
    copyFields: all('copyField').map((e) => ({
      source: e.attributes.source,
      dest: e.attributes.dest
    }))
  };
};

// Solr returns some values as strings and some as numbers or booleans, so
// values are compared as strings and keys in sorted order
const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize((value as SchemaObject)[key])])
    );
  return String(value);
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

const solr = async <T>(url: string, body?: unknown): Promise<T> => {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = (await response.json()) as T & { error?: { msg?: string } };
  if (!response.ok)
    throw new Error(
      `Solr ${url} returned ${response.status}: ${json.error?.msg ?? ''}`
    );
  return json;
};

// The Schema API commands that bring the core to the desired schema
export const schemaCommands = (desired: Schema, current: Schema) => {
  const commands: { command: string; value: unknown; label: string }[] = [];
  const sync = (
    wanted: SchemaObject[],
    existing: SchemaObject[],
    kind: 'field-type' | 'field' | 'dynamic-field'
  ) => {
    for (const item of wanted) {
      const found = existing.find((e) => e.name === item.name);
      if (!found)
        commands.push({
          command: `add-${kind}`,
          value: item,
          label: `add ${kind} ${String(item.name)}`
        });
      else if (!same(found, item))
        commands.push({
          command: `replace-${kind}`,
          value: item,
          label: `replace ${kind} ${String(item.name)}`
        });
    }
  };
  sync(desired.fieldTypes, current.fieldTypes, 'field-type');
  sync(desired.fields, current.fields, 'field');
  sync(desired.dynamicFields, current.dynamicFields, 'dynamic-field');
  for (const copyField of desired.copyFields) {
    if (
      !current.copyFields.some(
        (c) => c.source === copyField.source && c.dest === copyField.dest
      )
    )
      commands.push({
        command: 'add-copy-field',
        value: copyField,
        label: `add copy field ${copyField.source} -> ${copyField.dest}`
      });
  }
  return commands;
};

const syncCore = async (core: string) => {
  const xml = await fs.readFile(
    path.join(CONFIGSET_DIR, core, 'conf', 'schema.xml'),
    'utf8'
  );
  const desired = schemaFromXml(xml);
  const status = await solr<{ status: Record<string, { name?: string }> }>(
    `${SOLR_URL}/admin/cores?action=STATUS&core=${encodeURIComponent(core)}`
  );
  if (!status.status[core]?.name) {
    console.log(
      `Solr core ${core} does not exist, it is created from the configset when Solr starts (see docker-compose.yml)`
    );
    return [];
  }
  const { schema: current } = await solr<{ schema: Schema }>(
    `${SOLR_URL}/${core}/schema`
  );
  const commands = schemaCommands(desired, current);
  // One request per command, so a failure says which change Solr refused
  for (const { command, value, label } of commands) {
    await solr(`${SOLR_URL}/${core}/schema`, { [command]: value });
    console.log(`Solr ${core}: ${label}`);
  }
  return commands.map((c) => c.label);
};

// Returns the cores whose schema changed, their documents need reindexing
export const syncSolrSchemas = async (): Promise<string[]> => {
  const cores = (await fs.readdir(CONFIGSET_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const changed: string[] = [];
  for (const core of cores) {
    try {
      if ((await syncCore(core)).length > 0) changed.push(core);
    } catch (e) {
      console.log(`Syncing the schema of Solr core ${core} failed`, e);
    }
  }
  console.log(
    changed.length
      ? `Solr schemas updated: ${changed.join(', ')}`
      : 'Solr schemas are up to date'
  );
  return changed;
};
