/**
 * Server entries from a client configuration, resolved into something `surface` can start or reach.
 * The entries themselves come from the same reader `mcp-rc-check client` uses (Claude Code's
 * `.mcp.json` and `~/.claude.json`, Claude Desktop, Cursor and VS Code `mcp.json`).
 *
 * `${VAR}` and `${VAR:-default}` are expanded in command, args, env, cwd, url and headers, the way
 * Claude Code expands them in `.mcp.json`. Expanded values are passed to the server and never printed.
 */
import { readFileSync } from 'node:fs';
import { clientView, ConfigError, transportOf } from '../config.js';
import { isObject, type JsonObject } from './json.js';

export { ConfigError, transportOf };

export interface ServerSpec {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Expand `${VAR}` and `${VAR:-default}`. A variable that is unset and has no default is an error that names it, never a value. */
export function expandVars(text: string, env: NodeJS.ProcessEnv, where: string): string {
  return text.replace(VAR, (_match, name: string, fallback: string | undefined) => {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${where} uses \${${name}}, which is not set and has no default`);
  });
}

function stringMap(value: unknown, where: string, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new ConfigError(`${where} is not an object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new ConfigError(`${where}.${k} is not a string`);
    out[k] = expandVars(v, env, `${where}.${k}`);
  }
  return out;
}

function toSpec(name: string, entry: JsonObject, env: NodeJS.ProcessEnv): ServerSpec {
  const where = `server ${JSON.stringify(name)}`;
  const transport = transportOf(entry);
  const spec: ServerSpec = { name, transport };
  if (transport === 'stdio') {
    if (typeof entry.command !== 'string' || entry.command === '') throw new ConfigError(`${where} has no command`);
    spec.command = expandVars(entry.command, env, `${where} command`);
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === 'string')) throw new ConfigError(`${where} args is not an array of strings`);
      spec.args = (entry.args as string[]).map((a, i) => expandVars(a, env, `${where} args[${i}]`));
    }
    const e = stringMap(entry.env, `${where} env`, env);
    if (e) spec.env = e;
    if (typeof entry.cwd === 'string') spec.cwd = expandVars(entry.cwd, env, `${where} cwd`);
  } else {
    const url = typeof entry.url === 'string' ? entry.url : typeof entry.serverUrl === 'string' ? entry.serverUrl : undefined;
    if (url !== undefined) spec.url = expandVars(url, env, `${where} url`);
    const h = stringMap(entry.headers, `${where} headers`, env);
    if (h) spec.headers = h;
  }
  return spec;
}

export interface ConfigEntry {
  name: string;
  entry: JsonObject;
}

/** The raw server entries of a configuration, in file order. */
export function configEntries(doc: unknown): ConfigEntry[] {
  return clientView(doc).entries.map((e) => ({ name: e.name, entry: e.entry as JsonObject }));
}

export function readConfig(file: string): ConfigEntry[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  try {
    return configEntries(doc);
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${file}: ${error.message}`);
    throw error;
  }
}

/** Expand one entry into a spec. Throws ConfigError for a variable that is not set. */
export function resolveEntry(e: ConfigEntry, env: NodeJS.ProcessEnv = process.env): ServerSpec {
  return toSpec(e.name, e.entry, env);
}

/** A file name for a server's lock: anything outside [A-Za-z0-9._-] becomes "_". */
export function lockFileName(server: string): string {
  const safe = server.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return `${safe || '_'}.lock.json`;
}

/** The server name Claude Code uses in permission rules (mcp__<server>__<tool>); inferred, see docs/surface.md. */
export function ruleName(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, '_');
}
