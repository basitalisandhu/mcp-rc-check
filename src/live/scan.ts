import path from 'node:path';
import type { Dump, Exchange } from '../dump.js';
import { splitCommand } from '../shellwords.js';
import {
  FALLBACK_LEGACY_VERSION,
  LIST_CAPABILITY,
  LIST_FIELD,
  META,
  MODERN_ERROR_CODES,
  TARGET_REVISION,
} from '../spec.js';
import { isObject, type JsonObject } from '../util.js';
import { HttpTransport } from './http.js';
import { defaultEnvironment, StdioTransport } from './stdio.js';
import { ConnectionError, type Transport } from './transport.js';

export interface LiveOptions {
  /** Timeout for each request, in milliseconds. */
  timeoutMs: number;
  /** Timeout for the first server/discover probe; a legacy stdio server may never answer it. */
  probeTimeoutMs?: number;
  /** Extra environment for a stdio server. */
  env?: Record<string, string>;
  /** Extra headers for an HTTP server (for example Authorization). Never written to the dump. */
  headers?: Record<string, string>;
  /** Version reported in clientInfo. */
  clientVersion: string;
  /** Stop paginating a list after this many pages. */
  maxPages?: number;
}

/** A URI that should not exist on any server, used for the resource-not-found probe. */
export const MISSING_RESOURCE_URI = 'mcp-rc-check://probe/does-not-exist';

function modernMeta(version: string, clientVersion: string): JsonObject {
  return {
    [META.protocolVersion]: version,
    [META.clientInfo]: { name: 'mcp-rc-check', version: clientVersion },
    [META.clientCapabilities]: {},
  };
}

function isModernResponse(ex: Exchange): boolean {
  return ex.result !== undefined || (ex.error !== undefined && MODERN_ERROR_CODES.includes(ex.error.code));
}

async function listAll(t: Transport, dump: Dump, caps: JsonObject, meta: JsonObject | undefined, options: LiveOptions): Promise<void> {
  const maxPages = options.maxPages ?? 50;
  for (const method of Object.keys(LIST_FIELD)) {
    if (!(LIST_CAPABILITY[method]! in caps)) continue;
    const pages: Exchange[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const params: JsonObject = { ...(cursor !== undefined ? { cursor } : {}), ...(meta ? { _meta: meta } : {}) };
      const ex = await t.request(method, Object.keys(params).length > 0 ? params : undefined, { timeoutMs: options.timeoutMs });
      pages.push(ex);
      const next = ex.result?.nextCursor;
      cursor = typeof next === 'string' && !seen.has(next) && pages.length < maxPages ? next : undefined;
      if (cursor !== undefined) seen.add(cursor);
    } while (cursor !== undefined);
    dump.lists[method] = pages;
  }
  if ('tools' in caps) {
    dump.toolsRepeat = await t.request('tools/list', meta ? { _meta: meta } : undefined, { timeoutMs: options.timeoutMs });
  }
}

