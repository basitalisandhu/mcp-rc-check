import { describe, expect, it } from 'vitest';
import { checkDump } from '../src/check.js';
import { byRule, scanFixture } from './helpers.js';

describe('tool rules', () => {
  const r = scanFixture('fixture-tools.json');

  it('flags inputSchema problems and fixes only a missing root type', () => {
    const f = byRule(r, 'input-schema-not-object');
    expect(f.map((x) => x.subject)).toEqual(['no_type', 'array_root', 'null_schema']);
    expect(f[0]!.fix).toEqual([{ op: 'add', path: '/tools/2/inputSchema/type', value: 'object' }]);
    expect(f[1]!.fix).toBeUndefined();
    expect(f[2]!.fix).toBeUndefined();
  });

  it('flags a missing inputSchema', () => {
    const m = checkDump({ tools: [{ name: 't' }], resultType: 'complete', ttlMs: 0, cacheScope: 'public' }, 'x');
    expect(byRule(m, 'input-schema-not-object')[0]!.message).toBe('inputSchema is missing');
  });

  it('reports explicit non-2020-12 dialects as advisory info only', () => {
    const f = byRule(r, 'schema-dialect-not-default');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('info');
    expect(f[0]!.subject).toBe('fetch_schema');
  });

  it('flags $refs that leave the document, not local ones', () => {
    const f = byRule(r, 'schema-external-ref');
    expect(f.map((x) => x.pointer).sort()).toEqual([
      '/tools/1/inputSchema/properties/relative/$ref',
      '/tools/1/inputSchema/properties/remote/$ref',
    ]);
  });

  it('flags each invalid x-mcp-header with its reason', () => {
    const msgs = byRule(r, 'x-mcp-header-invalid').map((x) => x.message);
    expect(msgs).toHaveLength(5);
    expect(msgs.some((m) => m.includes('"Ratio"') && m.includes('"number"'))).toBe(true);
    expect(msgs.some((m) => m.includes('"region"') && m.includes('not unique'))).toBe(true);
    expect(msgs.some((m) => m.includes('"Filter"') && m.includes('statically reachable'))).toBe(true);
    expect(msgs.some((m) => m.includes('"Bad Header"') && m.includes('tchar'))).toBe(true);
    expect(msgs.some((m) => m.includes('""') && m.includes('non-empty'))).toBe(true);
  });

  it('accepts nested properties chains, nullable primitive types and untyped properties', () => {
    const msgs = byRule(r, 'x-mcp-header-invalid').map((x) => x.message).join('\n');
    expect(msgs).not.toContain('"Mode"');
    expect(msgs).not.toContain('"Label"');
    expect(msgs).not.toContain('"Region"');
  });

  it('flags control characters in a header name', () => {
    const m = checkDump(
      { tools: [{ name: 't', inputSchema: { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'A\r\nB' } } } }] },
      'x',
    );
    expect(byRule(m, 'x-mcp-header-invalid')[0]!.message).toContain('control characters');
  });

  it('warns when a header mirrors a secret-looking parameter', () => {
    const f = byRule(r, 'x-mcp-header-sensitive');
    expect(f.map((x) => x.message)).toEqual(['x-mcp-header "Db-Pass" mirrors password into an HTTP header']);
  });

  it('notes the 2025-11-25 execution field as advisory', () => {
    const f = byRule(r, 'tool-execution-field');
    expect(f[0]!.subject).toBe('with_tasks');
    expect(f[0]!.severity).toBe('info');
  });

  it('flags an unstable tools order between two listings', () => {
    const f = byRule(scanFixture('fixture-transport-lax.json'), 'tools-order-unstable');
    expect(f[0]!.pointer).toBe('/toolsRepeat/result');
  });

  it('accepts a bare array of tools', () => {
    const a = scanFixture('fixture-tools-array.json');
    expect(a.findings.map((f) => `${f.ruleId}:${f.pointer}`)).toEqual(['schema-dialect-not-default:/1/inputSchema/$schema']);
  });
});
