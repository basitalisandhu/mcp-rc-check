/**
 * The raw tool surface a server exposes, and its normalised form.
 *
 * Normalisation removes differences that do not change what a client or a model sees:
 * object key order, runs of ASCII whitespace in descriptions and titles, the order of
 * `required` entries in a JSON Schema, and `_meta`. Everything else, including every
 * non-ASCII character, is kept on purpose: an invisible character added to a description
 * is exactly the kind of change surface pinning exists to report. See docs/surface.md.
 */
import { isObject, sortKeys, type Json, type JsonObject } from './json.js';

export class SurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceError';
  }
}

export interface ServerIdentity {
  name?: string;
  version?: string;
  title?: string;
}

/** What a server said, before normalisation. Produced by a live connection or read from a dump. */
export interface RawSurface {
  server: ServerIdentity;
  protocolVersion?: string;
  instructions?: string;
  tools: JsonObject[];
  prompts: JsonObject[];
  resources: JsonObject[];
  resourceTemplates: JsonObject[];
  /**
   * Which parts this surface describes. A live server covers everything (a list the server has no
   * capability for is known to be empty); a dump covers only what it contains. `server` covers the
   * identity, the protocol version and the instructions.
   */
  covers: Part[];
}

export type Part = 'tools' | 'prompts' | 'resources' | 'server';
export const ALL_PARTS: Part[] = ['tools', 'prompts', 'resources', 'server'];

export interface NormalisedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Json;
  outputSchema?: Json;
  annotations?: JsonObject;
  execution?: Json;
  icons?: Json;
  /** Any other top-level field the tool carries, except `_meta`. */
  other?: JsonObject;
}

export interface NormalisedSurface {
  server: ServerIdentity;
  protocolVersion?: string;
  instructions?: string;
  tools: Record<string, NormalisedTool>;
  toolOrder: string[];
  prompts: Record<string, JsonObject>;
  resources: Record<string, JsonObject>;
  resourceTemplates: Record<string, JsonObject>;
  covers: Part[];
}

const ASCII_WS = /[ \t\n\r\f\v]+/g;

/** Collapse runs of ASCII whitespace to one space and trim. Unicode spaces and invisible characters are kept. */
export function normaliseText(text: string): string {
  return text.replace(ASCII_WS, ' ').replace(/^ | $/g, '');
}

const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_KEYWORDS = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'contentSchema',
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const TEXT_KEYWORDS = new Set(['description', 'title', '$comment']);

/**
 * Canonicalise a JSON Schema: sorted keys (applied when serialising), whitespace-normalised
 * annotation text, and `required` as a sorted, de-duplicated list. Keywords are only treated as
 * keywords where JSON Schema puts them, so a property called "description" is left alone.
 */
export function canonicaliseSchema(schema: unknown): Json {
  if (Array.isArray(schema)) return schema.map((s) => canonicaliseSchema(s));
  if (!isObject(schema)) return sortKeys(schema);
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isObject(value)) {
      const map: JsonObject = {};
      for (const [name, sub] of Object.entries(value)) map[name] = canonicaliseSchema(sub);
      out[key] = map;
    } else if (SCHEMA_KEYWORDS.has(key)) {
      out[key] = canonicaliseSchema(value);
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      out[key] = value.map((s) => canonicaliseSchema(s));
    } else if (TEXT_KEYWORDS.has(key) && typeof value === 'string') {
      out[key] = normaliseText(value);
    } else if (key === 'required' && Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out[key] = [...new Set(value as string[])].sort();
    } else {
      out[key] = sortKeys(value);
    }
  }
  return sortKeys(out);
}

const TOOL_FIELDS = new Set(['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations', 'execution', 'icons', '_meta']);

