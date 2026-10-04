import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDump } from '../src/check.js';
import { scanStdio } from '../src/live/scan.js';
import { ConnectionError } from '../src/live/transport.js';
import { splitCommand } from '../src/shellwords.js';
import { runCli, runMain, serverCommand } from './helpers.js';

const opts = { timeoutMs: 5000, clientVersion: 'test' };

describe('live scan over stdio', () => {
  it('scans a modern server with no findings, following pagination', async () => {
    const dump = await scanStdio(serverCommand('modern'), opts);
    expect(dump.era).toBe('modern');
    expect(dump.lists['tools/list']).toHaveLength(2);
    expect(Object.keys(dump.lists).sort()).toEqual(['prompts/list', 'resources/list', 'resources/templates/list', 'tools/list']);
    expect(dump.probes.unsupportedVersion?.error?.code).toBe(-32022);
    expect(dump.probes.resourceNotFound?.error?.code).toBe(-32602);
    expect(dump.probes.headerMismatch).toBeUndefined();
    expect(checkDump(dump, 'live').findings).toEqual([]);
  });

  it('records the command without its arguments', async () => {
    const dump = await scanStdio(serverCommand('modern'), opts);
    expect(dump.source).toEqual({ kind: 'stdio', target: 'node (+2 arguments)' });
  });

  it('falls back to initialize for a legacy server', async () => {
    const dump = await scanStdio(serverCommand('legacy'), opts);
    expect(dump.era).toBe('legacy');
    expect(dump.initialize?.result?.protocolVersion).toBe('2025-11-25');
    const ids = checkDump(dump, 'live').findings.map((f) => f.ruleId);
    expect(ids).toContain('legacy-only-server');
    expect(ids).toContain('tasks-capability-moved');
  });

  it('falls back after a timeout for a server that ignores server/discover', async () => {
    const dump = await scanStdio(serverCommand('silent'), { ...opts, probeTimeoutMs: 300 });
    expect(dump.discover?.timedOut).toBe(true);
    expect(dump.era).toBe('legacy');
  });

  it('detects a dual-era server', async () => {
    const dump = await scanStdio(serverCommand('dual'), opts);
    expect(dump.era).toBe('dual');
    expect(checkDump(dump, 'live').findings).toEqual([]);
  });

  it('finds the lax server problems live', async () => {
    const ids = new Set(checkDump(await scanStdio(serverCommand('lax'), opts), 'live').findings.map((f) => f.ruleId));
    for (const id of ['unsupported-version-error', 'result-type-missing', 'cache-hints-missing', 'x-mcp-header-invalid', 'tools-order-unstable', 'resource-not-found-code']) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('throws a ConnectionError with stderr for a server that exits', async () => {
    await expect(scanStdio(serverCommand('crash'), opts)).rejects.toThrow(/crashing on purpose/);
    await expect(scanStdio(serverCommand('crash'), opts)).rejects.toBeInstanceOf(ConnectionError);
  });

  it('throws a ConnectionError for a program that does not exist', async () => {
    await expect(scanStdio('mcp-rc-check-no-such-program-x', opts)).rejects.toBeInstanceOf(ConnectionError);
  });

  it('exits 2 from the CLI when the server cannot be reached', async () => {
    const r = await runCli(['scan', '--stdio', serverCommand('crash')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('server/discover');
  });

  it('saves a dump that re-checks to the same findings', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-rc-check-'));
    try {
      const file = path.join(dir, 'dump.json');
      const live = await runMain(['scan', '--stdio', serverCommand('legacy'), '--save-dump', file, '--format', 'json']);
      expect(live.code).toBe(1);
      const again = await runMain(['scan', '--dump', file, '--format', 'json']);
      const strip = (s: string) => JSON.parse(s).findings;
      expect(strip(again.stdout)).toEqual(strip(live.stdout));
      expect(JSON.parse(readFileSync(file, 'utf8')).mcpRcCheckDump).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('command splitting', () => {
  it('honours quotes and escapes', () => {
    expect(splitCommand(`node "my server.js" --name 'a b' c\\ d`)).toEqual(['node', 'my server.js', '--name', 'a b', 'c d']);
    expect(splitCommand('  a   b ')).toEqual(['a', 'b']);
    expect(splitCommand(`x "" y`)).toEqual(['x', '', 'y']);
  });

  it('rejects an unterminated quote', () => {
    expect(() => splitCommand('node "oops')).toThrow(/unterminated/);
  });
});
