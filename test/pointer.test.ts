import { describe, expect, it } from 'vitest';
import { arrayIndex, escapeToken, get, join, parse, unescapeToken } from '../src/pointer.js';

describe('JSON Pointer helpers (RFC 6901)', () => {
  it('escapes ~ before / and round-trips', () => {
    expect(escapeToken('a/b~c')).toBe('a~1b~0c');
    expect(unescapeToken('a~1b~0c')).toBe('a/b~c');
    // ~01 is "~1" literally, not "/"
    expect(unescapeToken('~01')).toBe('~1');
    for (const token of ['tools/list', '~', '~1', '', 'plain']) expect(unescapeToken(escapeToken(token))).toBe(token);
  });

  it('joins tokens, escaping each', () => {
    expect(join('/lists', 'tools/list', 0, 'result')).toBe('/lists/tools~1list/0/result');
    expect(join('')).toBe('');
  });

  it('parses the root, nested and empty tokens, and rejects a pointer without a leading slash', () => {
    expect(parse('')).toEqual([]);
    expect(parse('/')).toEqual(['']);
    expect(parse('/a~1b/0')).toEqual(['a/b', '0']);
    expect(() => parse('a/b')).toThrow('invalid JSON Pointer "a/b"');
  });

  it('accepts only canonical array indexes', () => {
    expect(arrayIndex('0')).toBe(0);
    expect(arrayIndex('12')).toBe(12);
    for (const bad of ['', ' 1', '01', '1.5', '-', '-1', '1e1', 'length']) expect(arrayIndex(bad)).toBeUndefined();
  });

  it('resolves values and returns undefined for anything missing', () => {
    const doc = { lists: { 'tools/list': [{ result: { ttlMs: 0 } }] }, n: null, '': 'empty key' };
    expect(get(doc, '')).toBe(doc);
    expect(get(doc, '/lists/tools~1list/0/result/ttlMs')).toBe(0);
    expect(get(doc, '/')).toBe('empty key');
    expect(get(doc, '/lists/tools~1list/1')).toBeUndefined();
    expect(get(doc, '/lists/tools~1list/')).toBeUndefined();
    expect(get(doc, '/lists/tools~1list/01')).toBeUndefined();
    expect(get(doc, '/lists/tools~1list/length')).toBeUndefined();
    expect(get(doc, '/n/x')).toBeUndefined();
    expect(get(doc, '/lists/toString')).toBeUndefined();
    expect(get(doc, '/__proto__')).toBeUndefined();
  });
});
