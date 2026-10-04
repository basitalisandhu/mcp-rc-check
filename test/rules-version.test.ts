import { describe, expect, it } from 'vitest';
import { byRule, ids, scanFixture } from './helpers.js';

describe('version rules', () => {
  it('flags a legacy-only server from the pre-revision dump', () => {
    const r = scanFixture('fixture-pre-revision.json');
    expect(r.era).toBe('legacy');
    const f = byRule(r, 'legacy-only-server');
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain('"2025-11-25"');
    expect(f[0]!.pointer).toBe('/initialize/result');
  });

  it('reports nothing for the post-revision dump', () => {
    const r = scanFixture('fixture-post-revision.json');
    expect(r.era).toBe('modern');
    expect(r.findings).toEqual([]);
  });

  it('checks the server/discover result shape', () => {
    const f = byRule(scanFixture('fixture-version.json'), 'discover-result-shape');
    expect(f.map((x) => x.message)).toEqual(['capabilities is missing or not an object']);
  });

  it('flags a modern server that does not list the target revision', () => {
    const f = byRule(scanFixture('fixture-version.json'), 'target-revision-not-supported');
    expect(f[0]!.message).toBe('supportedVersions is ["2026-09-01"]');
  });

  it('flags a discover that rejects the target revision with -32022', () => {
    const f = byRule(scanFixture('fixture-version-unsupported.json'), 'target-revision-not-supported');
    expect(f[0]!.message).toContain('UnsupportedProtocolVersionError');
    expect(f[0]!.message).toContain('2026-09-01');
  });

  it('flags a server that accepts an unknown protocol version', () => {
    const f = byRule(scanFixture('fixture-version.json'), 'unsupported-version-error');
    expect(f[0]!.message).toContain('accepted instead of rejected');
  });

  it('flags an UnsupportedProtocolVersionError without data.supported', () => {
    const f = byRule(scanFixture('fixture-version-unsupported.json'), 'unsupported-version-error');
    expect(f.map((x) => x.pointer)).toEqual(['/probes/unsupportedVersion/error/data']);
  });

  it('names the renumbered draft code when a server answers -32004', () => {
    const f = byRule(scanFixture('fixture-transport-lax.json'), 'unsupported-version-error');
    expect(f[0]!.message).toContain('-32004 is UnsupportedProtocolVersion draft number');
    expect(f[1]!.message).toBe('the HTTP status is 200, expected 400');
  });

  it('gives info when initialize is rejected without naming versions', () => {
    const r = scanFixture('fixture-version.json');
    expect(byRule(r, 'initialize-error-names-versions')[0]!.severity).toBe('info');
  });

  it('runs no version rules on a bare tools/list result', () => {
    const r = scanFixture('fixture-results.json');
    expect(ids(r).some((id) => ['legacy-only-server', 'discover-result-shape', 'unsupported-version-error'].includes(id))).toBe(false);
  });
});
