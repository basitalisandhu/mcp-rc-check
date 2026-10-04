import { describe, expect, it } from 'vitest';
import { hashValue } from '../src/surface/lockfile.js';
import { canonicaliseSchema, effectiveHints, normaliseText, normaliseTool } from '../src/surface/normalise.js';
import { canonicalJson } from '../src/surface/json.js';
import { lockOf, surfaceOf } from './surface-helpers.js';

describe('normalisation', () => {
  it('is stable across key order, whitespace and required order', () => {
    const a = lockOf('fixture-base.json');
    const b = lockOf('fixture-reordered.json');
    for (const name of Object.keys(a.tools)) expect(b.tools[name]!.hash).toBe(a.tools[name]!.hash);
    expect(b.components).toEqual(a.components);
    expect(b.surfaceHash).toBe(a.surfaceHash);
    expect(b.toolOrder).not.toEqual(a.toolOrder);
  });

  it('gives the same hash for a tool however its keys are ordered', () => {
    const one = normaliseTool({ name: 't', description: 'x', inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'] } });
    const two = normaliseTool({ inputSchema: { required: ['b', 'a', 'a'], properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' }, description: ' x\n', name: 't' });
    expect(hashValue(two)).toBe(hashValue(one));
    expect(canonicalJson(two)).toBe(canonicalJson(one));
  });

  it('collapses ASCII whitespace only, and keeps invisible and non-ASCII characters', () => {
    expect(normaliseText('  a \t\n b  ')).toBe('a b');
    expect(normaliseText('a​b')).toBe('a​b');
    expect(normaliseText('a b')).toBe('a b');
    const plain = normaliseTool({ name: 't', description: 'Read a file', inputSchema: {} });
    const hidden = normaliseTool({ name: 't', description: 'Read a​ file', inputSchema: {} });
    expect(hashValue(hidden)).not.toBe(hashValue(plain));
  });

  it('treats JSON Schema keywords as keywords only where they are keywords', () => {
    const s = canonicaliseSchema({
      type: 'object',
      properties: { description: { type: 'string', description: '  the   text ' }, required: { type: 'boolean' } },
      required: ['required', 'description'],
      enum: ['b', 'a'],
      allOf: [{ description: ' x  y ' }],
      items: { title: ' t ' },
    }) as Record<string, unknown>;
    expect(s).toEqual({
      allOf: [{ description: 'x y' }],
      enum: ['b', 'a'],
      items: { title: 't' },
      properties: { description: { description: 'the text', type: 'string' }, required: { type: 'boolean' } },
      required: ['description', 'required'],
      type: 'object',
    });
  });

  it('drops _meta and keeps unknown tool fields', () => {
    const t = normaliseTool({ name: 't', inputSchema: {}, _meta: { requestId: 1 }, x_custom: { b: 1, a: 2 } });
    expect(t).toEqual({ name: 't', inputSchema: {}, other: { x_custom: { a: 2, b: 1 } } });
  });

  it('applies the specification defaults for absent hints', () => {
    const none = effectiveHints(normaliseTool({ name: 't', inputSchema: {} }));
    expect(none).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: true, annotated: false });
    const ro = effectiveHints(normaliseTool({ name: 't', inputSchema: {}, annotations: { readOnlyHint: true } }));
    expect(ro.destructive).toBe(false);
    expect(ro.annotated).toBe(true);
  });

  it('records the server identity, protocol version and instructions', () => {
    const s = surfaceOf('fixture-base.json');
    expect(s.server).toEqual({ name: 'fixture-files', version: '1.0.0' });
    expect(s.protocolVersion).toBe('2025-11-25');
    expect(s.instructions).toBe('Use read_file before write_file.');
    expect(s.covers).toEqual(['tools', 'prompts', 'resources', 'server']);
  });
});
