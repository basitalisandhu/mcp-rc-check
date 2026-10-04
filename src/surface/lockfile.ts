/**
 * The lock file: a versioned JSON document with one hash per tool, prompt, resource and
 * resource template, one hash per component, and one hash for the whole surface. See docs/surface.md.
 */
import { readFileSync } from 'node:fs';
import { canonicalJson, isObject, sha256, sortKeys, type Json, type JsonObject } from './json.js';
import { ALL_PARTS, type NormalisedSurface, type NormalisedTool, type Part, type ServerIdentity } from './normalise.js';

export const LOCKFILE_VERSION = 1;
export const DEFAULT_LOCK = 'mcp-surface.lock.json';
/** The `generator` every lock carries; a lock from any other writer is refused. */
export const GENERATOR = 'mcp-rc-check';

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

export interface LockedTool {
  hash: string;
  /** Set by `surface lock --require`; a removed required tool is a HIGH change. Not part of any hash. */
  required: boolean;
  definition: NormalisedTool;
}

export interface LockedEntry {
  hash: string;
  definition: JsonObject;
}

export type ComponentName = 'tools' | 'prompts' | 'resources' | 'resourceTemplates' | 'instructions';
export const COMPONENTS: ComponentName[] = ['tools', 'prompts', 'resources', 'resourceTemplates', 'instructions'];

export interface Lock {
  lockfileVersion: number;
  generator: string;
  generatorVersion: string;
  hashAlgorithm: 'sha256';
  source: { kind: string; target: string };
  /** The parts the lock describes; verify ignores the rest. A lock from a live server covers all four. */
  covers: Part[];
  server: ServerIdentity;
  protocolVersion?: string;
  surfaceHash: string;
  components: Record<ComponentName, string>;
  instructions?: { hash: string; text: string };
  toolOrder: string[];
  tools: Record<string, LockedTool>;
  prompts: Record<string, LockedEntry>;
  resources: Record<string, LockedEntry>;
  resourceTemplates: Record<string, LockedEntry>;
}

export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Merkle-style tree hash: SHA-256 over sorted `<name> NUL <hash> LF` lines. */
export function treeHash(entries: Record<string, { hash: string }>): string {
  const names = Object.keys(entries).sort();
  return sha256(names.map((n) => `${n}\0${entries[n]!.hash}\n`).join(''));
}

function lockEntries(map: Record<string, JsonObject>): Record<string, LockedEntry> {
  const out: Record<string, LockedEntry> = {};
  for (const key of Object.keys(map).sort()) out[key] = { hash: hashValue(map[key]), definition: map[key]! };
  return out;
}

export interface BuildOptions {
  generatorVersion: string;
  source: { kind: string; target: string };
  /** Tool names to mark as required. */
  required?: Iterable<string>;
}

export function buildLock(surface: NormalisedSurface, options: BuildOptions): Lock {
  const required = new Set(options.required ?? []);
  const tools: Record<string, LockedTool> = {};
  for (const name of Object.keys(surface.tools).sort()) {
    const definition = surface.tools[name]!;
    tools[name] = { hash: hashValue(definition), required: required.has(name), definition };
  }
  const prompts = lockEntries(surface.prompts);
  const resources = lockEntries(surface.resources);
  const resourceTemplates = lockEntries(surface.resourceTemplates);
  const instructions = surface.instructions !== undefined ? { hash: sha256(surface.instructions), text: surface.instructions } : undefined;
  const components: Record<ComponentName, string> = {
    tools: treeHash(tools),
    prompts: treeHash(prompts),
    resources: treeHash(resources),
    resourceTemplates: treeHash(resourceTemplates),
    instructions: treeHash(instructions ? { instructions } : {}),
  };
  return {
    lockfileVersion: LOCKFILE_VERSION,
    generator: GENERATOR,
    generatorVersion: options.generatorVersion,
    hashAlgorithm: 'sha256',
    source: options.source,
    covers: surface.covers,
    server: surface.server,
    ...(surface.protocolVersion !== undefined ? { protocolVersion: surface.protocolVersion } : {}),
    surfaceHash: treeHash(Object.fromEntries(COMPONENTS.map((c) => [c, { hash: components[c] }]))),
    components,
    ...(instructions ? { instructions } : {}),
    toolOrder: surface.toolOrder,
    tools,
    prompts,
    resources,
    resourceTemplates,
  };
}

