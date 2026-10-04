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

/** Resolve a pointer, returning undefined when any step is missing. */
export function get(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const token of parse(pointer)) {
    if (Array.isArray(cur)) {
      cur = cur[Number(token)];
    } else if (cur !== null && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return cur;
}