export function normaliseTool(tool: JsonObject): NormalisedTool {
  if (typeof tool.name !== 'string' || tool.name === '') throw new SurfaceError('a tool has no name');
  const t: NormalisedTool = { name: tool.name, inputSchema: canonicaliseSchema(tool.inputSchema ?? null) };
  if (typeof tool.title === 'string') t.title = normaliseText(tool.title);
  if (typeof tool.description === 'string') t.description = normaliseText(tool.description);
  if (tool.outputSchema !== undefined) t.outputSchema = canonicaliseSchema(tool.outputSchema);
  if (isObject(tool.annotations)) {
    const a: JsonObject = {};
    for (const [k, v] of Object.entries(tool.annotations)) a[k] = k === 'title' && typeof v === 'string' ? normaliseText(v) : sortKeys(v);
    t.annotations = sortKeys(a) as JsonObject;
  }
  if (tool.execution !== undefined) t.execution = sortKeys(tool.execution);
  if (tool.icons !== undefined) t.icons = sortKeys(tool.icons);
  const other: JsonObject = {};
  for (const [k, v] of Object.entries(tool)) if (!TOOL_FIELDS.has(k)) other[k] = sortKeys(v);
  if (Object.keys(other).length > 0) t.other = sortKeys(other) as JsonObject;
  return t;
}

/** Prompts, resources and templates: drop `_meta`, normalise text fields, sort keys. */
function normaliseEntry(entry: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === '_meta') continue;
    if (TEXT_KEYWORDS.has(k) && typeof v === 'string') out[k] = normaliseText(v);
    else if (k === 'arguments' && Array.isArray(v)) {
      out[k] = v.map((arg) => (isObject(arg) ? normaliseEntry(arg) : sortKeys(arg)));
    } else out[k] = sortKeys(v);
  }
  return sortKeys(out) as JsonObject;
}

function keyed(entries: JsonObject[], key: string, what: string): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = {};
  for (const e of entries) {
    const id = e[key];
    if (typeof id !== 'string' || id === '') throw new SurfaceError(`a ${what} has no ${key}`);
    if (id in out) throw new SurfaceError(`the server lists ${what} ${JSON.stringify(id)} twice`);
    out[id] = normaliseEntry(e);
  }
  return out;
}

export function normaliseSurface(raw: RawSurface): NormalisedSurface {
  const tools: Record<string, NormalisedTool> = {};
  const toolOrder: string[] = [];
  for (const tool of raw.tools) {
    const t = normaliseTool(tool);
    if (t.name in tools) throw new SurfaceError(`the server lists tool ${JSON.stringify(t.name)} twice`);
    tools[t.name] = t;
    toolOrder.push(t.name);
  }
  const server: ServerIdentity = {};
  if (raw.server.name !== undefined) server.name = raw.server.name;
  if (raw.server.version !== undefined) server.version = raw.server.version;
  if (raw.server.title !== undefined) server.title = raw.server.title;
  return {
    server,
    ...(raw.protocolVersion !== undefined ? { protocolVersion: raw.protocolVersion } : {}),
    ...(raw.instructions !== undefined ? { instructions: normaliseText(raw.instructions) } : {}),
    tools,
    toolOrder,
    prompts: keyed(raw.prompts, 'name', 'prompt'),
    resources: keyed(raw.resources, 'uri', 'resource'),
    resourceTemplates: keyed(raw.resourceTemplates, 'uriTemplate', 'resource template'),
    covers: ALL_PARTS.filter((p) => raw.covers.includes(p)),
  };
}

/** Effective annotation hints, with the defaults the MCP specification gives for absent hints. */
export interface EffectiveHints {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
  annotated: boolean;
}

export function effectiveHints(tool: NormalisedTool): EffectiveHints {
  const a = tool.annotations ?? {};
  const readOnly = a.readOnlyHint === true;
  return {
    readOnly,
    // destructiveHint defaults to true and is meaningful only when readOnlyHint is false.
    destructive: !readOnly && a.destructiveHint !== false,
    idempotent: a.idempotentHint === true,
    openWorld: a.openWorldHint !== false,
    annotated: tool.annotations !== undefined && ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].some((k) => k in a),
  };
}
