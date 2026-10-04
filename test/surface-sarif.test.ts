import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serialiseLock } from '../src/surface/lockfile.js';
import { SURFACE_RULES as RULES } from '../src/surface/rules.js';
import { fixture, lockOf, runMain, tmpDir } from './surface-helpers.js';

describe('SARIF', () => {
  it('is SARIF 2.1.0 with one rule per change class and one result per change', async () => {
    const lock = path.join(tmpDir(), 'l.json');
    writeFileSync(lock, serialiseLock(lockOf('fixture-base.json')));
    const r = await runMain(['verify', '--lock', lock, '--dump', fixture('fixture-added-tools.json'), '--format', 'sarif']);
    expect(r.code).toBe(1);
    const sarif = JSON.parse(r.stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toMatch(/sarif-2\.1\.0/);
    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe('mcp-rc-check');
    expect(run.tool.driver.rules.map((x: { id: string }) => x.id)).toEqual(RULES.map((x) => x.id));
    for (const rule of run.tool.driver.rules) {
      expect(rule.properties['security-severity']).toMatch(/^\d\.\d$/);
      expect(rule.helpUri).toContain(`docs/surface.md#${rule.id}`);
    }
    expect(run.results).toHaveLength(3);
    const first = run.results[0];
    expect(first).toMatchObject({ ruleId: 'tool-added-unsafe', level: 'error' });
    expect(run.tool.driver.rules[first.ruleIndex].id).toBe(first.ruleId);
    expect(first.locations[0].physicalLocation.artifactLocation.uri).toMatch(/l\.json$/);
    expect(first.partialFingerprints['mcpRcCheckSurface/v1']).toMatch(/^[0-9a-f]{32}$/);
    expect(run.results.map((x: { level: string }) => x.level)).toEqual(['error', 'error', 'warning']);
  });
});
