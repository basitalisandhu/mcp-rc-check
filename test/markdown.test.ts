import { describe, expect, it } from 'vitest';
import { formatMarkdown, formatRules, formatTable } from '../src/format.js';
import type { Finding, Report } from '../src/types.js';
import { scanFixture, clientFixture, runMain } from './helpers.js';

describe('Markdown output', () => {
  const report = scanFixture('fixture-pre-revision.json');
  const markdown = formatMarkdown(report);

  it('has a heading with target', () => {
    expect(markdown).toContain('mcp-rc-check scan: node (+2 arguments)');
  });

  it('has era in Markdown format', () => {
    expect(markdown).toContain('**Era:** `legacy`');
  });

  it('has a table header', () => {
    expect(markdown).toContain('| Severity | Rule | Subject | Message |');
    expect(markdown).toContain('| --- | --- | --- | --- |');
  });

  it('has at least one row with legacy-only-server', () => {
    expect(markdown).toContain('legacy-only-server');
  });

  it('links the rule to its specification section', () => {
    expect(markdown).toContain('[legacy-only-server](');
    expect(markdown).toContain('https://modelcontextprotocol.io/specification/2026-07-28/server/discover');
  });

  it('includes subject and message', () => {
    expect(markdown).toContain('[');
    expect(markdown).toContain(']');
    expect(markdown).toContain('the server negotiated protocolVersion');
  });

  it('includes the summary', () => {
    expect(markdown).toContain('**Summary:**');
    expect(markdown).toContain('8 errors, 2 warnings, 3 info;');
    expect(markdown).toContain('4 with an autofix');
  });
});

describe('Markdown output for rules', () => {
  it('shows the rules table in Markdown format', () => {
    const markdown = formatRules('markdown');
    expect(markdown).toContain('| Rule | Side | Severity | Fix | Advisory | Spec section |');
    expect(markdown).toContain('| --- | --- | --- | --- | --- | --- |');
    expect(markdown).toContain('legacy-only-server');
  });

  it('gives every row the same number of cells as the header', () => {
    const rows = formatRules('markdown').split('\n').filter((l) => l.startsWith('|'));
    const width = (l: string): number => l.split(/(?<!\\)\|/).length;
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(width(row)).toBe(width(rows[0]!));
  });
});

describe('Markdown escaping', () => {
  function reportWith(findings: Finding[]): Report {
    return { mode: 'server', target: 'node fixture-server.mjs', era: 'modern', findings, summary: { errors: findings.length, warnings: 0, infos: 0 } };
  }

  it('escapes a pipe in the subject and message so the row is not split', () => {
    const markdown = formatMarkdown(
      reportWith([{ ruleId: 'legacy-only-server', severity: 'error', subject: 'tools|list', message: 'has a | pipe', pointer: '/x' }]),
    );
    const row = markdown.split('\n').find((l) => l.includes('legacy-only-server'));
    expect(row).toBeDefined();
    expect(row).toContain('tools\\|list');
    expect(row).toContain('has a \\| pipe');
    // Count only unescaped pipes: a Markdown reader splits cells on those.
    expect(row!.split(/(?<!\\)\|/).length).toBe(6);
  });

  it('flattens a newline in a message so the table keeps its shape', () => {
    const markdown = formatMarkdown(
      reportWith([{ ruleId: 'legacy-only-server', severity: 'error', subject: 's', message: 'first line\nsecond line', pointer: '/x' }]),
    );
    expect(markdown).toContain('first line second line');
    expect(markdown.split('\n').filter((l) => l.startsWith('|') && l.includes('legacy-only-server'))).toHaveLength(1);
  });

  it('leaves the other formats alone', () => {
    expect(formatTable(reportWith([{ ruleId: 'legacy-only-server', severity: 'error', subject: 'a|b', message: 'm', pointer: '/x' }]))).toContain(
      '[a|b]',
    );
  });
});

describe('CLI --format markdown', () => {
  it('is accepted by scan', async () => {
    const r = await runMain(['scan', '--dump', 'test/fixtures/fixture-pre-revision.json', '--format', 'markdown']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('mcp-rc-check scan: test/fixtures/fixture-pre-revision.json');
    expect(r.stdout).toContain('| Severity | Rule | Subject | Message |');
    expect(r.stdout).toContain('**Summary:**');
  });

  it('is accepted by client', async () => {
    const r = await runMain(['client', '--config', 'test/fixtures/fixture-claude-config.json', '--format', 'markdown']);
    expect(r.stdout).toContain('mcp-rc-check client: test/fixtures/fixture-claude-config.json');
  });

  it('is accepted by rules', async () => {
    const r = await runMain(['rules', '--format', 'markdown']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('| Rule | Side | Severity |');
  });

  it('keeps the other formats working', async () => {
    expect((await runMain(['rules', '--format', 'json'])).stdout.trimStart().startsWith('[')).toBe(true);
    expect((await runMain(['scan', '--dump', 'test/fixtures/fixture-pre-revision.json', '--format', 'sarif'])).stdout).toContain('"$schema"');
    expect((await runMain(['scan', '--dump', 'test/fixtures/fixture-pre-revision.json'])).stdout).toContain('error(s)');
  });

  it('lists markdown in the usage text', async () => {
    expect((await runMain(['--help'])).stdout).toContain('table (default), json, sarif, markdown');
  });

  it('still rejects an unknown format', async () => {
    const r = await runMain(['rules', '--format', 'xml']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('must be table, json, sarif or markdown');
  });
});

describe('Markdown output for client config', () => {
  it('works for client config', () => {
    const report = clientFixture('fixture-claude-config.json');
    const markdown = formatMarkdown(report);
    expect(markdown).toContain('mcp-rc-check client: fixture-claude-config.json');
    // Client configs don't have an era, so we shouldn't expect it
  });
});

describe('Markdown output with no findings', () => {
  const report = scanFixture('fixture-post-revision.json');
  const markdown = formatMarkdown(report);

  it('handles no findings without a table', () => {
    expect(markdown).toContain('No findings for the');
    expect(markdown).not.toContain('| Severity | Rule | Subject | Message |');
  });
});