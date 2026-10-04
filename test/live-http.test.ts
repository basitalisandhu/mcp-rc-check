import { afterEach, describe, expect, it } from 'vitest';
import { checkDump } from '../src/check.js';
import { scanHttp } from '../src/live/scan.js';
import { ConnectionError } from '../src/live/transport.js';
// @ts-expect-error: plain JavaScript fixture without type declarations
import { startServer } from './fixtures/fixture-http-server.mjs';
import { runMain } from './helpers.js';

interface Fixture {
  url: string;
  close: () => Promise<void>;
}

const opts = { timeoutMs: 5000, clientVersion: 'test' };
let server: Fixture | undefined;

async function start(mode: string): Promise<Fixture> {
  server = (await startServer(mode)) as Fixture;
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('live scan over Streamable HTTP (loopback only)', () => {
  it('scans a modern server cleanly, including an SSE response', async () => {
    const s = await start('modern');
    const dump = await scanHttp(s.url, opts);
    expect(dump.era).toBe('modern');
    expect(dump.lists['tools/list']).toHaveLength(2);
    expect(dump.probes.headerMismatch?.http?.status).toBe(400);
    expect(dump.probes.unknownMethod?.http?.status).toBe(404);
    expect(dump.probes.httpGet?.status).toBe(405);
    expect(checkDump(dump, 'live').findings).toEqual([]);
  });

  it('reports the transport problems of a lax server', async () => {
    const s = await start('lax');
    const ids = new Set(checkDump(await scanHttp(s.url, opts), 'live').findings.map((f) => f.ruleId));
    for (const id of ['http-header-mismatch-accepted', 'http-missing-header-accepted', 'http-unknown-method-status', 'http-session-id', 'http-get-stream']) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('falls back to a legacy session server', async () => {
    const s = await start('legacy');
    const dump = await scanHttp(s.url, opts);
    expect(dump.era).toBe('legacy');
    expect(dump.lists['tools/list']?.[0]?.result).toBeDefined();
    expect(JSON.stringify(dump)).not.toContain('fixture-session');
  });

  it('detects a dual-era server', async () => {
    const s = await start('dual');
    expect((await scanHttp(s.url, opts)).era).toBe('dual');
  });

  it('records the URL without its query string', async () => {
    const s = await start('modern');
    const dump = await scanHttp(`${s.url}?k=v`, opts);
    expect(dump.source.target).toBe(s.url);
  });

  it('refuses credentials embedded in the URL without echoing them', async () => {
    const err = await scanHttp('http://user:pw@127.0.0.1:1/mcp', opts).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).not.toContain('pw');
  });

  it('throws a ConnectionError when nothing listens', async () => {
    const s = await start('modern');
    const url = s.url;
    await s.close();
    server = undefined;
    await expect(scanHttp(url, opts)).rejects.toBeInstanceOf(ConnectionError);
  });

  it('rejects a non-HTTP URL', async () => {
    await expect(scanHttp('ftp://127.0.0.1/mcp', opts)).rejects.toThrow(/unsupported URL scheme/);
  });

  it('runs end to end through the CLI with SARIF output', async () => {
    const s = await start('lax');
    const r = await runMain(['scan', '--url', s.url, '--format', 'sarif']);
    expect(r.code).toBe(1);
    const sarif = JSON.parse(r.stdout);
    expect(sarif.runs[0].artifacts[0].location.uri).toBe(s.url);
  });
});
