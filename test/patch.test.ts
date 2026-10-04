import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDump } from '../src/check.js';
import { unifiedDiff } from '../src/diff.js';
import { applyOps, collectOps, detectIndent, serialiseLike } from '../src/patch.js';
import { fixture, FIXTURES, runMain } from './helpers.js';

function expected(name: string): string {
  return readFileSync(path.join(FIXTURES, 'expected', name), 'utf8');
}

describe('autofix patches (byte for byte)', () => {
  it('pre-revision dump', async () => {
    const r = await runMain(['scan', '--dump', 'test/fixtures/fixture-pre-revision.json', '--fix', '--patch-file', '-']);
    expect(r.stdout).toBe(expected('fixture-pre-revision.json.patch'));
    expect(r.code).toBe(1);
  });

  it('tools/list result with invalid cache hints', async () => {
    const r = await runMain(['scan', '--dump', 'test/fixtures/fixture-results.json', '--fix', '--patch-file', '-']);
    expect(r.stdout).toBe(expected('fixture-results.json.patch'));
  });

  it('client config with static protocol headers', async () => {
    const r = await runMain(['client', '--config', 'test/fixtures/fixture-claude-config.json', '--fix', '--patch-file', '-']);
    expect(r.stdout).toBe(expected('fixture-claude-config.json.patch'));
  });

  it('writes nothing for a dump with no mechanical fixes', async () => {
    const r = await runMain(['scan', '--dump', 'test/fixtures/fixture-capabilities.json', '--fix', '--patch-file', '/dev/null']);
    expect(r.stderr).toContain('no mechanical fixes');
  });

  it('applies cleanly with git apply and leaves no autofixable finding', () => {
    let git = true;
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      git = false;
    }
    if (!git) return;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-rc-check-'));
    try {
      cpSync(FIXTURES, path.join(dir, 'test', 'fixtures'), { recursive: true });
      for (const name of ['fixture-pre-revision.json', 'fixture-results.json', 'fixture-claude-config.json']) {
        execFileSync('git', ['apply', path.join(FIXTURES, 'expected', `${name}.patch`)], { cwd: dir });
      }
      for (const name of ['fixture-pre-revision.json', 'fixture-results.json']) {
        const doc = JSON.parse(readFileSync(path.join(dir, 'test', 'fixtures', name), 'utf8'));
        expect(checkDump(doc, name).findings.filter((f) => f.fix)).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never edits the input file', async () => {
    const before = readFileSync(fixture('fixture-results.json'), 'utf8');
    await runMain(['scan', '--dump', 'test/fixtures/fixture-results.json', '--fix', '--patch-file', '-']);
    expect(readFileSync(fixture('fixture-results.json'), 'utf8')).toBe(before);
  });
});

describe('patch helpers', () => {
  it('applies add, replace and remove on a copy', () => {
    const doc = { a: { b: 1 }, list: [1, 2, 3] };
    const out = applyOps(doc, [
      { op: 'add', path: '/a/c', value: 2 },
      { op: 'replace', path: '/a/b', value: 5 },
      { op: 'remove', path: '/list/1' },
      { op: 'add', path: '/list/-', value: 9 },
    ]);
    expect(out).toEqual({ a: { b: 5, c: 2 }, list: [1, 3, 9] });
    expect(doc).toEqual({ a: { b: 1 }, list: [1, 2, 3] });
  });

  it('drops duplicate ops on the same path', () => {
    const ops = collectOps([
      { ruleId: 'x', severity: 'error', message: '', subject: '', pointer: '', fix: [{ op: 'add', path: '/a', value: 1 }] },
      { ruleId: 'y', severity: 'error', message: '', subject: '', pointer: '', fix: [{ op: 'add', path: '/a', value: 2 }] },
    ]);
    expect(ops).toEqual([{ op: 'add', path: '/a', value: 1 }]);
  });

  it('keeps the indentation and trailing newline of the input', () => {
    expect(detectIndent('{\n    "a": 1\n}\n')).toBe('    ');
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t');
    expect(detectIndent('{"a":1}')).toBe(2);
    expect(serialiseLike('{\n    "a": 1\n}', { a: 2 })).toBe('{\n    "a": 2\n}');
  });
});

describe('unified diff', () => {
  it('returns an empty string for equal texts', () => {
    expect(unifiedDiff('a\n', 'a\n', 'a', 'b')).toBe('');
  });

  it('produces one hunk with context', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n') + '\n';
    const after = ['1', '2', '3', '4', 'X', '6', '7', '8'].join('\n') + '\n';
    expect(unifiedDiff(before, after, 'a/f', 'b/f')).toBe('--- a/f\n+++ b/f\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+X\n 6\n 7\n 8\n');
  });

  it('splits distant changes into separate hunks', () => {
    const lines = Array.from({ length: 20 }, (_, i) => String(i));
    const changed = [...lines];
    changed[1] = 'A';
    changed[18] = 'B';
    const d = unifiedDiff(lines.join('\n') + '\n', changed.join('\n') + '\n', 'a', 'b');
    expect(d.match(/^@@/gm)).toHaveLength(2);
  });

  it('marks a missing final newline', () => {
    expect(unifiedDiff('a', 'b', 'x', 'y')).toBe('--- x\n+++ y\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n');
  });
});
