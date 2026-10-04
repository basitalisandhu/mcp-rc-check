import { describe, expect, it } from 'vitest';
import { byRule, scanFixture } from './helpers.js';

describe('error-code rules', () => {
  it('flags an empty contents array for an unknown resource', () => {
    const f = byRule(scanFixture('fixture-errors.json'), 'resource-not-found-code');
    expect(f[0]!.message).toBe('an unknown URI returned an empty contents array');
  });

  it('flags the retired -32002 resource-not-found code', () => {
    const f = byRule(scanFixture('fixture-transport-lax.json'), 'resource-not-found-code');
    expect(f[0]!.message).toContain('-32002 is resource not found');
  });
});

describe('HTTP transport rules', () => {
  const r = scanFixture('fixture-transport-lax.json');

  it('flags an accepted header mismatch', () => {
    expect(byRule(r, 'http-header-mismatch-accepted')[0]!.message).toContain('was accepted (HTTP 200)');
  });

  it('flags an accepted request without Mcp-Method', () => {
    expect(byRule(r, 'http-missing-header-accepted')[0]!.message).toContain('without Mcp-Method was accepted');
  });

  it('flags an unknown method that is not a 404', () => {
    expect(byRule(r, 'http-unknown-method-status').map((f) => f.message)).toEqual(['an unknown method returned HTTP 200; expected 404']);
  });

  it('warns about session IDs on modern responses', () => {
    expect(byRule(r, 'http-session-id')[0]!.pointer).toBe('/discover/http/sessionIdHeader');
  });

  it('warns when GET opens a stream instead of 405', () => {
    expect(byRule(r, 'http-get-stream')[0]!.message).toBe('GET returned HTTP 200 and opened an event stream');
  });

  it('runs no transport rules on a stdio dump', () => {
    const pre = scanFixture('fixture-post-revision.json');
    expect(pre.findings.filter((f) => f.ruleId.startsWith('http-'))).toEqual([]);
  });
});
