import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDump, readDump } from '../src/surface/dump.js';
import { LockError, parseLock, readLock, serialiseLock, treeHash } from '../src/surface/lockfile.js';
import { normaliseSurface, SurfaceError } from '../src/surface/normalise.js';
import { fixture, lockOf, readJson, runMain, tmpDir } from './surface-helpers.js';

describe('lock freshness check', () => {
  it('checks a fresh lock without writing, including required marks', async () => {
    const dir = tmpDir();
    const out = path.join(dir, 'lock.json');
    const args = ['lock', '--dump', fixture('fixture-base.json'), '--out', out];
    expect((await runMain([...args, '--require', 'write_file'])).code).toBe(0);
    const bytes = readFileSync(out);
    const mtime = statSync(out).mtimeMs;
    expect((await runMain([...args, '--check'])).code).toBe(0);
    expect(readFileSync(out)).toEqual(bytes);
    expect(statSync(out).mtimeMs).toBe(mtime);
    expect(readdirSync(dir)).toEqual(['lock.json']);
  });

  it('reports stale bytes without rewriting even when the parsed lock is unchanged', async () => {
    const out = path.join(tmpDir(), 'lock.json');
    const args = ['lock', '--dump', fixture('fixture-base.json'), '--out', out];
    expect((await runMain(args)).code).toBe(0);
    const stale = JSON.stringify(JSON.parse(readFileSync(out, 'utf8')));
    writeFileSync(out, stale);
    const result = await runMain([...args, '--check']);
    expect(result.code).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toMatch(/stale/);
    expect(readFileSync(out, 'utf8')).toBe(stale);
  });

  it('reports a missing lock without creating its parent directory', async () => {
    const dir = path.join(tmpDir(), 'absent');
    const result = await runMain(['lock', '--dump', fixture('fixture-base.json'), '--out', path.join(dir, 'lock.json'), '--check']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/missing/);
    expect(existsSync(dir)).toBe(false);
  });

  it('detects a changed surface from a different fixture without writing', async () => {
    const out = path.join(tmpDir(), 'lock.json');
    expect((await runMain(['lock', '--dump', fixture('fixture-base.json'), '--out', out])).code).toBe(0);
    const before = readFileSync(out);
    const result = await runMain(['lock', '--dump', fixture('fixture-pages.json'), '--out', out, '--check']);
    expect(result.code).toBe(1);
    expect(readFileSync(out)).toEqual(before);
  });

  it('rejects --check outside lock and reports unreadable destinations', async () => {
    expect((await runMain(['rules', '--check'])).code).toBe(2);
    const result = await runMain(['lock', '--dump', fixture('fixture-base.json'), '--out', tmpDir(), '--check']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/cannot read lock/);
  });
});

