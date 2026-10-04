import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSurfaceArgs as parseArgs, SurfaceUsageError as UsageError } from '../src/surface/cli.js';
import { serialiseLock } from '../src/surface/lockfile.js';
import { fixture, lockOf, runCli, runMain, tmpDir } from './surface-helpers.js';

function lockFile(name = 'fixture-base.json', required: string[] = []): string {
  const file = path.join(tmpDir(), 'mcp-surface.lock.json');
  writeFileSync(file, serialiseLock(lockOf(name, required)));
  return file;
}

describe('argument parsing', () => {
  it('parses options', () => {
    const o = parseArgs(['verify', '--url', 'http://127.0.0.1:1/mcp', '-H', 'Authorization: Bearer x', '--timeout=500', '--fail-on', 'medium', '--format', 'sarif', '--require', 'a', '--require', 'b']);
    expect(o.command).toBe('verify');
    expect(o.headers).toEqual({ Authorization: 'Bearer x' });
    expect(o.timeoutMs).toBe(500);
    expect(o.failOn).toBe('medium');
    expect(o.format).toBe('sarif');
    expect(o.require).toEqual(['a', 'b']);
    expect(parseArgs(['-e', 'A=b=c']).env).toEqual({ A: 'b=c' });
  });

  it('rejects bad values', () => {
    expect(() => parseArgs(['--fail-on', 'error'])).toThrow(UsageError);
    expect(() => parseArgs(['--timeout', '-1'])).toThrow(UsageError);
    expect(() => parseArgs(['--max-pages', '0'])).toThrow(UsageError);
    expect(() => parseArgs(['-e', 'novalue'])).toThrow(UsageError);
    expect(() => parseArgs(['-H', 'novalue'])).toThrow(UsageError);
    expect(() => parseArgs(['--bogus'])).toThrow(UsageError);
    expect(() => parseArgs(['--lock'])).toThrow(/needs a value/);
  });
});

describe('exit codes', () => {
  it('0 for --help and --version, 2 with no command', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^Usage: mcp-rc-check surface/);
    const top = await runMain(['--bogus-surface-flag']);
    expect(top.code).toBe(2);
    expect(top.stderr).toContain('unknown option --bogus-surface-flag');
    expect((await runCli([])).code).toBe(2);
    expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('0 when clean, 1 on changes at or above --fail-on', async () => {
    const lock = lockFile();
    expect((await runCli(['verify', '--lock', lock, '--dump', fixture('fixture-base.json')])).code).toBe(0);
    expect((await runCli(['verify', '--lock', lock, '--dump', fixture('fixture-description-changed.json')])).code).toBe(1);
    const reorder = ['verify', '--lock', lock, '--dump', fixture('fixture-reordered.json')];
    expect((await runMain(reorder)).code).toBe(1);
    expect((await runMain([...reorder, '--fail-on', 'medium'])).code).toBe(0);
    const added = ['verify', '--lock', lock, '--dump', fixture('fixture-added-tools.json')];
    expect((await runMain([...added, '--fail-on', 'high'])).code).toBe(1);
  });

  it('2 for usage, lock and input errors', async () => {
    expect((await runMain(['verify'])).code).toBe(2);
    expect((await runMain(['verify', '--dump', 'a.json', '--url', 'http://x'])).code).toBe(2);
    expect((await runMain(['nonsense'])).code).toBe(2);
    expect((await runMain(['verify', '--format', 'xml', '--dump', fixture('fixture-base.json')])).code).toBe(2);
    expect((await runMain(['verify', '--lock', path.join(tmpDir(), 'none.json'), '--dump', fixture('fixture-base.json')])).code).toBe(2);
    expect((await runMain(['verify', '--lock', lockFile(), '--dump', fixture('fixture-pages-incomplete.json')])).code).toBe(2);
    expect((await runMain(['verify', '--dump', fixture('fixture-base.json'), '-e', 'A=b'])).code).toBe(2);
    expect((await runMain(['verify', '--config', fixture('fixture-mcp-config.json')])).code).toBe(2);
  });
});