/** Serialise with a fixed top-level order and sorted keys everywhere else. Ends with a newline. */
export function serialiseLock(lock: Lock): string {
  const ordered: JsonObject = {};
  for (const [k, v] of Object.entries(lock)) {
    if (v === undefined) continue;
    ordered[k] = k === 'toolOrder' ? (v as Json) : sortKeys(v);
  }
  return JSON.stringify(ordered, null, 2) + '\n';
}

/** The normalised surface a lock was built from, for comparing against a live one. */
export function surfaceFromLock(lock: Lock): NormalisedSurface {
  const defs = (m: Record<string, LockedEntry>): Record<string, JsonObject> => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.definition]));
  return {
    server: lock.server,
    ...(lock.protocolVersion !== undefined ? { protocolVersion: lock.protocolVersion } : {}),
    ...(lock.instructions ? { instructions: lock.instructions.text } : {}),
    tools: Object.fromEntries(Object.entries(lock.tools).map(([k, v]) => [k, v.definition])),
    toolOrder: lock.toolOrder,
    prompts: defs(lock.prompts),
    resources: defs(lock.resources),
    resourceTemplates: defs(lock.resourceTemplates),
    covers: lock.covers,
  };
}

function requireMap(doc: JsonObject, key: string, file: string): void {
  if (!isObject(doc[key])) throw new LockError(`${file}: "${key}" is missing or not an object`);
}

/** Parse and validate a lock document. Recomputes every hash so a hand-edited definition is caught. */
export function parseLock(text: string, file: string): Lock {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new LockError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(doc)) throw new LockError(`${file} is not a JSON object`);
  if (doc.lockfileVersion !== LOCKFILE_VERSION) {
    throw new LockError(`${file} has lockfileVersion ${JSON.stringify(doc.lockfileVersion ?? null)}; this version of mcp-rc-check reads version ${LOCKFILE_VERSION} only. Re-create it with \`mcp-rc-check surface lock\`.`);
  }
  if (doc.generator !== GENERATOR) throw new LockError(`${file} was not written by mcp-rc-check surface lock`);
  for (const key of ['server', 'tools', 'prompts', 'resources', 'resourceTemplates', 'components']) requireMap(doc, key, file);
  if (!Array.isArray(doc.covers) || !doc.covers.every((p) => typeof p === 'string' && (ALL_PARTS as string[]).includes(p))) {
    throw new LockError(`${file}: "covers" is missing or names an unknown part`);
  }
  if (!Array.isArray(doc.toolOrder)) throw new LockError(`${file}: "toolOrder" is missing or not an array`);
  const lock = doc as unknown as Lock;
  for (const [name, t] of Object.entries(lock.tools)) {
    if (!isObject(t) || !isObject(t.definition) || typeof t.hash !== 'string') throw new LockError(`${file}: tool ${JSON.stringify(name)} is malformed`);
    if (hashValue(t.definition) !== t.hash) throw new LockError(`${file}: the definition of tool ${JSON.stringify(name)} does not match its hash; the lock was edited by hand. Re-create it with \`mcp-rc-check surface lock\`.`);
    t.required = t.required === true;
  }
  for (const key of ['prompts', 'resources', 'resourceTemplates'] as const) {
    for (const [name, e] of Object.entries(lock[key])) {
      if (!isObject(e) || !isObject(e.definition) || hashValue(e.definition) !== e.hash) throw new LockError(`${file}: ${key} entry ${JSON.stringify(name)} is malformed or does not match its hash`);
    }
  }
  return lock;
}

export function readLock(file: string): Lock {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new LockError(code === 'ENOENT' ? `no lock file at ${file}; create one with \`mcp-rc-check surface lock\`` : `cannot read ${file}: ${code ?? (error as Error).message}`);
  }
  return parseLock(text, file);
}