describe('dump shapes', () => {
  it('reads a tools/list result with metadata', () => {
    const raw = readDump(fixture('fixture-base.json'));
    expect(raw.tools.map((t) => t.name)).toEqual(['read_file', 'search_files', 'write_file']);
    expect(raw.covers).toEqual(['tools', 'prompts', 'resources', 'server']);
  });

  it('joins tools/list pages and checks the cursor chain', () => {
    expect(readDump(fixture('fixture-pages.json')).tools).toHaveLength(3);
    expect(() => readDump(fixture('fixture-pages-incomplete.json'))).toThrow(/missing pages/);
    expect(() => parseDump({ tools: [], nextCursor: 'x' })).toThrow(/one page of a paginated/);
    expect(() => parseDump([{ tools: [] }, { tools: [] }])).toThrow(/no nextCursor but more pages follow/);
  });

  it('reads a bare array of tools and a JSON-RPC response', () => {
    expect(parseDump([{ name: 'a', inputSchema: {} }]).tools).toHaveLength(1);
    const wrapped = parseDump({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', inputSchema: {} }] } });
    expect(wrapped.tools).toHaveLength(1);
    expect(wrapped.covers).toEqual(['tools']);
  });

  it('reads an mcp-rc-check dump', () => {
    const raw = readDump(fixture('fixture-rc-check-dump.json'));
    expect(raw.tools.map((t) => t.name)).toEqual(['read_file', 'search_files']);
    expect(raw.server.name).toBe('fixture-files');
    expect(raw.protocolVersion).toBe('2025-11-25');
  });

  it('rejects what it cannot read', () => {
    expect(() => parseDump('x')).toThrow(SurfaceError);
    expect(() => parseDump({ nothing: true })).toThrow(/no "tools" array/);
    expect(() => parseDump({ mcpRcCheckDump: 9, lists: {} })).toThrow(/unsupported/);
    expect(() => normaliseSurface(readDump(fixture('fixture-duplicate-tool.json')))).toThrow(/twice/);
    expect(() => normaliseSurface(parseDump({ tools: [{ description: 'no name' }] }))).toThrow(/no name/);
    expect(() => readDump(fixture('fixture-does-not-exist.json'))).toThrow(/cannot read dump/);
  });

  it('a scan dump with a handshake covers every part, and tolerates a missing templates list', () => {
    const doc = readJson(fixture('fixture-rc-check-dump.json')) as Record<string, unknown>;
    expect(parseDump(doc).covers).toEqual(['tools', 'prompts', 'resources', 'server']);
    const lists = { ...(doc.lists as object), 'resources/templates/list': [{ method: 'resources/templates/list', error: { code: -32601, message: 'Method not found' } }] };
    expect(parseDump({ ...doc, lists }).resourceTemplates).toEqual([]);
  });

  it('refuses a scan dump with a failed list page', () => {
    const doc = readJson(fixture('fixture-rc-check-dump.json')) as Record<string, unknown>;
    const lists = { 'tools/list': [{ method: 'tools/list', error: { code: -32603, message: 'Internal error' } }] };
    expect(() => parseDump({ ...doc, lists })).toThrow(/tools\/list in the dump has a page without a result \(JSON-RPC error -32603\)/);
    const { initialize: _drop, ...noHandshake } = doc;
    expect(parseDump(noHandshake).covers).toEqual(['tools']);
  });
});

describe('lock file', () => {
  it('is deterministic and ends with a newline', () => {
    const a = serialiseLock(lockOf('fixture-base.json'));
    expect(serialiseLock(lockOf('fixture-base.json'))).toBe(a);
    expect(a.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(a)).slice(0, 4)).toEqual(['lockfileVersion', 'generator', 'generatorVersion', 'hashAlgorithm']);
    expect(a).not.toMatch(/"(generatedAt|timestamp|lockedAt)"/);
  });

  it('builds the surface hash as a tree over component hashes', () => {
    const lock = lockOf('fixture-base.json');
    const expected = treeHash(Object.fromEntries(Object.entries(lock.components).map(([k, v]) => [k, { hash: v }])));
    expect(lock.surfaceHash).toBe(expected);
    expect(lock.components.tools).toBe(treeHash(lock.tools));
    expect(lock.surfaceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('parses what it writes, and records required tools', () => {
    const lock = lockOf('fixture-base.json', ['write_file']);
    const back = parseLock(serialiseLock(lock), 'x');
    expect(back.tools.write_file!.required).toBe(true);
    expect(back.tools.read_file!.required).toBe(false);
  });

  it('refuses another lockfileVersion, a foreign file and a hand-edited definition', () => {
    const text = serialiseLock(lockOf('fixture-base.json'));
    const doc = JSON.parse(text);
    expect(() => parseLock(JSON.stringify({ ...doc, lockfileVersion: 2 }), 'x')).toThrow(/lockfileVersion 2/);
    expect(() => parseLock(JSON.stringify({ ...doc, generator: 'other' }), 'x')).toThrow(/not written by/);
    expect(() => parseLock('{', 'x')).toThrow(LockError);
    doc.tools.read_file.definition.description = 'edited';
    expect(() => parseLock(JSON.stringify(doc), 'x')).toThrow(/edited by hand/);
    const d2 = JSON.parse(text);
    d2.prompts.summarise.definition.description = 'edited';
    expect(() => parseLock(JSON.stringify(d2), 'x')).toThrow(/does not match its hash/);
    expect(() => parseLock(JSON.stringify({ ...JSON.parse(text), covers: ['everything'] }), 'x')).toThrow(/covers/);
  });

  it('reports a missing lock with a hint', () => {
    expect(() => readLock(path.join(tmpDir(), 'none.json'))).toThrow(/mcp-rc-check surface lock/);
  });

  it('keeps the full normalised definition of every tool', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'l.json');
    writeFileSync(file, serialiseLock(lockOf('fixture-base.json')));
    const doc = readJson(file) as { tools: Record<string, { definition: { description: string } }> };
    expect(doc.tools.read_file!.definition.description).toBe('Read a file from the workspace and return its text.');
    expect(readFileSync(file, 'utf8')).toContain('"toolOrder": [');
  });
});

describe('more dump and lock checks', () => {
  it('normalises prompt arguments', () => {
    const a = normaliseSurface(parseDump({ tools: [], prompts: [{ name: 'p', arguments: [{ name: 'x', description: ' a   b ' }] }] }));
    expect(a.prompts.p).toEqual({ arguments: [{ description: 'a b', name: 'x' }], name: 'p' });
  });

  it('refuses a resource without a uri and duplicate prompts', () => {
    expect(() => normaliseSurface(parseDump({ tools: [], resources: [{ name: 'r' }] }))).toThrow(/no uri/);
    expect(() => normaliseSurface(parseDump({ tools: [], prompts: [{ name: 'p' }, { name: 'p' }] }))).toThrow(/twice/);
  });

  it('reads a JSON-RPC-wrapped page array', () => {
    const raw = parseDump([{ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', inputSchema: {} }] } }]);
    expect(raw.tools.map((t) => t.name)).toEqual(['a']);
  });

  it('a lock from a dump records only what the dump covers', () => {
    expect(lockOf('fixture-pages.json').covers).toEqual(['tools']);
    expect(lockOf('fixture-base.json').covers).toEqual(['tools', 'prompts', 'resources', 'server']);
  });

  it('refuses a lock that is not an object or misses a key', () => {
    expect(() => parseLock('[]', 'x')).toThrow(/not a JSON object/);
    const doc = JSON.parse(serialiseLock(lockOf('fixture-base.json')));
    delete doc.toolOrder;
    expect(() => parseLock(JSON.stringify(doc), 'x')).toThrow(/toolOrder/);
    const d2 = JSON.parse(serialiseLock(lockOf('fixture-base.json')));
    delete d2.tools;
    expect(() => parseLock(JSON.stringify(d2), 'x')).toThrow(/"tools" is missing/);
  });
});
