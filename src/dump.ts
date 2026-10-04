import { join } from './pointer.js';
import { LIST_FIELD } from './spec.js';
import type { Era } from './types.js';
import { isObject, type JsonObject } from './util.js';

/** A JSON-RPC error object as received. */
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** HTTP facts recorded for an exchange. Header values are never stored, only whether a header was present. */
export interface HttpFacts {
  status: number;
  contentType?: string;
  /** True when the response carried an Mcp-Session-Id header. */
  sessionIdHeader?: boolean;
}

/** One request and what came back. */
export interface Exchange {
  method: string;
  result?: JsonObject;
  error?: RpcError;
  /** No response within the timeout. */
  timedOut?: boolean;
  /** The transport failed (connection refused, malformed body, process exited). */
  transportError?: string;
  http?: HttpFacts;
}

/** Probes run against a live server. Each is a read-only request. */
export interface Probes {
  /** server/discover with protocol version 1900-01-01: expects UnsupportedProtocolVersionError. */
  unsupportedVersion?: Exchange;
  /** resources/read of a URI that does not exist: expects -32602. */
  resourceNotFound?: Exchange;
  /** initialize sent last to a modern server: a modern-only server SHOULD name its versions in the error. */
  initializeOnModern?: Exchange;
  /** HTTP: MCP-Protocol-Version header that differs from the body: expects 400 and -32020. */
  headerMismatch?: Exchange;
  /** HTTP: POST without Mcp-Method: expects 400 and -32020. */
  missingMethodHeader?: Exchange;
  /** HTTP: an unknown method: expects 404 and -32601. */
  unknownMethod?: Exchange;
  /** HTTP: GET to the endpoint: SHOULD be 405. */
  httpGet?: { status: number; contentType?: string; transportError?: string };
}

/**
 * The dump format mcp-rc-check writes with --save-dump and reads with --dump.
 * Hand-made dumps may also be a bare tools/list (or other list) result, a server/discover result,
 * an initialize result, a JSON-RPC response wrapping one of those, or an array of those.
 */
export interface Dump {
  mcpRcCheckDump: 1;
  source: { kind: 'stdio' | 'http'; target: string };
  era: Era;
  discover?: Exchange;
  initialize?: Exchange;
  /** Pages of each list method, in order. */
  lists: Record<string, Exchange[]>;
  /** A second tools/list (first page only), to check ordering. */
  toolsRepeat?: Exchange;
  probes: Probes;
  /** Client capabilities, when the dump captures a client's request. */
  clientCapabilities?: JsonObject;
}

export interface ResultRef {
  method: string;
  result: JsonObject;
  /** Pointer to the result object in the input document. */
  ptr: string;
  page: number;
  /** The exchange that produced the result (canonical dumps only), and its pointer. */
  exchange?: Exchange;
  exchangePtr?: string;
}

export interface ToolRef {
  name: string;
  tool: JsonObject;
  ptr: string;
}

/** A normalised view of any accepted input, with pointers back into the input document. */
export interface View {
  doc: unknown;
  canonical: boolean;
  transport: 'stdio' | 'http' | 'file';
  era: Era;
  discover?: { exchange: Exchange; ptr: string };
  initialize?: { exchange: Exchange; ptr: string };
  /** Every complete or interim result captured, discover first. */
  results: ResultRef[];
  lists: Record<string, ResultRef[]>;
  tools: ToolRef[];
  toolsRepeat?: ResultRef;
  capabilities?: { value: JsonObject; ptr: string };
  serverInfo?: JsonObject;
  probes: Probes;
  clientCapabilities?: { value: JsonObject; ptr: string };
}

export class DumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DumpError';
  }
}

function emptyView(doc: unknown, canonical: boolean, transport: View['transport']): View {
  return { doc, canonical, transport, era: 'unknown', results: [], lists: {}, tools: [], probes: {} };
}

function addListPage(view: View, method: string, result: JsonObject, ptr: string, exchange?: Exchange, exchangePtr?: string): void {
  const pages = (view.lists[method] ??= []);
  const ref: ResultRef = { method, result, ptr, page: pages.length, ...(exchange ? { exchange, exchangePtr } : {}) };
  pages.push(ref);
  view.results.push(ref);
  if (method === 'tools/list' && Array.isArray(result.tools)) {
    result.tools.forEach((tool, i) => {
      if (isObject(tool)) {
        view.tools.push({ name: typeof tool.name === 'string' ? tool.name : `#${i}`, tool, ptr: join(ptr, 'tools', i) });
      }
    });
  }
}

function serverInfoFromResult(result: JsonObject): JsonObject | undefined {
  const meta = result._meta;
  if (isObject(meta) && isObject(meta['io.modelcontextprotocol/serverInfo'])) {
    return meta['io.modelcontextprotocol/serverInfo'] as JsonObject;
  }
  return undefined;
}

