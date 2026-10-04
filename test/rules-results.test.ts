import { describe, expect, it } from 'vitest';
import { checkDump } from '../src/check.js';
import { byRule, scanFixture } from './helpers.js';

describe('result rules', () => {
  it('flags a missing resultType with an add fix', () => {
    const f = byRule(scanFixture('fixture-results.json'), 'result-type-missing');
    expect(f).toHaveLength(1);
    expect(f[0]!.fix).toEqual([{ op: 'add', path: '/resultType', value: 'complete' }]);
  });

  it('flags a non-string resultType without a fix', () => {
    const r = checkDump({ tools: [], resultType: 7, ttlMs: 0, cacheScope: 'public' }, 'x');
    const f = byRule(r, 'result-type-missing');
    expect(f[0]!.message).toContain('not a string');
    expect(f[0]!.fix).toBeUndefined();
  });

  it('replaces a negative ttlMs and an unknown cacheScope', () => {
    const f = byRule(scanFixture('fixture-results.json'), 'cache-hints-missing');
    expect(f.map((x) => x.fix)).toEqual([
      [{ op: 'replace', path: '/cacheScope', value: 'private' }],
      [{ op: 'replace', path: '/ttlMs', value: 0 }],
    ]);
  });

  it('adds conservative cache hints when they are absent', () => {
    const f = byRule(scanFixture('fixture-pre-revision.json'), 'cache-hints-missing');
    expect(f.flatMap((x) => x.fix)).toEqual([
      { op: 'add', path: '/lists/tools~1list/0/result/ttlMs', value: 0 },
      { op: 'add', path: '/lists/tools~1list/0/result/cacheScope', value: 'private' },
    ]);
  });

  it('rejects a fractional ttlMs', () => {
    const r = checkDump({ tools: [], resultType: 'complete', ttlMs: 1.5, cacheScope: 'public' }, 'x');
    expect(byRule(r, 'cache-hints-missing')[0]!.message).toContain('1.5');
  });

  it('skips cache hints on input_required interim results', () => {
    const r = checkDump({ tools: [], resultType: 'input_required' }, 'x');
    expect(byRule(r, 'cache-hints-missing')).toEqual([]);
  });

  it('flags pages with different cacheScope values', () => {
    const r = scanFixture('fixture-results-pages.json');
    expect(r.findings.map((f) => f.ruleId)).toEqual(['cache-scope-pages-differ']);
  });

  it('copies initialize serverInfo into _meta as the fix', () => {
    const f = byRule(scanFixture('fixture-pre-revision.json'), 'server-info-meta-missing');
    expect(f[0]!.fix).toEqual([
      {
        op: 'add',
        path: '/lists/tools~1list/0/result/_meta',
        value: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture-legacy', version: '0.9.0' } },
      },
    ]);
  });

  it('adds serverInfo inside an existing _meta object', () => {
    const r = checkDump(
      [
        { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } },
        { tools: [], resultType: 'complete', ttlMs: 0, cacheScope: 'public', _meta: { 'com.example/x': 1 } },
      ],
      'x',
    );
    expect(byRule(r, 'server-info-meta-missing')[0]!.fix).toEqual([
      { op: 'add', path: '/1/_meta/io.modelcontextprotocol~1serverInfo', value: { name: 's', version: '1' } },
    ]);
  });

  it('has no fix when the server name is unknown', () => {
    const f = byRule(scanFixture('fixture-results.json'), 'server-info-meta-missing');
    expect(f[0]!.severity).toBe('warning');
    expect(f[0]!.fix).toBeUndefined();
  });
});
