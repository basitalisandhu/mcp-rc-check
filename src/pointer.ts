/** RFC 6901 JSON Pointer helpers. */

export function escapeToken(token: string | number): string {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Append tokens to a pointer. */
export function join(base: string, ...tokens: (string | number)[]): string {
  return base + tokens.map((t) => '/' + escapeToken(t)).join('');
}

export function parse(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON Pointer ${JSON.stringify(pointer)}`);
  return pointer.slice(1).split('/').map(unescapeToken);
}

/**
 * The array index a reference token names, or undefined. RFC 6901 section 4 allows only
 * `0` or a decimal without leading zeros, so "", " 1", "01", "1.5" and "-" name nothing.
 */
export function arrayIndex(token: string): number | undefined {
  return /^(0|[1-9][0-9]*)$/.test(token) ? Number(token) : undefined;
}

/** Resolve a pointer, returning undefined when any step is missing. */
export function get(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const token of parse(pointer)) {
    if (Array.isArray(cur)) {
      const i = arrayIndex(token);
      if (i === undefined || i >= cur.length) return undefined;
      cur = cur[i];
    } else if (cur !== null && typeof cur === 'object' && Object.hasOwn(cur, token)) {
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return cur;
}
