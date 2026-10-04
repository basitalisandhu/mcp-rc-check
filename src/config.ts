import { join } from './pointer.js';
import { isObject, type JsonObject } from './util.js';

/** One MCP server entry from a client configuration file. */
export interface ServerEntry {
  /** The server's key, prefixed with the project path for ~/.claude.json project entries. */
  name: string;
  entry: JsonObject;
  ptr: string;
}

export interface ClientView {
  doc: unknown;
  entries: ServerEntry[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function collect(out: ServerEntry[], servers: unknown, ptr: string, prefix: string): void {
  if (!isObject(servers)) return;
  for (const [name, entry] of Object.entries(servers)) {
    if (isObject(entry)) out.push({ name: prefix + name, entry, ptr: join(ptr, name) });
  }
}

/**
 * Read server entries from a client configuration: `.mcp.json` and `~/.claude.json` (mcpServers, and
 * projects.<path>.mcpServers), Cursor's `mcp.json` (mcpServers), and VS Code's `mcp.json` (servers).
 */
export function clientView(doc: unknown): ClientView {
  if (!isObject(doc)) throw new ConfigError('the configuration is not a JSON object');
  const entries: ServerEntry[] = [];
  collect(entries, doc.mcpServers, '/mcpServers', '');
  collect(entries, doc.servers, '/servers', '');
  if (isObject(doc.projects)) {
    for (const [project, value] of Object.entries(doc.projects)) {
      if (isObject(value)) collect(entries, value.mcpServers, join('/projects', project, 'mcpServers'), `${project}:`);
    }
  }
  if (entries.length === 0 && !('mcpServers' in doc) && !('servers' in doc) && !('projects' in doc)) {
    throw new ConfigError('no mcpServers, servers or projects.<path>.mcpServers object found');
  }
  return { doc, entries };
}

/** Header map of an entry, if any. */
export function headersOf(entry: JsonObject): JsonObject | undefined {
  return isObject(entry.headers) ? entry.headers : undefined;
}

/** The transport an entry uses: explicit type/transport, else http when it has a url, else stdio. */
export function transportOf(entry: JsonObject): string {
  for (const key of ['type', 'transport']) {
    if (typeof entry[key] === 'string') return (entry[key] as string).toLowerCase();
  }
  if (typeof entry.url === 'string' || typeof entry.serverUrl === 'string') return 'http';
  return 'stdio';
}