describe('lock', () => {
  it('writes a lock from a dump and keeps required marks on re-lock', async () => {
    const dir = tmpDir();
    const out = path.join(dir, 'l.json');
    const dump = fixture('fixture-base.json');
    const r = await runMain(['lock', '--dump', fixture('fixture-base.json'), '-o', out, '--require', 'search_files']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/search_files\s+[0-9a-f]{12}\s+required/);
    expect((await runMain(['lock', '--dump', fixture('fixture-base.json'), '-o', out])).code).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).tools.search_files.required).toBe(true);
    expect((await runMain(['verify', '--lock', out, '--dump', dump])).code).toBe(0);
    expect((await runMain(['verify', '--lock', out, '--dump', fixture('fixture-removed-tool.json'), '--fail-on', 'high'])).code).toBe(1);
  });

  it('refuses --require for a tool the server does not have', async () => {
    const r = await runMain(['lock', '--dump', fixture('fixture-base.json'), '-o', path.join(tmpDir(), 'l.json'), '--require', 'nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no tool with that name');
  });
});

describe('diff', () => {
  it('prints a unified diff of the normalised definition and exits 1', async () => {
    const r = await runMain(['diff', 'read_file', '--lock', lockFile(), '--dump', fixture('fixture-description-changed.json')]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^--- a\/read_file \(locked\)\n\+\+\+ b\/read_file \(live\)\n@@ /);
    expect(r.stdout).toContain('+  "description": "Read a file from the workspace and return its text. Also summarise the file');
  });

  it('diffs added tools against /dev/null, prompts by prefix, and says when nothing changed', async () => {
    const lock = lockFile();
    const added = await runMain(['diff', 'delete_file', '--lock', lock, '--dump', fixture('fixture-added-tools.json')]);
    expect(added.stdout).toMatch(/^--- \/dev\/null/);
    const prompt = await runMain(['diff', 'prompt:summarise', '--lock', lock, '--dump', fixture('fixture-other-changes.json')]);
    expect(prompt.code).toBe(1);
    expect(prompt.stdout).toContain('+  "description": "Summarise a file in one paragraph"');
    const same = await runMain(['diff', 'write_file', '--lock', lock, '--dump', fixture('fixture-base.json')]);
    expect(same).toMatchObject({ code: 0, stdout: 'write_file: no change\n' });
    expect((await runMain(['diff', 'nope', '--lock', lock, '--dump', fixture('fixture-base.json')])).code).toBe(2);
    expect((await runMain(['diff', '--lock', lock, '--dump', fixture('fixture-base.json')])).code).toBe(2);
  });
});

describe('formats', () => {
  it('json carries the summary and rule titles', async () => {
    const r = await runMain(['verify', '--lock', lockFile(), '--dump', fixture('fixture-added-tools.json'), '--format', 'json']);
    const doc = JSON.parse(r.stdout);
    expect(doc.summary).toEqual({ high: 2, medium: 1, low: 0 });
    expect(doc.changes[0]).toMatchObject({ ruleId: 'tool-added-unsafe', severity: 'high', tool: 'delete_file', title: 'A new tool that is not marked read-only' });
  });

  it('hook format blocks at high, warns below, prints nothing when clean, and always exits 0', async () => {
    const lock = lockFile();
    const block = await runMain(['verify', '--format', 'hook', '--lock', lock, '--dump', fixture('fixture-description-changed.json')]);
    expect(block.code).toBe(0);
    const b = JSON.parse(block.stdout);
    expect(b.continue).toBe(false);
    expect(b.stopReason).toContain('read_file tool-description-changed (HIGH)');
    const warn = await runMain(['verify', '--format', 'hook', '--lock', lock, '--dump', fixture('fixture-reordered.json')]);
    expect(JSON.parse(warn.stdout)).toHaveProperty('systemMessage');
    const clean = await runMain(['verify', '--format', 'hook', '--lock', lock, '--dump', fixture('fixture-base.json')]);
    expect(clean).toMatchObject({ code: 0, stdout: '' });
  });

  it('hook format with --strict stops the session when verification fails', async () => {
    const missing = path.join(tmpDir(), 'none.json');
    const strict = await runMain(['verify', '--strict', '--format', 'hook', '--lock', missing, '--dump', fixture('fixture-base.json')]);
    expect(strict.code).toBe(0);
    expect(JSON.parse(strict.stdout)).toMatchObject({ continue: false });
    const lax = await runMain(['verify', '--format', 'hook', '--lock', missing, '--dump', fixture('fixture-base.json')]);
    expect(JSON.parse(lax.stdout)).toHaveProperty('systemMessage');
  });

  it('rules lists every change class', async () => {
    const r = await runMain(['rules']);
    expect(r.stdout).toContain('tool-annotation-downgrade');
    expect(JSON.parse((await runMain(['rules', '--format', 'json'])).stdout).length).toBeGreaterThan(10);
  });
});

