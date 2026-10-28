export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function has(obj: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * How deeply an input document may nest. The checks walk documents recursively, so a
 * document nested tens of thousands of levels deep overflowed the call stack. Real
 * dumps, schemas and configurations stay far below this.
 */
export const MAX_DEPTH = 256;

/** The nesting depth of a JSON value, stopping as soon as it exceeds `limit`. Iterative. */
export function nestingExceeds(value: unknown, limit = MAX_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (depth >= limit) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return false;
}

export const TOO_DEEP = `nested more than ${MAX_DEPTH} levels deep; refusing to read it`;

/**
 * Decode a JSON file's bytes as UTF-8. A leading byte order mark is dropped (editors on
 * Windows write one); anything that is not valid UTF-8 is an error rather than being
 * read with replacement characters, which would change tool names and hashes silently.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    throw new Error('is UTF-16 text; save it as UTF-8');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('is not UTF-8 text; save it as UTF-8');
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
