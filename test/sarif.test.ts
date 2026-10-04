import { describe, expect, it } from 'vitest';
import { allRules } from '../src/check.js';
import { formatJson, formatSarif, formatTable } from '../src/format.js';
import { scanFixture, clientFixture } from './helpers.js';

describe('SARIF output', () => {
  const report = scanFixture('fixture-pre-revision.json');
  const sarif = JSON.parse(formatSarif(report, { toolVersion: '0.1.0', artifactUri: 'test/fixtures/fixture-pre-revision.json' }));
  const run = sarif.runs[0];

  it('is SARIF 2.1.0 with the tool driver', () => {
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-2.1.0');
    expect(run.tool.driver.name).toBe('mcp-rc-check');
    expect(run.tool.driver.version).toBe('0.1.0');
  });

  it('lists server rules with the spec section as helpUri', () => {
    const ids = run.tool.driver.rules.map((r: { id: string }) => r.id);
    expect(ids).toContain('legacy-only-server');
    expect(ids).not.toContain('client-sse-transport');
    for (const r of run.tool.driver.rules) {
      expect(r.helpUri).toMatch(/^https:\/\/modelcontextprotocol\.io\/specification\/2026-07-28\//);
    }
  });

  it('points every result at a valid rule index with a fingerprint and location', () => {
    expect(run.results).toHaveLength(report.findings.length);
    for (const res of run.results) {
      expect(run.tool.driver.rules[res.ruleIndex].id).toBe(res.ruleId);
      expect(['error', 'warning', 'note']).toContain(res.level);
      expect(res.partialFingerprints['mcpRcCheck/v1']).toMatch(/^[0-9a-f]{32}$/);
      expect(res.locations[0].physicalLocation.artifactLocation.uri).toBe('test/fixtures/fixture-pre-revision.json');
      expect(res.locations[0].logicalLocations[0].fullyQualifiedName).toMatch(/^\//);
    }
  });

  it('carries the autofix operations as result properties', () => {
    const withFix = run.results.filter((r: { properties?: unknown }) => r.properties);
    expect(withFix.length).toBe(report.findings.filter((f) => f.fix).length);
  });

  it('tags advisory rules', () => {
    const logging = run.tool.driver.rules.find((r: { id: string }) => r.id === 'logging-capability-deprecated');
    expect(logging.properties.tags).toContain('advisory');
  });

  it('lists client rules for a client report', () => {
    const c = JSON.parse(formatSarif(clientFixture('fixture-claude-config.json'), { toolVersion: '0', artifactUri: 'x' }));
    const ids = c.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    expect(ids).toEqual(allRules.filter((r) => r.side === 'client').map((r) => r.id).filter((id) => ids.includes(id)));
    expect(ids).toContain('client-pinned-protocol-header');
  });
});

describe('JSON and table output', () => {
  it('JSON carries section, change and advisory per finding', () => {
    const doc = JSON.parse(formatJson(scanFixture('fixture-pre-revision.json'), '0.1.0'));
    expect(doc.revision).toBe('2026-07-28');
    expect(doc.era).toBe('legacy');
    expect(doc.summary).toEqual({ errors: 8, warnings: 2, infos: 3 });
    for (const f of doc.findings) {
      expect(f.section).toMatch(/^https:\/\/modelcontextprotocol\.io\//);
      expect(typeof f.change).toBe('string');
      expect(typeof f.advisory).toBe('boolean');
    }
  });

  it('table shows the spec link and a summary line', () => {
    const t = formatTable(scanFixture('fixture-pre-revision.json'));
    expect(t).toContain('spec:   https://modelcontextprotocol.io/specification/2026-07-28/server/discover');
    expect(t).toMatch(/8 error\(s\), 2 warning\(s\), 3 info; 4 with an autofix\n$/);
  });

  it('table says so when there are no findings', () => {
    expect(formatTable(scanFixture('fixture-post-revision.json'))).toContain('No findings for the 2026-07-28 revision.');
  });
});
