/**
 * Read a server's tool surface for `mcp-rc-check surface`, over the same transports `scan` uses.
 *
 * Only the handshake and the list methods are sent: server/discover (falling back to the legacy
 * initialize handshake, in the same order as `scan`, so a lock from a saved scan dump and a lock from a
 * live server agree), then tools/list, prompts/list, resources/list and resources/templates/list, each
 * followed through every page. Unlike `scan`, no probes are sent: no tool is called, no prompt is
 * fetched and no resource is read.
 */
import { FALLBACK_LEGACY_VERSION, META, TARGET_REVISION } from '../spec.js';
import { splitCommand } from '../shellwords.js';
import type { Exchange } from '../dump.js';
import { ALL_PARTS, type RawSurface, type ServerIdentity } from '../surface/normalise.js';
import { isObject, type JsonObject } from '../util.js';
import { HttpTransport } from './http.js';
import { describeCommand, describeUrl, parseEndpoint } from './scan.js';
import { defaultEnvironment, StdioTransport } from './stdio.js';
import { ConnectionError, type Transport } from './transport.js';

export interface SurfaceLiveOptions {
  /** Timeout for each request, in milliseconds. */
  timeoutMs: number;
  /** Version reported in clientInfo. */
  clientVersion: string;
  /** Stop following a list after this many pages (default 100); more pages is an error, not a silent cut. */
  maxPages?: number;
}

export interface SurfaceStdioOptions extends SurfaceLiveOptions {
  /** Extra environment on top of the minimal one. Values are never logged or saved. */
  env?: Record<string, string>;
  cwd?: string;
}

export interface SurfaceHttpOptions extends SurfaceLiveOptions {
  /** Extra headers, for example Authorization. Never written to a lock or a report. */
  headers?: Record<string, string>;
}

type ListField = 'tools' | 'prompts' | 'resources' | 'resourceTemplates';

const LISTS: { method: string; field: ListField; capability: string }[] = [
  { method: 'tools/list', field: 'tools', capability: 'tools' },
  { method: 'prompts/list', field: 'prompts', capability: 'prompts' },
  { method: 'resources/list', field: 'resources', capability: 'resources' },
  { method: 'resources/templates/list', field: 'resourceTemplates', capability: 'resources' },
];

/** Why an exchange has no result, in one line. */
export function describeFailure(ex: Exchange): string {
  if (ex.error) return `JSON-RPC error ${ex.error.code} ${ex.error.message}`;
  if (ex.timedOut) return 'no response within the timeout';
  return ex.transportError ?? 'no result';
}

function identity(info: unknown): ServerIdentity {
  const out: ServerIdentity = {};
  if (!isObject(info)) return out;
  if (typeof info.name === 'string') out.name = info.name;
  if (typeof info.version === 'string') out.version = info.version;
  if (typeof info.title === 'string') out.title = info.title;
  return out;
}

async function listAll(t: Transport, method: string, field: string, meta: JsonObject | undefined, options: SurfaceLiveOptions): Promise<JsonObject[]> {
  const maxPages = options.maxPages ?? 100;
  const items: JsonObject[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const params: JsonObject = { ...(cursor !== undefined ? { cursor } : {}), ...(meta ? { _meta: meta } : {}) };
    const ex = await t.request(method, Object.keys(params).length > 0 ? params : undefined, { timeoutMs: options.timeoutMs });
    pages++;
    if (!ex.result) {
      // Templates are optional even for servers with the resources capability.
      if (method === 'resources/templates/list' && ex.error?.code === -32601) return items;
      throw new ConnectionError(`${method} failed: ${describeFailure(ex)}`);
    }
    const list = ex.result[field];
    if (!Array.isArray(list)) throw new ConnectionError(`${method} returned no "${field}" array`);
    for (const item of list) if (isObject(item)) items.push(item);
    const next = ex.result.nextCursor;
    if (typeof next === 'string' && next !== '') {
      if (seen.has(next)) throw new ConnectionError(`${method} returned the cursor ${JSON.stringify(next)} twice; the pagination loops`);
      if (pages >= maxPages) throw new ConnectionError(`${method} still had more pages after ${maxPages}; raise --max-pages`);
      seen.add(next);
      cursor = next;
    } else cursor = undefined;
  } while (cursor !== undefined);
  return items;
}

