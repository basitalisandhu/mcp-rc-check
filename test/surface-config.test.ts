import { copyFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configEntries, ConfigError, expandVars, lockFileName, resolveEntry, ruleName } from '../src/surface/config.js';
import { fixture, runMain, tmpDir } from './surface-helpers.js';

const CONFIG = fixture('fixture-mcp-config.json');

afterEach(() => {
  delete process.env.MRC_SURFACE_FIXTURE_MODE;
});

describe('client configuration', () => {
  it('expands ${VAR} and ${VAR:-default} and names a missing variable without a value', () => {
    expect(expandVars('a-${X}-${Y:-d}', { X: 'x' }, 'w')).toBe('a-x-d');
    expect(() => expandVars('${MISSING_MRC_VAR}', {}, 'server "s" env.TOKEN')).toThrow(/MISSING_MRC_VAR.*not set/);
    const [entry] = configEntries({ mcpServers: { s: { command: 'node', args: ['${D:-x}/s.mjs'], env: { T: '${T}' } } } });
    expect(resolveEntry(entry!, { T: 'secret-value' })).toEqual({ name: 's', transport: 'stdio', command: 'node', args: ['x/s.mjs'], env: { T: 'secret-value' } });
  });

  it('reads Claude Code, Claude Desktop and VS Code shapes', () => {
    expect(configEntries({ mcpServers: { a: { command: 'x' } } }).map((e) => e.name)).toEqual(['a']);
    expect(configEntries({ servers: { b: { type: 'http', url: 'https://example.invalid/mcp' } } }).map((e) => e.name)).toEqual(['b']);
    expect(() => configEntries({})).toThrow(ConfigError);
    expect(() => resolveEntry({ name: 'n', entry: {} })).toThrow(/no command/);
    expect(() => resolveEntry({ name: 'n', entry: { command: 'x', args: [1] } })).toThrow(/args/);
  });

  it('makes safe lock names and rule names', () => {
    expect(lockFileName('github')).toBe('github.lock.json');
    expect(lockFileName('../../etc/passwd')).toBe('__.._etc_passwd.lock.json');
    expect(lockFileName('a b/c')).toBe('a_b_c.lock.json');
    expect(ruleName('my.server')).toBe('my_server');
  });
});

describe('watch-config and verify-config', () => {
  it('locks every stdio server, skips the SSE one, then verifies clean and changed', async () => {
    const dir = tmpDir();
    const locks = path.join(dir, 'locks');
    const watched = await runMain(['watch-config', CONFIG, '--lock-dir', locks]);
    expect(watched.code).toBe(0);
    expect(watched.stdout).toMatch(/files\s+locked\s+3 tool\(s\)/);
    expect(watched.stdout).toMatch(/paged\s+locked\s+3 tool\(s\)/);
    expect(watched.stdout).toMatch(/legacy-sse\s+skipped/);
    expect(readdirSync(locks).sort()).toEqual(['files.lock.json', 'paged.lock.json']);

    const clean = await runMain(['verify-config', CONFIG, '--lock-dir', locks]);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('No changes since the lock was written.');

    process.env.MRC_SURFACE_FIXTURE_MODE = 'changed';
    const changed = await runMain(['verify-config', CONFIG, '--lock-dir', locks, '--format', 'json']);
    expect(changed.code).toBe(1);
    const doc = JSON.parse(changed.stdout);
    expect(doc.summary.high).toBe(3);
    expect(new Set(doc.changes.map((c: { server: string }) => c.server))).toEqual(new Set(['files']));

    const deny = await runMain(['hook', '--format', 'claude-settings', '--config', CONFIG, '--lock-dir', locks]);
    expect(deny.code).toBe(0);
    expect(JSON.parse(deny.stdout)).toEqual({ permissions: { deny: ['mcp__files__delete_file', 'mcp__files__read_file'] } });

    const gate = await runMain(['verify', '--strict', '--format', 'hook', '--config', CONFIG, '--server', 'files', '--lock', path.join(locks, 'files.lock.json')]);
    expect(JSON.parse(gate.stdout).continue).toBe(false);
  });

  it('reports a configured server without a lock as HIGH and a lock without a server as LOW', async () => {
    const dir = tmpDir();
    const locks = path.join(dir, 'locks');
    expect((await runMain(['watch-config', CONFIG, '--lock-dir', locks, '--server', 'files'])).code).toBe(0);
    copyFileSync(path.join(locks, 'files.lock.json'), path.join(locks, 'old-server.lock.json'));
    const r = await runMain(['verify-config', CONFIG, '--lock-dir', locks, '--format', 'json']);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.changes.map((c: { ruleId: string; server: string }) => `${c.ruleId} ${c.server}`)).toEqual(['server-unlocked paged', 'server-removed old-server']);
  });

  it('reports a server that fails to start without printing env values, and exits 2', async () => {
    const dir = tmpDir();
    const config = path.join(dir, 'mcp.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { broken: { command: 'node', args: ['-e', 'process.exit(4)'], env: { API_TOKEN: 'mrc-secret-env-value' } }, unset: { command: 'node', env: { T: '${MRC_NOT_SET_ANYWHERE}' } } } }));
    const r = await runMain(['watch-config', config, '--lock-dir', path.join(dir, 'locks')]);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/broken\s+failed/);
    expect(r.stdout).toMatch(/unset\s+failed.*MRC_NOT_SET_ANYWHERE/);
    expect(r.stdout + r.stderr).not.toContain('mrc-secret-env-value');
    expect((await runMain(['watch-config', config, '--server', 'nope', '--lock-dir', dir])).code).toBe(2);
    expect((await runMain(['watch-config'])).code).toBe(2);
  });
});

