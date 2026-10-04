import { describe, expect, it } from 'vitest';
import { compareWithLock, sortChanges, type Change, type SurfaceReport as Report } from '../src/surface/compare.js';
import { denyFragment, formatHook, formatSurfaceJson as formatJson, formatSurfaceSarif as formatSarif, formatSurfaceTable as formatTable } from '../src/surface/format.js';
import { settingsSnippet } from '../src/surface/hook.js';
import { treeHash } from '../src/surface/lockfile.js';
import { changeClassById as ruleById } from '../src/surface/rules.js';
import { lockOf, surfaceOf } from './surface-helpers.js';

function report(after: string, server?: string): Report {
  const changes = compareWithLock(lockOf('fixture-base.json'), surfaceOf(after)).map((c) => (server ? { ...c, server } : c));
  return { target: 'l.json', servers: [{ name: server ?? 'fixture-files', lock: 'l.json', status: 'compared' }], changes, errors: [] };
}

function change(ruleId: string, subject: string, server?: string): Change {
  return { ruleId, severity: ruleById(ruleId).severity, subject, message: 'm', ...(server ? { server } : {}) };
}

describe('table', () => {
  it('says so when nothing changed', () => {
    expect(formatTable(report('fixture-base.json'))).toBe('mcp-rc-check surface verify: l.json\n\nNo changes since the lock was written.\n');
  });

  it('lists servers and prefixes subjects in a multi-server report', () => {
    const r: Report = {
      target: '.mcp.json',
      servers: [
        { name: 'a', status: 'compared' },
        { name: 'b', status: 'error', error: 'boom' },
        { name: 'c', status: 'skipped', error: 'the sse transport is not supported' },
      ],
      changes: [change('tool-removed', 'x', 'a')],
      errors: ['b: boom'],
    };
    const t = formatTable(r);
    expect(t).toContain('  b                        error: boom');
    expect(t).toContain('skipped: the sse transport');
    expect(t).toContain('a/x');
    expect(t).toContain('ERROR  b: boom');
    expect(t).toContain('0 high, 0 medium, 1 low, 1 error(s)');
  });
});

describe('json', () => {
  it('includes servers, summary, changes and errors', () => {
    const doc = JSON.parse(formatJson(report('fixture-removed-tool.json'), '9.9.9'));
    expect(doc).toMatchObject({ tool: 'mcp-rc-check', command: 'surface verify', version: '9.9.9', target: 'l.json', summary: { high: 0, medium: 0, low: 1 }, errors: [] });
    expect(doc.changes[0].title).toBe('A tool is gone');
  });
});

describe('sarif', () => {
  it('points each server change at its own lock and records errors as notifications', () => {
    const r: Report = { target: '.mcp.json', servers: [], changes: [change('tool-removed', 'x', 'a')], errors: ['b: boom'] };
    const sarif = JSON.parse(formatSarif(r, { toolVersion: '1', artifactUri: '.mcp.json', lockUris: { a: 'locks/a.lock.json' } }));
    const run = sarif.runs[0];
    expect(run.results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('locks/a.lock.json');
    expect(run.results[0].message.text).toBe('a: x: m');
    expect(run.invocations[0].executionSuccessful).toBe(false);
  });

  it('gives stable fingerprints', () => {
    const a = JSON.parse(formatSarif(report('fixture-added-tools.json'), { toolVersion: '1', artifactUri: 'l.json' }));
    const b = JSON.parse(formatSarif(report('fixture-added-tools.json'), { toolVersion: '2', artifactUri: 'l.json' }));
    expect(a.runs[0].results.map((x: { partialFingerprints: object }) => x.partialFingerprints)).toEqual(b.runs[0].results.map((x: { partialFingerprints: object }) => x.partialFingerprints));
  });
});

describe('hook output', () => {
  it('lists at most six changes and counts the rest', () => {
    const r: Report = { target: 'l', servers: [], changes: Array.from({ length: 8 }, (_, i) => change('tool-added-unsafe', `t${i}`)), errors: [] };
    const out = JSON.parse(formatHook(r, 'high', false));
    expect(out.stopReason).toContain('and 2 more');
    expect(out.stopReason).toContain('8 change(s)');
  });

  it('warns instead of blocking without --strict when verification fails', () => {
    const r: Report = { target: 'l', servers: [], changes: [], errors: ['no lock'] };
    expect(JSON.parse(formatHook(r, 'high', false))).toEqual({ systemMessage: 'mcp-rc-check surface: cannot verify the MCP tool surface: no lock' });
    expect(JSON.parse(formatHook(r, 'high', true))).toMatchObject({ continue: false });
  });

  it('builds one handler per server', () => {
    const s = settingsSnippet({ exe: 'mcp-rc-check', config: '/p/.mcp.json', servers: [{ name: 'a', lock: '/l/a.lock.json' }], failOn: 'high', timeout: 30, matcher: '' });
    expect(s.hooks.SessionStart[0]).not.toHaveProperty('matcher');
    expect(s.hooks.SessionStart[0]!.hooks[0]!.args).toContain('/l/a.lock.json');
  });
});

describe('deny fragment', () => {
  it('skips removed tools and server-level changes, and sorts the rules', () => {
    const r: Report = {
      target: 'l',
      servers: [],
      changes: [
        { ...change('tool-removed', 'gone'), tool: 'gone' },
        { ...change('tool-description-changed', 'zeta'), tool: 'zeta' },
        { ...change('tool-added-unsafe', 'alpha'), tool: 'alpha' },
        change('server-instructions-changed', 'server'),
      ],
      errors: [],
    };
    expect(JSON.parse(denyFragment(r, 'low', 'my.server')).permissions.deny).toEqual(['mcp__my_server__alpha', 'mcp__my_server__zeta']);
  });
});

describe('ordering and hashing helpers', () => {
  it('sorts by severity, then server, then class order, then subject', () => {
    const sorted = sortChanges([change('tool-removed', 'b'), change('tool-added-readonly', 'z'), change('tool-description-changed', 'y', 'srv'), change('tool-description-changed', 'a')]);
    expect(sorted.map((c) => `${c.server ?? ''}:${c.subject}`)).toEqual([':a', 'srv:y', ':z', ':b']);
  });

  it('hashes an empty component as the hash of the empty string', () => {
    expect(treeHash({})).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