function normaliseCanonical(doc: JsonObject): View {
  const kind = isObject(doc.source) && doc.source.kind === 'http' ? 'http' : 'stdio';
  const view = emptyView(doc, true, kind);
  const dump = doc as unknown as Dump;
  view.era = (['modern', 'legacy', 'dual', 'unknown'] as const).includes(dump.era) ? dump.era : 'unknown';
  if (isObject(dump.discover)) {
    view.discover = { exchange: dump.discover, ptr: '/discover/result' };
    const result = dump.discover.result;
    if (isObject(result)) {
      view.results.push({ method: 'server/discover', result, ptr: '/discover/result', page: 0, exchange: dump.discover, exchangePtr: '/discover' });
      if (isObject(result.capabilities)) view.capabilities = { value: result.capabilities, ptr: '/discover/result/capabilities' };
      view.serverInfo = serverInfoFromResult(result);
    }
  }
  if (isObject(dump.initialize)) {
    view.initialize = { exchange: dump.initialize, ptr: '/initialize/result' };
    const result = dump.initialize.result;
    if (isObject(result)) {
      if (!view.capabilities && isObject(result.capabilities)) {
        view.capabilities = { value: result.capabilities, ptr: '/initialize/result/capabilities' };
      }
      if (!view.serverInfo && isObject(result.serverInfo)) view.serverInfo = result.serverInfo;
    }
  }
  if (isObject(dump.lists)) {
    for (const [method, pages] of Object.entries(dump.lists)) {
      if (!Array.isArray(pages)) continue;
      pages.forEach((page, i) => {
        if (isObject(page) && isObject(page.result)) {
          addListPage(view, method, page.result, join('/lists', method, i, 'result'), page as Exchange, join('/lists', method, i));
        }
      });
    }
  }
  if (isObject(dump.toolsRepeat) && isObject(dump.toolsRepeat.result)) {
    view.toolsRepeat = { method: 'tools/list', result: dump.toolsRepeat.result, ptr: '/toolsRepeat/result', page: 0 };
  }
  if (isObject(dump.probes)) {
    view.probes = dump.probes;
    const read = dump.probes.resourceNotFound;
    if (isObject(read) && isObject(read.result)) {
      view.results.push({ method: 'resources/read', result: read.result, ptr: '/probes/resourceNotFound/result', page: 0 });
    }
  }
  if (isObject(dump.clientCapabilities)) {
    view.clientCapabilities = { value: dump.clientCapabilities, ptr: '/clientCapabilities' };
  }
  return view;
}

function looksLikeTool(value: unknown): boolean {
  return isObject(value) && typeof value.name === 'string' && 'inputSchema' in value;
}

/** Interpret one loose object (a result, a JSON-RPC message, or a captured request). */
function normaliseLoose(view: View, value: unknown, ptr: string): void {
  if (!isObject(value)) return;
  if (value.jsonrpc === '2.0' && isObject(value.result)) {
    normaliseLoose(view, value.result, join(ptr, 'result'));
    return;
  }
  if (typeof value.method === 'string' && isObject(value.params)) {
    const params = value.params;
    if (isObject(params.capabilities) && value.method === 'initialize') {
      view.clientCapabilities = { value: params.capabilities, ptr: join(ptr, 'params', 'capabilities') };
    }
    const meta = params._meta;
    if (isObject(meta) && isObject(meta['io.modelcontextprotocol/clientCapabilities'])) {
      view.clientCapabilities = {
        value: meta['io.modelcontextprotocol/clientCapabilities'] as JsonObject,
        ptr: join(ptr, 'params', '_meta', 'io.modelcontextprotocol/clientCapabilities'),
      };
    }
    return;
  }
  if (Array.isArray(value.supportedVersions)) {
    view.discover = { exchange: { method: 'server/discover', result: value }, ptr };
    view.results.push({ method: 'server/discover', result: value, ptr, page: 0 });
    view.serverInfo = serverInfoFromResult(value) ?? view.serverInfo;
  } else if (typeof value.protocolVersion === 'string' && isObject(value.capabilities)) {
    view.initialize = { exchange: { method: 'initialize', result: value }, ptr };
    if (isObject(value.serverInfo)) view.serverInfo ??= value.serverInfo;
  }
  if (isObject(value.capabilities) && !view.capabilities) {
    view.capabilities = { value: value.capabilities, ptr: join(ptr, 'capabilities') };
  }
  for (const [method, field] of Object.entries(LIST_FIELD)) {
    if (Array.isArray(value[field])) addListPage(view, method, value, ptr);
  }
}

/** Normalise any accepted input document into a View. */
export function normalise(doc: unknown): View {
  if (isObject(doc) && doc.mcpRcCheckDump === 1) return normaliseCanonical(doc);
  const view = emptyView(doc, false, 'file');
  if (Array.isArray(doc)) {
    if (doc.length > 0 && doc.every(looksLikeTool)) {
      doc.forEach((tool, i) => view.tools.push({ name: (tool as JsonObject).name as string, tool: tool as JsonObject, ptr: join('', i) }));
    } else {
      doc.forEach((item, i) => normaliseLoose(view, item, join('', i)));
    }
  } else {
    normaliseLoose(view, doc, '');
  }
  view.era = view.discover && view.initialize ? 'dual' : view.discover ? 'modern' : view.initialize ? 'legacy' : 'unknown';
  if (
    !view.discover &&
    !view.initialize &&
    view.results.length === 0 &&
    view.tools.length === 0 &&
    !view.capabilities &&
    !view.clientCapabilities
  ) {
    throw new DumpError(
      'nothing to check: expected an mcp-rc-check dump, a list result (tools, resources, resourceTemplates or prompts), a server/discover or initialize result, or a JSON-RPC response wrapping one',
    );
  }
  return view;
}
