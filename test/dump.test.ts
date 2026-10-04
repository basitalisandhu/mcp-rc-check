import { describe, expect, it } from 'vitest';
import { DumpError, normalise } from '../src/dump.js';
import { readFixture } from './helpers.js';

describe('dump normalisation', () => {
  it('reads a canonical legacy dump', () => {
    const v = normalise(readFixture('fixture-pre-revision.json'));
    expect(v.canonical).toBe(true);
    expect(v.era).toBe('legacy');
    expect(v.tools.map((t) => t.ptr)).toEqual(['/lists/tools~1list/0/result/tools/0']);
    expect(v.serverInfo).toEqual({ name: 'fixture-legacy', version: '0.9.0' });
  });

  it('collects every page of a paginated list', () => {
    const v = normalise(readFixture('fixture-post-revision.json'));
    expect(v.lists['tools/list']).toHaveLength(2);
    expect(v.tools.map((t) => t.name)).toEqual(['get_weather', 'list_cities']);
    expect(v.results[0]!.method).toBe('server/discover');
  });

  it('unwraps a JSON-RPC response', () => {
    const v = normalise(readFixture('fixture-jsonrpc-wrapped.json'));
    expect(v.tools[0]!.ptr).toBe('/result/tools/0');
  });

  it('treats a loose discover result as modern and an initialize result as legacy', () => {
    expect(normalise(readFixture('fixture-capabilities.json')).era).toBe('modern');
    expect(normalise({ protocolVersion: '2025-11-25', capabilities: {} }).era).toBe('legacy');
    expect(normalise([{ supportedVersions: ['2026-07-28'], capabilities: {} }, { protocolVersion: '2025-11-25', capabilities: {} }]).era).toBe('dual');
  });

  it('reads resources, templates and prompts lists', () => {
    const v = normalise({ resources: [], resourceTemplates: [], prompts: [] });
    expect(Object.keys(v.lists).sort()).toEqual(['prompts/list', 'resources/list', 'resources/templates/list']);
  });

  it('rejects a document with nothing to check', () => {
    expect(() => normalise(readFixture('fixture-not-mcp.json'))).toThrow(DumpError);
    expect(() => normalise(42)).toThrow(DumpError);
  });
});
