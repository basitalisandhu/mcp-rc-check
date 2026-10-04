import { describe, expect, it } from 'vitest';
import { byRule, ids, scanFixture } from './helpers.js';

describe('client capability rules (from a captured request)', () => {
  const r = scanFixture('fixture-client-capabilities.json');

  it('warns on roots and sampling, mentioning sampling.context', () => {
    expect(byRule(r, 'client-roots-deprecated')[0]!.pointer).toBe('/params/capabilities/roots');
    expect(byRule(r, 'client-sampling-deprecated')[0]!.message).toContain('sampling.context');
  });

  it('flags tasks as a core client capability', () => {
    expect(byRule(r, 'client-tasks-capability-moved')[0]!.severity).toBe('error');
  });

  it('accepts modern per-request client capabilities', () => {
    expect(ids(scanFixture('fixture-client-capabilities-modern.json'))).toEqual([]);
  });
});
