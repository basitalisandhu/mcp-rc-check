/** The operations behind the `surface` commands, independent of argument parsing and output. */
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectHttp, collectStdio } from '../live/surface.js';
import { ConnectionError } from '../live/transport.js';
import { compareWithLock, sortChanges, type Change, type SurfaceReport } from './compare.js';
import { ConfigError, lockFileName, readConfig, resolveEntry, transportOf, type ServerSpec } from './config.js';
import { readDump } from './dump.js';
import { buildLock, LockError, readLock, serialiseLock, type Lock } from './lockfile.js';
import { changeClassById } from './rules.js';
import { normaliseSurface, SurfaceError, type RawSurface } from './normalise.js';

export type Target =
  | { kind: 'stdio'; command: string; env?: Record<string, string> }
  | { kind: 'http'; url: string; headers?: Record<string, string> }
  | { kind: 'dump'; file: string }
  | { kind: 'config'; file: string; server: string };

export interface ConnectOptions {
  timeoutMs: number;
  clientVersion: string;
  maxPages?: number;
  /** Include the server's stderr tail in connection errors (off for whole-config runs). */
  stderr?: boolean;
}

export interface Obtained {
  raw: RawSurface;
  source: { kind: string; target: string };
}

/** Errors that mean "could not compare", mapped to exit code 2. */
export function isKnownError(error: unknown): error is Error {
  return error instanceof ConnectionError || error instanceof SurfaceError || error instanceof LockError || error instanceof ConfigError;
}

export async function obtainFromSpec(spec: ServerSpec, o: ConnectOptions): Promise<Obtained> {
  if (spec.transport === 'stdio') {
    try {
      const { surface, target } = await collectStdio([spec.command!, ...(spec.args ?? [])], {
        timeoutMs: o.timeoutMs,
        clientVersion: o.clientVersion,
        ...(o.maxPages ? { maxPages: o.maxPages } : {}),
        ...(spec.env ? { env: spec.env } : {}),
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
      });
      return { raw: surface, source: { kind: 'stdio', target } };
    } catch (error) {
      if (error instanceof ConnectionError && !o.stderr) throw new ConnectionError(error.message.split('\nserver stderr')[0]!);
      throw error;
    }
  }
  if (spec.transport === 'http' || spec.transport === 'streamable-http' || spec.transport === 'streamablehttp') {
    if (!spec.url) throw new ConfigError(`server ${JSON.stringify(spec.name)} has no url`);
    const { surface, target } = await collectHttp(spec.url, {
      timeoutMs: o.timeoutMs,
      clientVersion: o.clientVersion,
      ...(o.maxPages ? { maxPages: o.maxPages } : {}),
      ...(spec.headers ? { headers: spec.headers } : {}),
    });
    return { raw: surface, source: { kind: 'http', target } };
  }
  throw new ConnectionError(`the ${spec.transport} transport is not supported (stdio and Streamable HTTP are)`);
}

const SUPPORTED = new Set(['stdio', 'http', 'streamable-http', 'streamablehttp']);

/** stdio and Streamable HTTP are supported; the legacy HTTP+SSE transport and others are skipped. */
export function supportedTransport(transport: string): boolean {
  return SUPPORTED.has(transport);
}

function findSpec(file: string, server: string): ServerSpec {
  const entries = readConfig(file);
  const entry = entries.find((e) => e.name === server);
  if (!entry) throw new ConfigError(`${file} has no server named ${JSON.stringify(server)} (it has: ${entries.map((e) => e.name).join(', ') || 'none'})`);
  return resolveEntry(entry);
}

export async function obtain(target: Target, o: ConnectOptions): Promise<Obtained> {
  switch (target.kind) {
    case 'dump':
      return { raw: readDump(target.file), source: { kind: 'dump', target: path.basename(target.file) } };
    case 'stdio':
      return stdio(target, o);
    case 'http':
      return obtainFromSpec({ name: 'http', transport: 'http', url: target.url, ...(target.headers ? { headers: target.headers } : {}) }, o);
    case 'config':
      return obtainFromSpec(findSpec(target.file, target.server), o);
  }
}

async function stdio(target: { command: string; env?: Record<string, string> }, o: ConnectOptions): Promise<Obtained> {
  const { surface, target: desc } = await collectStdio(target.command, {
    timeoutMs: o.timeoutMs,
    clientVersion: o.clientVersion,
    ...(o.maxPages ? { maxPages: o.maxPages } : {}),
    ...(target.env ? { env: target.env } : {}),
  });
  return { raw: surface, source: { kind: 'stdio', target: desc } };
}

/** Write a file atomically (temporary file in the same directory, then rename). */
export function atomicWrite(file: string, text: string): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Build a lock from what was obtained, keeping `required` marks from an existing lock at the same path. */
export function makeLock(obtained: Obtained, out: string, require: string[], generatorVersion: string): Lock {
  const surface = normaliseSurface(obtained.raw);
  const required = new Set(require);
  if (existsSync(out)) {
    try {
      for (const [name, t] of Object.entries(readLock(out).tools)) if (t.required) required.add(name);
    } catch {
      // an unreadable old lock is simply replaced
    }
  }
  for (const name of require) {
    if (!(name in surface.tools)) throw new SurfaceError(`--require ${JSON.stringify(name)}: the server has no tool with that name`);
  }
  return buildLock(surface, { generatorVersion, source: obtained.source, required });
}

