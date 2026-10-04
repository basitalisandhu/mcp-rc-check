import { describe, expect, it } from 'vitest';
import { formatMarkdown, formatRules } from '../src/format.js';
import { scanFixture, clientFixture } from './helpers.js';

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
    expect(markdown).toContain('5 errors, 2 warnings, 3 info;');
    expect(markdown).toContain('4 with an autofix');
  });
});

describe('Markdown output for rules', () => {
  it('shows the rules table in Markdown format', () => {
    const markdown = formatRules('markdown');
    expect(markdown).toContain('| Rule | Side | Severity | Fix | Spec section |');
    expect(markdown).toContain('| --- | --- | --- | --- | --- |');
    expect(markdown).toContain('legacy-only-server');
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