/** Run the handshake and every list over a connected transport. */
export async function collectSurface(t: Transport, options: SurfaceLiveOptions): Promise<RawSurface> {
  const clientInfo = { name: 'mcp-rc-check', version: options.clientVersion };
  const surface: RawSurface = { server: {}, tools: [], prompts: [], resources: [], resourceTemplates: [], covers: [...ALL_PARTS] };
  const modernMeta: JsonObject = { [META.protocolVersion]: TARGET_REVISION, [META.clientInfo]: clientInfo, [META.clientCapabilities]: {} };
  let caps: JsonObject;
  let meta: JsonObject | undefined;

  const discover = await t.request('server/discover', { _meta: modernMeta }, { timeoutMs: Math.min(options.timeoutMs, 5000) });
  if (discover.result) {
    meta = modernMeta;
    caps = isObject(discover.result.capabilities) ? discover.result.capabilities : {};
    const resultMeta = isObject(discover.result._meta) ? discover.result._meta : {};
    surface.server = identity(discover.result.serverInfo ?? resultMeta[META.serverInfo]);
    surface.protocolVersion = TARGET_REVISION;
    if (typeof discover.result.instructions === 'string') surface.instructions = discover.result.instructions;
  } else {
    if (discover.transportError && t.kind === 'stdio') throw new ConnectionError(`the server did not answer server/discover: ${discover.transportError}`);
    const init = await t.request(
      'initialize',
      { protocolVersion: FALLBACK_LEGACY_VERSION, capabilities: {}, clientInfo },
      { timeoutMs: options.timeoutMs, headers: { 'mcp-protocol-version': null } },
    );
    if (!init.result) {
      const status = init.http?.status ?? discover.http?.status;
      const hint = status === 401 || status === 403 ? '; the server wants authorization, pass it with -H "Authorization: Bearer <token>"' : '';
      throw new ConnectionError(`neither server/discover (${describeFailure(discover)}) nor initialize (${describeFailure(init)}) succeeded${hint}`);
    }
    caps = isObject(init.result.capabilities) ? init.result.capabilities : {};
    surface.server = identity(init.result.serverInfo);
    if (typeof init.result.protocolVersion === 'string') surface.protocolVersion = init.result.protocolVersion;
    if (typeof init.result.instructions === 'string') surface.instructions = init.result.instructions;
    if (t instanceof HttpTransport && surface.protocolVersion) t.legacyVersion = surface.protocolVersion;
    await t.notify('notifications/initialized');
  }
  for (const list of LISTS) {
    if (!(list.capability in caps)) continue;
    // Parsed from JSON-RPC, so every value is JSON.
    surface[list.field] = (await listAll(t, list.method, list.field, meta, options)) as RawSurface[ListField];
  }
  return surface;
}

/** Start a stdio server with the minimal environment plus `env`, and read its surface. */
export async function collectStdio(command: string | string[], options: SurfaceStdioOptions): Promise<{ surface: RawSurface; target: string }> {
  let words: string[];
  if (Array.isArray(command)) words = command;
  else {
    try {
      words = splitCommand(command);
    } catch (error) {
      throw new ConnectionError((error as Error).message);
    }
  }
  if (words.length === 0 || words[0] === '') throw new ConnectionError('empty --stdio command');
  const t = new StdioTransport(words[0]!, words.slice(1), { ...defaultEnvironment(), ...(options.env ?? {}) }, options.cwd);
  try {
    return { surface: await collectSurface(t, options), target: describeCommand(words) };
  } catch (error) {
    const tail = t.stderrTail.join('').trim();
    if (error instanceof ConnectionError && tail) {
      throw new ConnectionError(`${error.message}\nserver stderr (last lines):\n${tail.split('\n').slice(-10).join('\n')}`);
    }
    throw error;
  } finally {
    await t.close();
  }
}

/** Read the surface of a Streamable HTTP endpoint. A URL with credentials in it is refused. */
export async function collectHttp(rawUrl: string, options: SurfaceHttpOptions): Promise<{ surface: RawSurface; target: string }> {
  const url = parseEndpoint(rawUrl, false);
  const t = new HttpTransport(url, options.headers ?? {});
  try {
    return { surface: await collectSurface(t, options), target: describeUrl(url) };
  } finally {
    await t.close();
  }
}