describe('hook', () => {
  it('prints a SessionStart block that parses as JSON, one handler per supported server', async () => {
    const locks = path.join(tmpDir(), 'locks');
    const r = await runMain(['hook', '--config', CONFIG, '--lock-dir', locks]);
    expect(r.code).toBe(0);
    const snippet = JSON.parse(r.stdout);
    const group = snippet.hooks.SessionStart[0];
    expect(group.matcher).toBe('startup|resume');
    expect(group.hooks.map((h: { args: string[] }) => h.args[h.args.indexOf('--server') + 1])).toEqual(['files', 'paged']);
    const h = group.hooks[0];
    expect(h).toMatchObject({ type: 'command', command: 'mcp-rc-check', timeout: 30 });
    expect(h.args.slice(0, 7)).toEqual(['surface', 'verify', '--strict', '--format', 'hook', '--fail-on', 'high']);
    expect(path.isAbsolute(h.args[h.args.indexOf('--lock') + 1])).toBe(true);
    expect(r.stderr).toContain('skipping legacy-sse');
    expect(r.stderr).toContain('no lock yet');
  });

  it('honours --exe and --fail-on', async () => {
    const r = await runMain(['hook', '--config', CONFIG, '--exe', 'npx -y @basitalisandhu/mcp-rc-check', '--fail-on', 'medium', '--server', 'files']);
    const h = JSON.parse(r.stdout).hooks.SessionStart[0].hooks[0];
    expect(h.command).toBe('npx');
    expect(h.args.slice(0, 4)).toEqual(['-y', '@basitalisandhu/mcp-rc-check', 'surface', 'verify']);
    expect(h.args).toContain('medium');
  });

  it('claude-settings with a single target uses --name', async () => {
    const dir = tmpDir();
    const lock = path.join(dir, 'l.json');
    await runMain(['lock', '--dump', fixture('fixture-base.json'), '-o', lock]);
    const r = await runMain(['hook', '--format', 'claude-settings', '--lock', lock, '--dump', fixture('fixture-added-tools.json'), '--name', 'files']);
    expect(JSON.parse(r.stdout).permissions.deny).toEqual(['mcp__files__delete_file', 'mcp__files__list_dir', 'mcp__files__run_task']);
    const high = await runMain(['hook', '--format', 'claude-settings', '--lock', lock, '--dump', fixture('fixture-added-tools.json'), '--fail-on', 'high']);
    expect(JSON.parse(high.stdout).permissions.deny).toEqual(['mcp__fixture-files__delete_file', 'mcp__fixture-files__run_task']);
    expect((await runMain(['hook', '--format', 'xml'])).code).toBe(2);
    expect(existsSync(lock)).toBe(true);
  });
});

describe('configuration edge cases', () => {
  it('uses the default for an empty variable, and expands url and headers for HTTP entries', () => {
    expect(expandVars('${E:-fallback}', { E: '' }, 'w')).toBe('fallback');
    const [e] = configEntries({ servers: { h: { type: 'http', url: 'https://${HOST:-example.invalid}/mcp', headers: { Authorization: 'Bearer ${TOK}' } } } });
    expect(resolveEntry(e!, { TOK: 't' })).toEqual({ name: 'h', transport: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer t' } });
  });

  it('infers http from a url and honours an explicit type', async () => {
    const { transportOf } = await import('../src/surface/config.js');
    expect(transportOf({ url: 'https://example.invalid' })).toBe('http');
    expect(transportOf({ type: 'SSE', url: 'x' })).toBe('sse');
    expect(transportOf({ command: 'x' })).toBe('stdio');
  });

  it('refuses a configured URL with credentials', async () => {
    const dir = tmpDir();
    const config = path.join(dir, 'mcp.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://user:mrc-url-secret@example.invalid/mcp' } } }));
    const r = await runMain(['watch-config', config, '--lock-dir', path.join(dir, 'locks')]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('contains credentials');
    expect(r.stdout + r.stderr).not.toContain('mrc-url-secret');
  });

  it('verify with --config and --server reads the right entry', async () => {
    const dir = tmpDir();
    const lock = path.join(dir, 'files.lock.json');
    expect((await runMain(['lock', '--config', CONFIG, '--server', 'paged', '-o', lock])).code).toBe(0);
    expect((await runMain(['verify', '--config', CONFIG, '--server', 'paged', '--lock', lock])).code).toBe(0);
    const missing = await runMain(['verify', '--config', CONFIG, '--server', 'nope', '--lock', lock]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('it has: files, paged, legacy-sse');
  });
});
