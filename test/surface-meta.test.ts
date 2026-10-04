import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allRules } from '../src/check.js';
import { SURFACE_RULES } from '../src/surface/rules.js';
import { FIXTURES, ROOT } from './surface-helpers.js';

const surfaceDoc = readFileSync(path.join(ROOT, 'docs', 'surface.md'), 'utf8');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

describe('change class metadata', () => {
  it('has unique kebab-case ids that do not collide with the specification rules', () => {
    const ids = SURFACE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const spec = new Set(allRules.map((r) => r.id));
    for (const id of ids) expect(spec.has(id)).toBe(false);
  });

  it('documents every change class with its severity in docs/surface.md and the README', () => {
    for (const r of SURFACE_RULES) {
      expect(surfaceDoc).toContain(`### ${r.id}`);
      expect(surfaceDoc).toContain(r.help);
      expect(surfaceDoc).toContain(`| [\`${r.id}\`](#${r.id}) | ${r.severity.toUpperCase()} |`);
      expect(readme).toContain(`\`${r.id}\``);
    }
  });

  it('keeps the severities the semantics fix', () => {
    const sev = Object.fromEntries(SURFACE_RULES.map((r) => [r.id, r.severity]));
    for (const id of ['tool-description-changed', 'tool-input-schema-changed', 'tool-added-unsafe', 'tool-annotation-downgrade', 'tool-removed-required', 'server-instructions-changed']) expect(sev[id]).toBe('high');
    for (const id of ['tool-added-readonly', 'tool-output-schema-changed']) expect(sev[id]).toBe('medium');
    for (const id of ['tool-title-changed', 'tool-order-changed']) expect(sev[id]).toBe('low');
  });
});

describe('surface fixtures', () => {
  it('are named so common ignore patterns cannot hide them', () => {
    for (const name of readdirSync(FIXTURES)) expect(name).toMatch(/^fixture-[a-z0-9-]+\.(json|mjs)$/);
  });

  it('carry neutral text only', () => {
    for (const name of readdirSync(FIXTURES)) {
      const text = readFileSync(path.join(FIXTURES, name), 'utf8');
      expect(text).not.toMatch(/ignore (all |any )?previous|id_rsa|\.ssh|exfiltrat|password|secret/i);
    }
  });
});
