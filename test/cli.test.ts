import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../src/cli.js';
import { runCli, runMain } from './helpers.js';

describe('argument parsing', () => {
  it('parses scan options', () => {
    const o = parseArgs(['scan', '--url', 'http://127.0.0.1:1/mcp', '-H', 'Authorization: Bearer x', '-e', 'A=b=c', '--timeout=500', '--fail-on', 'warning', '--format', 'sarif']);
    expect(o.command).toBe('scan');
    expect(o.headers).toEqual({ Authorization: 'Bearer x' });
    expect(o.env).toEqual({ A: 'b=c' });
    expect(o.timeoutMs).toBe(500);
    expect(o.failOn).toBe('warning');
    expect(o.format).toBe('sarif');
  });

  it('rejects bad values', () => {
    expect(() => parseArgs(['--format', 'xml'])).toThrow(UsageError);
    expect(() => parseArgs(['--fail-on', 'high'])).toThrow(UsageError);
    expect(() => parseArgs(['--timeout', '-1'])).toThrow(UsageError);
    expect(() => parseArgs(['-e', 'novalue'])).toThrow(UsageError);
    expect(() => parseArgs(['--disable', 'no-such-rule'])).toThrow(UsageError);
    expect(() => parseArgs(['--bogus'])).toThrow(UsageError);
  });
});

describe('exit codes', () => {
  it('0 for --help and --version', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^Usage: mcp-rc-check/);
    const v = await runCli(['--version']);
    expect(v.stdout.trim()).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  });

  it('1 when findings reach --fail-on (default error)', async () => {
    expect((await runCli(['scan', '--dump', 'test/fixtures/fixture-pre-revision.json'])).code).toBe(1);
  });

  it('0 for a clean dump', async () => {
    expect((await runCli(['scan', '--dump', 'test/fixtures/fixture-post-revision.json'])).code).toBe(0);
  });

  it('respects --fail-on: warnings pass at error, fail at warning', async () => {
    expect((await runMain(['scan', '--dump', 'test/fixtures/fixture-errors.json', '--disable', 'resource-not-found-code'])).code).toBe(0);
    const warnOnly = ['client', '--config', 'test/fixtures/fixture-cursor-config.json'];
    expect((await runMain(warnOnly)).code).toBe(0);
    expect((await runMain([...warnOnly, '--fail-on', 'warning'])).code).toBe(1);
    const infoOnly = ['scan', '--dump', 'test/fixtures/fixture-tools-array.json'];
    expect((await runMain([...infoOnly, '--fail-on', 'warning'])).code).toBe(0);
    expect((await runMain([...infoOnly, '--fail-on', 'info'])).code).toBe(1);
  });

  it('2 for usage errors', async () => {
    expect((await runCli([])).code).toBe(2);
    expect((await runMain(['scan'])).code).toBe(2);
    expect((await runMain(['scan', '--dump', 'a.json', '--url', 'http://x'])).code).toBe(2);
    expect((await runMain(['scan', '--stdio', 'node x', '--fix'])).code).toBe(2);
    expect((await runMain(['client'])).code).toBe(2);
    expect((await runMain(['frobnicate'])).code).toBe(2);
  });

  it('2 for an unreadable, invalid or unrecognised input', async () => {
    const missing = await runMain(['scan', '--dump', 'test/fixtures/fixture-does-not-exist.json']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('ENOENT');
    expect((await runMain(['scan', '--dump', 'test/fixtures/fixture-not-mcp.json'])).code).toBe(2);
    expect((await runMain(['client', '--config', 'test/fixtures/fixture-not-mcp.json'])).code).toBe(2);
    expect((await runMain(['scan', '--dump', 'package.json'])).code).toBe(2);
  });

  it('prints the rules table and JSON', async () => {
    const t = await runMain(['rules']);
    expect(t.stdout).toContain('legacy-only-server');
    const j = JSON.parse((await runMain(['rules', '--format', 'json'])).stdout);
    expect(j.length).toBeGreaterThan(30);
  });

  it('writes the patch next to the input by default', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-rc-check-'));
    try {
      const out = path.join(dir, 'out.patch');
      const r = await runMain(['scan', '--dump', 'test/fixtures/fixture-results.json', '--fix', '--patch-file', out, '--format', 'json']);
      expect(r.stderr).toContain('wrote 3 fix operation(s)');
      expect(readFileSync(out, 'utf8')).toContain('+  "resultType": "complete"');
      expect(JSON.parse(r.stdout).summary.errors).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
