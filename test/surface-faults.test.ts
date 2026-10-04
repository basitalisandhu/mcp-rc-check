import { describe, expect, it } from 'vitest';
import { collectStdio } from '../src/live/surface.js';
import { SERVER } from './surface-helpers.js';

const opts = { timeoutMs: 5000, clientVersion: 'test' };
const run = (env: Record<string, string>) => collectStdio(['node', SERVER], { ...opts, env });

describe('server faults', () => {
  it('detects a pagination loop', async () => {
    await expect(run({ FIXTURE_FAULT: 'cursor-loop' })).rejects.toThrow(/twice; the pagination loops/);
  });

  it('rejects a tools/list result without a tools array', async () => {
    await expect(run({ FIXTURE_FAULT: 'no-tools-array' })).rejects.toThrow(/no "tools" array/);
  });

  it('reports a JSON-RPC error from tools/list', async () => {
    await expect(run({ FIXTURE_FAULT: 'list-error' })).rejects.toThrow(/tools\/list failed: JSON-RPC error -32603/);
  });

  it('reports when neither server/discover nor initialize works', async () => {
    await expect(run({ FIXTURE_FAULT: 'init-error' })).rejects.toThrow(/neither server\/discover .* nor initialize/);
  });

  it('declines a server-initiated request and carries on', async () => {
    const { surface } = await run({ FIXTURE_FAULT: 'server-request' });
    expect(surface.tools).toHaveLength(3);
  });

  it('times out on a server that never answers', async () => {
    await expect(collectStdio(['node', '-e', 'setInterval(() => {}, 1000)'], { ...opts, timeoutMs: 300 })).rejects.toThrow(/no response within the timeout/);
  });

  it('includes the tail of the server stderr in a connection error', async () => {
    await expect(collectStdio(['node', '-e', 'console.error("fixture stderr line"); process.exit(2)'], opts)).rejects.toThrow(/fixture stderr line/);
  });
});
