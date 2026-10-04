/**
 * Read a saved surface from a JSON file instead of a live server. Accepted shapes:
 *
 * - a dump written by `mcp-rc-check scan --save-dump` (`"mcpRcCheckDump": 1`), so one saved scan can
 *   be both checked against the specification and locked;
 * - an object with a `tools` array (a tools/list result), optionally with `serverInfo`,
 *   `protocolVersion`, `instructions`, `prompts`, `resources` and `resourceTemplates`;
 * - a JSON-RPC response wrapping such a result;
 * - an array of tools/list pages (each `{tools, nextCursor}`, or JSON-RPC responses), which are joined;
 * - a bare array of tools.
 */
import { readFileSync } from 'node:fs';
import { ERROR_CODE, META, TARGET_REVISION } from '../spec.js';
import { isObject, type JsonObject } from './json.js';
import { ALL_PARTS, SurfaceError, type Part, type RawSurface, type ServerIdentity } from './normalise.js';

function objects(value: unknown, what: string): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SurfaceError(`"${what}" is not an array`);
  return value.filter(isObject);
}

function identity(value: unknown): ServerIdentity {
  const out: ServerIdentity = {};
  if (isObject(value)) {
    if (typeof value.name === 'string') out.name = value.name;
    if (typeof value.version === 'string') out.version = value.version;
    if (typeof value.title === 'string') out.title = value.title;
  }
  return out;
}

function unwrap(value: unknown): unknown {
  return isObject(value) && value.jsonrpc === '2.0' && isObject(value.result) ? value.result : value;
}

/** Join list pages, checking that every page but the last points at a next one. */
function joinPages(pages: unknown[], field: string): JsonObject[] {
  const out: JsonObject[] = [];
  pages.forEach((p, i) => {
    const page = unwrap(p);
    if (!isObject(page) || !Array.isArray(page[field])) throw new SurfaceError(`page ${i + 1} has no "${field}" array`);
    const last = i === pages.length - 1;
    const next = page.nextCursor;
    if (last && typeof next === 'string' && next !== '') throw new SurfaceError(`the last page of ${field} has a nextCursor; the dump is missing pages`);
    if (!last && (typeof next !== 'string' || next === '')) throw new SurfaceError(`page ${i + 1} of ${field} has no nextCursor but more pages follow`);
    out.push(...objects(page[field], field));
  });
  return out;
}

function parts(flags: Record<Part, boolean>): Part[] {
  return ALL_PARTS.filter((p) => flags[p]);
}

function fromResult(doc: JsonObject): RawSurface {
  if (typeof doc.nextCursor === 'string' && doc.nextCursor !== '') {
    throw new SurfaceError('the dump is one page of a paginated tools/list (it has a nextCursor); save every page as a JSON array of pages');
  }
  const surface: RawSurface = {
    server: identity(doc.serverInfo ?? doc.server),
    tools: objects(doc.tools, 'tools'),
    prompts: objects(doc.prompts, 'prompts'),
    resources: objects(doc.resources, 'resources'),
    resourceTemplates: objects(doc.resourceTemplates, 'resourceTemplates'),
    covers: parts({ tools: true, prompts: 'prompts' in doc, resources: 'resources' in doc || 'resourceTemplates' in doc, server: 'serverInfo' in doc || 'server' in doc }),
  };
  if (typeof doc.protocolVersion === 'string') surface.protocolVersion = doc.protocolVersion;
  if (typeof doc.instructions === 'string') surface.instructions = doc.instructions;
  return surface;
}

/**
 * A scan dump: the handshake exchange and the pages of each list. When the handshake is in the dump,
 * the capabilities are known, so a list that is absent is known to be empty and the dump covers every part.
 */
function fromScanDump(doc: JsonObject): RawSurface {
  const lists = isObject(doc.lists) ? doc.lists : {};
  const pages = (method: string, field: string): JsonObject[] => {
    const exchanges = lists[method];
    if (!Array.isArray(exchanges)) return [];
    const failed = exchanges.find((ex) => isObject(ex) && !isObject(ex.result));
    if (failed !== undefined) {
      const err = isObject(failed) && isObject(failed.error) ? failed.error : undefined;
      // Templates are optional even for servers with the resources capability.
      if (method === 'resources/templates/list' && exchanges.length === 1 && err?.code === ERROR_CODE.methodNotFound) return [];
      const why = err ? `JSON-RPC error ${String(err.code)}` : 'no result';
      throw new SurfaceError(`${method} in the dump has a page without a result (${why}); scan the server again`);
    }
    return joinPages(exchanges.map((ex) => (isObject(ex) ? ex.result : undefined)), field);
  };
  const init = isObject(doc.initialize) && isObject(doc.initialize.result) ? doc.initialize.result : undefined;
  const discover = isObject(doc.discover) && isObject(doc.discover.result) ? doc.discover.result : undefined;
  const meta = discover && isObject(discover._meta) ? discover._meta : {};
  const handshake = Boolean(init ?? discover);
  const surface: RawSurface = {
    server: identity(init?.serverInfo ?? discover?.serverInfo ?? meta[META.serverInfo]),
    tools: pages('tools/list', 'tools'),
    prompts: pages('prompts/list', 'prompts'),
    resources: pages('resources/list', 'resources'),
    resourceTemplates: pages('resources/templates/list', 'resourceTemplates'),
    covers: handshake ? [...ALL_PARTS] : parts({ tools: 'tools/list' in lists, prompts: 'prompts/list' in lists, resources: 'resources/list' in lists, server: false }),
  };
  if (discover) surface.protocolVersion = TARGET_REVISION;
  else if (init && typeof init.protocolVersion === 'string') surface.protocolVersion = init.protocolVersion;
  const instructions = discover ? discover.instructions : init?.instructions;
  if (typeof instructions === 'string') surface.instructions = instructions;
  return surface;
}

export function parseDump(doc: unknown): RawSurface {
  if (Array.isArray(doc)) {
    if (doc.length > 0 && doc.every((p) => isObject(unwrap(p)) && Array.isArray((unwrap(p) as JsonObject).tools))) {
      return { server: {}, tools: joinPages(doc, 'tools'), prompts: [], resources: [], resourceTemplates: [], covers: ['tools'] };
    }
    return { server: {}, tools: objects(doc, 'tools'), prompts: [], resources: [], resourceTemplates: [], covers: ['tools'] };
  }
  if (!isObject(doc)) throw new SurfaceError('the dump is not a JSON object or array');
  if (doc.mcpRcCheckDump !== undefined) {
    if (doc.mcpRcCheckDump !== 1) throw new SurfaceError(`unsupported mcpRcCheckDump version ${JSON.stringify(doc.mcpRcCheckDump)}`);
    return fromScanDump(doc);
  }
  const result = unwrap(doc);
  if (!isObject(result) || !Array.isArray(result.tools)) {
    throw new SurfaceError('no "tools" array found; expected a tools/list result, a scan dump (scan --save-dump) or an array of tools');
  }
  return fromResult(result);
}

export function readDump(file: string): RawSurface {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new SurfaceError(`cannot read dump ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new SurfaceError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  try {
    return parseDump(doc);
  } catch (error) {
    if (error instanceof SurfaceError) throw new SurfaceError(`${file}: ${error.message}`);
    throw error;
  }
}