describe('more CLI paths', () => {
  it('a lock from a tools-only dump records its coverage and verifies clean', async () => {
    const dir = tmpDir();
    const lock = path.join(dir, 'l.json');
    const r = await runMain(['lock', '--dump', fixture('fixture-pages.json'), '-o', lock]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('covers tools;');
    const saved = JSON.parse(readFileSync(lock, 'utf8'));
    expect(saved.covers).toEqual(['tools']);
    expect(saved.prompts).toEqual({});
    expect((await runMain(['verify', '--lock', lock, '--dump', fixture('fixture-base.json')])).code).toBe(0);
  });

  it('verify defaults to mcp-surface.lock.json in the working directory', async () => {
    const r = await runMain(['verify', '--dump', fixture('fixture-base.json')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('mcp-surface.lock.json');
  });

  it('hook needs a configuration with servers, and refuses a bare target', async () => {
    const dir = tmpDir();
    const empty = path.join(dir, 'mcp.json');
    writeFileSync(empty, JSON.stringify({ mcpServers: {} }));
    expect((await runMain(['hook', '--config', empty])).code).toBe(2);
    expect((await runMain(['hook', '--stdio', 'node x'])).code).toBe(2);
    expect((await runMain(['hook', '--config', path.join(dir, 'missing.json')])).code).toBe(2);
  });

  it('claude-settings needs a server name when the lock has none', async () => {
    const dir = tmpDir();
    const lock = path.join(dir, 'l.json');
    await runMain(['lock', '--dump', fixture('fixture-pages.json'), '-o', lock]);
    const r = await runMain(['hook', '--format', 'claude-settings', '--lock', lock, '--dump', fixture('fixture-added-tools.json')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--name');
  });

  it('verify-config reports a configuration error as exit 2', async () => {
    const dir = tmpDir();
    const bad = path.join(dir, 'mcp.json');
    writeFileSync(bad, '{ not json');
    expect((await runMain(['verify-config', bad])).code).toBe(2);
    const hook = await runMain(['verify-config', bad, '--format', 'hook', '--strict']);
    expect(hook.code).toBe(0);
    expect(JSON.parse(hook.stdout).continue).toBe(false);
    expect((await runMain(['verify-config'])).code).toBe(2);
  });

  it('diff works on resources and templates', async () => {
    const lock = lockFile();
    const r = await runMain(['diff', 'resource:fixture://changelog', '--lock', lock, '--dump', fixture('fixture-other-changes.json')]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^--- \/dev\/null\n\+\+\+ b\/resource:fixture:\/\/changelog \(live\)/);
    const t = await runMain(['diff', 'template:fixture://notes/{id}', '--lock', lock, '--dump', fixture('fixture-base.json')]);
    expect(t.code).toBe(0);
  });

  it('accepts --flag=value forms and a single --server with --config', async () => {
    const o = parseArgs(['verify', '--config=.mcp.json', '--server=files', '--lock-dir=x', '--format=json']);
    expect(o).toMatchObject({ config: '.mcp.json', server: ['files'], lockDir: 'x', format: 'json' });
  });
});
