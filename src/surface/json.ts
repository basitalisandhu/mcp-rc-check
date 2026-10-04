/** JSON value types and the canonical serialisation every surface hash is computed over. */
import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively sort object keys (by UTF-16 code unit order, which is what Array.prototype.sort uses). */
export function sortKeys(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
  return null;
}

/** Canonical JSON: sorted keys, no insignificant whitespace. The input of every hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** The first twelve hex characters of a digest, for tables. */
export function short(digest: string | undefined): string {
  if (!digest) return '-';
  return digest.slice(digest.indexOf(':') + 1, digest.indexOf(':') + 13);
}

/** Pretty JSON with sorted keys and a trailing newline, used for lock files and diffs. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}
