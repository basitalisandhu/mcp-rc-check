import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectHttp, collectStdio } from '../src/live/surface.js';
import { ConnectionError } from '../src/live/transport.js';
import { readLock } from '../src/surface/lockfile.js';
import { handle } from './fixtures/surface/fixture-protocol.mjs';
import { main } from '../src/cli.js';
import { runMain, ROOT, SERVER, SERVER_CMD, tmpDir } from './surface-helpers.js';

const opts = { timeoutMs: 5000, clientVersion: 'test' };

describe('stdio', () => {
  it('lock then verify is clean, and the changed mode is caught', async () => {
    const dir = tmpDir();
    const lock = path.join(dir, 'l.json');
    const locked = await runMain(['lock', '--stdio', SERVER_CMD, '-o', lock]);
    expect(locked.code).toBe(0);
    expect(locked.stdout).toContain('3 tool(s), 1 prompt(s), 1 resource(s), 1 template(s)');
    expect(readLock(lock).source).toEqual({ kind: 'stdio', target: 'node (+1 argument)' });
    expect((await runMain(['verify', '--lock', lock, '--stdio', SERVER_CMD])).code).toBe(0);
    const changed = await runMain(['verify', '--lock', lock, '--stdio', SERVER_CMD, '-e', 'FIXTURE_MODE=changed']);
    expect(changed.code).toBe(1);
    expect(changed.stdout).toContain('tool-description-changed');
    expect(changed.stdout).toContain('tool-input-schema-changed');
    expect(changed.stdout).toContain('tool-added-unsafe');
  });

  it('follows pagination to the same surface', async () => {
    const one = await collectStdio(['node', SERVER], opts);
    const paged = await collectStdio(['node', SERVER], { ...opts, env: { FIXTURE_PAGE_SIZE: '1' } });
    expect(paged.surface.tools).toEqual(one.surface.tools);
    expect(paged.surface.resourceTemplates).toEqual(one.surface.resourceTemplates);
  });

  it('stops at --max-pages', async () => {
    await expect(collectStdio(['node', SERVER], { ...opts, maxPages: 2, env: { FIXTURE_PAGE_SIZE: '1' } })).rejects.toThrow(/after 2/);
  });

  it('falls back to server/discover for a 2026-07-28 server', async () => {
    const { surface } = await collectStdio(['node', SERVER], { ...opts, env: { FIXTURE_ERA: 'modern' } });
    expect(surface.protocolVersion).toBe('2026-07-28');
    expect(surface.server.name).toBe('fixture-files');
    expect(surface.tools).toHaveLength(3);
  });

  it('passes only a minimal environment plus what was asked for', async () => {
    process.env.MRC_TEST_SECRET_VALUE = 'do-not-pass';
    try {
      const { surface } = await collectStdio(['node', SERVER], { ...opts, env: { FIXTURE_REPORT_ENV: '1' } });
      const keys = String(surface.tools.find((t) => t.name === 'env_keys')!.description).split(',');
      expect(keys).toContain('FIXTURE_REPORT_ENV');
      expect(keys).not.toContain('MRC_TEST_SECRET_VALUE');
      for (const k of keys) expect(['FIXTURE_REPORT_ENV', 'HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'TMPDIR', 'LANG', '__CF_USER_TEXT_ENCODING']).toContain(k);
    } finally {
      delete process.env.MRC_TEST_SECRET_VALUE;
    }
  });

  it('reports a server that does not start or exits', async () => {
    await expect(collectStdio(['node', '-e', 'process.exit(3)'], opts)).rejects.toThrow(ConnectionError);
    await expect(collectStdio('', opts)).rejects.toThrow(/empty/);
    await expect(collectStdio('"unterminated', opts)).rejects.toThrow(/unterminated/);
    const r = await runMain(['lock', '--stdio', 'definitely-not-a-command-tsp', '-o', path.join(tmpDir(), 'x.json')]);
    expect(r.code).toBe(2);
  });
});

describe('Streamable HTTP', () => {
  let server: Server;
  let url = '';
  const seenAuth: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'DELETE') return void res.writeHead(200).end();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seenAuth.push(String(req.headers.authorization ?? ''));
        const msg = JSON.parse(body);
        if (msg.id === undefined) return void res.writeHead(202).end();
        const env = { FIXTURE_MODE: req.url?.includes('changed') ? 'changed' : 'unchanged' };
        const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...handle(msg, env) });
        if (msg.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${reply}\n\n`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' }).end(reply);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('reads the surface over JSON and SSE responses', async () => {
    const { surface, target } = await collectHttp(url, opts);
    expect(target).toBe(url);
    expect(surface.tools).toHaveLength(3);
  });

  it('lock and verify by URL, without saving the header', async () => {
    const lock = path.join(tmpDir(), 'l.json');
    expect((await runMain(['lock', '--url', url, '-H', 'Authorization: Bearer fixture-token', '-o', lock])).code).toBe(0);
    expect(seenAuth).toContain('Bearer fixture-token');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(lock, 'utf8')).not.toContain('fixture-token');
    expect((await runMain(['verify', '--lock', lock, '--url', url])).code).toBe(0);
    expect((await runMain(['verify', '--lock', lock, '--url', `${url}/changed`])).code).toBe(1);
  });

  it('refuses credentials in the URL and other schemes', async () => {
    await expect(collectHttp('http://user:pw@127.0.0.1:1/mcp', opts)).rejects.toThrow(/contains credentials/);
    await expect(collectHttp('ftp://127.0.0.1/mcp', opts)).rejects.toThrow(/scheme/);
    const r = await runMain(['lock', '--url', 'https://user:secret-value@example.invalid/mcp', '-o', path.join(tmpDir(), 'x.json')]);
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain('secret-value');
  });

  it('reports an unreachable endpoint as exit 2', async () => {
    const r = await runMain(['verify', '--lock', path.join(tmpDir(), 'none.json'), '--url', 'http://127.0.0.1:1/mcp', '--timeout', '2000']);
    expect(r.code).toBe(2);
  });
});

describe('stdio lock output', () => {
  it('records a server on the 2026-07-28 revision and paginated lists in one lock', async () => {
    const lock = path.join(tmpDir(), 'l.json');
    const r = await runMain(['lock', '--stdio', SERVER_CMD, '-e', 'FIXTURE_ERA=modern', '-e', 'FIXTURE_PAGE_SIZE=2', '-o', lock]);
    expect(r.code).toBe(0);
    const l = readLock(lock);
    expect(l.protocolVersion).toBe('2026-07-28');
    expect(l.toolOrder).toEqual(['read_file', 'search_files', 'write_file']);
    expect(Object.keys(l.resourceTemplates)).toEqual(['fixture://notes/{id}']);
  });

  it('never writes the stdio arguments into the lock', async () => {
    const lock = path.join(tmpDir(), 'l.json');
    await runMain(['lock', '--stdio', `${SERVER_CMD} --token=mrc-arg-secret`, '-o', lock]);
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(lock, 'utf8');
    expect(text).not.toContain('mrc-arg-secret');
    expect(readLock(lock).source.target).toBe('node (+2 arguments)');
  });
});

describe('one code path with scan', () => {
  it('a dump saved by scan --save-dump locks to the same surface as the live server', async () => {
    const dir = tmpDir();
    const dump = path.join(dir, 'scan.json');
    let err = '';
    const code = await main(['scan', '--stdio', SERVER_CMD, '--save-dump', dump], { stdout: () => undefined, stderr: (t) => (err += t), cwd: ROOT });
    expect(code).toBeLessThan(2);
    expect(err).toContain('saved the dump');
    const fromDump = path.join(dir, 'dump.lock.json');
    const fromLive = path.join(dir, 'live.lock.json');
    expect((await runMain(['lock', '--dump', dump, '-o', fromDump])).code).toBe(0);
    expect((await runMain(['lock', '--stdio', SERVER_CMD, '-o', fromLive])).code).toBe(0);
    expect(readLock(fromDump).surfaceHash).toBe(readLock(fromLive).surfaceHash);
    expect(readLock(fromDump).covers).toEqual(['tools', 'prompts', 'resources', 'server']);
    expect((await runMain(['verify', '--lock', fromDump, '--stdio', SERVER_CMD])).code).toBe(0);
  });

  it('sends no probe requests: a lock never asks for resources/read or tools/call', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body);
        seen.push(msg.method);
        if (msg.id === undefined) return void res.writeHead(202).end();
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...handle(msg, {}) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const { surface } = await collectHttp(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, opts);
      expect(surface.tools).toHaveLength(3);
      expect([...new Set(seen)].sort()).toEqual(['initialize', 'notifications/initialized', 'prompts/list', 'resources/list', 'resources/templates/list', 'server/discover', 'tools/list']);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