/** Run the scan sequence over a connected transport and return the dump. Read-only requests only. */
export async function runScan(t: Transport, source: Dump['source'], options: LiveOptions): Promise<Dump> {
  // Keys are created in output order; unset ones are dropped when the dump is serialised.
  const dump: Dump = { mcpRcCheckDump: 1, source, era: 'unknown', discover: undefined, initialize: undefined, lists: {}, toolsRepeat: undefined, probes: {} };
  const meta = modernMeta(TARGET_REVISION, options.clientVersion);
  const probeTimeout = options.probeTimeoutMs ?? Math.min(options.timeoutMs, 5000);

  dump.discover = await t.request('server/discover', { _meta: meta }, { timeoutMs: probeTimeout });
  if (isModernResponse(dump.discover)) {
    dump.era = 'modern';
    const caps = isObject(dump.discover.result?.capabilities) ? dump.discover.result.capabilities : {};
    if (dump.discover.result) await listAll(t, dump, caps, meta, options);
    dump.probes.unsupportedVersion = await t.request('server/discover', { _meta: modernMeta('1900-01-01', options.clientVersion) }, { timeoutMs: options.timeoutMs });
    if ('resources' in caps) {
      dump.probes.resourceNotFound = await t.request('resources/read', { uri: MISSING_RESOURCE_URI, _meta: meta }, { timeoutMs: options.timeoutMs });
    }
    if (t instanceof HttpTransport) {
      dump.probes.headerMismatch = await t.request('server/discover', { _meta: meta }, { timeoutMs: options.timeoutMs, headers: { 'mcp-protocol-version': FALLBACK_LEGACY_VERSION } });
      dump.probes.missingMethodHeader = await t.request('server/discover', { _meta: meta }, { timeoutMs: options.timeoutMs, headers: { 'mcp-method': null } });
      dump.probes.unknownMethod = await t.request('mcp-rc-check/unknown-method', { _meta: meta }, { timeoutMs: options.timeoutMs });
      dump.probes.httpGet = await t.probeGet(options.timeoutMs);
    }
    // Last, because initialize may switch a dual-era stdio process to legacy semantics.
    dump.probes.initializeOnModern = await t.request(
      'initialize',
      { protocolVersion: FALLBACK_LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'mcp-rc-check', version: options.clientVersion } },
      { timeoutMs: options.timeoutMs, headers: { 'mcp-protocol-version': null } },
    );
    if (dump.probes.initializeOnModern.result) dump.era = 'dual';
    return dump;
  }

  // Legacy fallback: the initialize handshake of 2025-11-25 and earlier.
  if (dump.discover.transportError && t.kind === 'stdio') {
    throw new ConnectionError(`the server did not answer server/discover: ${dump.discover.transportError}`);
  }
  dump.initialize = await t.request(
    'initialize',
    { protocolVersion: FALLBACK_LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'mcp-rc-check', version: options.clientVersion } },
    { timeoutMs: options.timeoutMs, headers: { 'mcp-protocol-version': null } },
  );
  const init = dump.initialize.result;
  if (!init) {
    const why = dump.initialize.error
      ? `error ${dump.initialize.error.code} ${dump.initialize.error.message}`
      : dump.initialize.timedOut
        ? 'no response within the timeout'
        : (dump.initialize.transportError ?? 'no response');
    const probe = dump.discover.error ? `error ${dump.discover.error.code}` : dump.discover.timedOut ? 'no response' : (dump.discover.transportError ?? 'no result');
    const status = dump.initialize.http?.status ?? dump.discover.http?.status;
    const hint = status === 401 || status === 403 ? '; the server wants authorization, pass it with -H "Authorization: Bearer <token>"' : '';
    throw new ConnectionError(`neither server/discover (${probe}) nor initialize (${why}) succeeded${hint}`);
  }
  dump.era = 'legacy';
  if (t instanceof HttpTransport && typeof init.protocolVersion === 'string') t.legacyVersion = init.protocolVersion;
  await t.notify('notifications/initialized');
  const caps = isObject(init.capabilities) ? init.capabilities : {};
  await listAll(t, dump, caps, undefined, options);
  return dump;
}

/** Describe a stdio command without its arguments, which may carry secrets. */
export function describeCommand(words: string[]): string {
  const program = path.basename(words[0] ?? '');
  const n = words.length - 1;
  return n === 0 ? program : `${program} (+${n} argument${n === 1 ? '' : 's'})`;
}

/** Describe a URL without credentials or query string. */
export function describeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export async function scanStdio(command: string, options: LiveOptions): Promise<Dump> {
  let words: string[];
  try {
    words = splitCommand(command);
  } catch (error) {
    throw new ConnectionError((error as Error).message);
  }
  if (words.length === 0) throw new ConnectionError('empty --stdio command');
  const t = new StdioTransport(words[0]!, words.slice(1), { ...defaultEnvironment(), ...(options.env ?? {}) });
  try {
    return await runScan(t, { kind: 'stdio', target: describeCommand(words) }, options);
  } catch (error) {
    const tail = t.stderrTail.join('').trim();
    if (error instanceof ConnectionError && tail) {
      throw new ConnectionError(`${error.message}\nserver stderr:\n${tail.split('\n').slice(-15).join('\n')}`);
    }
    throw error;
  } finally {
    await t.close();
  }
}

/**
 * Parse and check an endpoint URL: http or https only, and no credentials in it. The error for an
 * unparsable URL quotes it only when `quote` is set, since a URL that fails to parse may still carry a secret.
 */
export function parseEndpoint(rawUrl: string, quote = true): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConnectionError(quote ? `invalid URL ${JSON.stringify(rawUrl)}` : 'invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConnectionError(`unsupported URL scheme ${url.protocol}`);
  if (url.username || url.password) throw new ConnectionError('the URL contains credentials; pass them with -H "Authorization: ..." instead');
  return url;
}

export async function scanHttp(rawUrl: string, options: LiveOptions): Promise<Dump> {
  const url = parseEndpoint(rawUrl);
  const t = new HttpTransport(url, options.headers ?? {});
  try {
    return await runScan(t, { kind: 'http', target: describeUrl(url) }, options);
  } finally {
    await t.close();
  }
}