export function writeLock(lock: Lock, out: string): void {
  atomicWrite(out, serialiseLock(lock));
}

/** verify for one server: compare a lock with a target. */
export async function verifyOne(lockFile: string, target: Target, o: ConnectOptions): Promise<SurfaceReport> {
  const lock = readLock(lockFile);
  const obtained = await obtain(target, o);
  const changes = compareWithLock(lock, normaliseSurface(obtained.raw));
  const name = target.kind === 'config' ? target.server : (lock.server.name ?? 'server');
  return {
    target: lockFile,
    servers: [{ name, lock: lockFile, status: 'compared', tools: Object.keys(lock.tools).length }],
    changes: target.kind === 'config' ? changes.map((c) => ({ ...c, server: target.server })) : changes,
    errors: [],
  };
}

function serverChange(ruleId: string, server: string, message: string): Change {
  return { ruleId, severity: changeClassById(ruleId).severity, server, subject: 'server', message };
}

/** verify-config: every server in a client configuration against its lock under lockDir. */
export async function verifyConfig(configFile: string, lockDir: string, o: ConnectOptions, only: string[] = []): Promise<SurfaceReport> {
  const entries = readConfig(configFile).filter((e) => only.length === 0 || only.includes(e.name));
  const report: SurfaceReport = { target: configFile, servers: [], changes: [], errors: [] };
  const known = new Set<string>();
  for (const entry of entries) {
    const lockFile = path.join(lockDir, lockFileName(entry.name));
    known.add(lockFileName(entry.name));
    if (!supportedTransport(transportOf(entry.entry))) {
      report.servers.push({ name: entry.name, status: 'skipped', error: `the ${transportOf(entry.entry)} transport is not supported` });
      continue;
    }
    if (!existsSync(lockFile)) {
      report.servers.push({ name: entry.name, status: 'unlocked' });
      report.changes.push(serverChange('server-unlocked', entry.name, `no lock at ${lockFile}`));
      continue;
    }
    try {
      const lock = readLock(lockFile);
      const obtained = await obtainFromSpec(resolveEntry(entry), { ...o, stderr: false });
      const changes = compareWithLock(lock, normaliseSurface(obtained.raw)).map((c) => ({ ...c, server: entry.name }));
      report.servers.push({ name: entry.name, lock: lockFile, status: 'compared', tools: Object.keys(lock.tools).length });
      report.changes.push(...changes);
    } catch (error) {
      if (!isKnownError(error)) throw error;
      report.servers.push({ name: entry.name, lock: lockFile, status: 'error', error: error.message });
      report.errors.push(`${entry.name}: ${error.message}`);
    }
  }
  if (only.length === 0 && existsSync(lockDir)) {
    for (const file of readdirSync(lockDir).sort()) {
      if (!file.endsWith('.lock.json') || known.has(file)) continue;
      const name = file.slice(0, -'.lock.json'.length);
      report.servers.push({ name, lock: path.join(lockDir, file), status: 'removed' });
      report.changes.push(serverChange('server-removed', name, `${path.join(lockDir, file)} has no matching server in ${configFile}`));
    }
  }
  report.changes = sortChanges(report.changes);
  return report;
}

export interface WatchResult {
  name: string;
  status: 'locked' | 'skipped' | 'failed';
  detail: string;
  lock?: string;
  tools?: number;
  surfaceHash?: string;
}

/** watch-config: lock every server of a client configuration, one lock per server. */
export async function watchConfig(configFile: string, lockDir: string, o: ConnectOptions, generatorVersion: string, only: string[] = []): Promise<WatchResult[]> {
  const entries = readConfig(configFile).filter((e) => only.length === 0 || only.includes(e.name));
  if (only.length > 0) {
    for (const name of only) if (!entries.some((e) => e.name === name)) throw new ConfigError(`${configFile} has no server named ${JSON.stringify(name)}`);
  }
  const results: WatchResult[] = [];
  for (const entry of entries) {
    const lockFile = path.join(lockDir, lockFileName(entry.name));
    let spec: ServerSpec;
    try {
      spec = resolveEntry(entry);
    } catch (error) {
      if (!isKnownError(error)) throw error;
      results.push({ name: entry.name, status: 'failed', detail: error.message });
      continue;
    }
    if (!supportedTransport(spec.transport)) {
      results.push({ name: entry.name, status: 'skipped', detail: `the ${spec.transport} transport is not supported` });
      continue;
    }
    try {
      const obtained = await obtainFromSpec(spec, { ...o, stderr: false });
      const lock = makeLock(obtained, lockFile, [], generatorVersion);
      writeLock(lock, lockFile);
      results.push({ name: entry.name, status: 'locked', detail: lockFile, lock: lockFile, tools: Object.keys(lock.tools).length, surfaceHash: lock.surfaceHash });
    } catch (error) {
      if (!isKnownError(error)) throw error;
      results.push({ name: entry.name, status: 'failed', detail: error.message });
    }
  }
  return results;
}
