import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allRules } from '../src/check.js';
import { ROOT } from './helpers.js';

const rulesDoc = readFileSync(path.join(ROOT, 'docs', 'rules.md'), 'utf8');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

describe('rule metadata', () => {
  it('has unique kebab-case ids', () => {
    const ids = allRules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('cites a 2026-07-28 specification page for every rule', () => {
    for (const r of allRules) expect(r.section).toMatch(/^https:\/\/modelcontextprotocol\.io\/specification\/2026-07-28\/[a-z]/);
  });

  it('documents every rule, its section and its advisory reason in docs/rules.md', () => {
    for (const r of allRules) {
      expect(rulesDoc).toContain(`\`${r.id}\``);
      expect(rulesDoc).toContain(r.section);
      if (r.advisory) expect(rulesDoc).toContain(r.advisory);
    }
  });

  it('lists every rule in the README table', () => {
    for (const r of allRules) expect(readme).toContain(`\`${r.id}\``);
  });
});

describe('fixtures', () => {
  it('are named so common ignore patterns cannot hide them', () => {
    const dir = path.join(ROOT, 'test', 'fixtures');
    for (const name of readdirSync(dir)) {
      if (name === 'expected' || name === 'surface') continue;
      expect(name).toMatch(/^fixture-[a-z0-9-]+\.(json|mjs)$/);
    }
  });
});
