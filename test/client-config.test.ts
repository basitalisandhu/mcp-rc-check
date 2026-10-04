import { describe, expect, it } from 'vitest';
import { checkClientConfig } from '../src/check.js';
import { ConfigError } from '../src/config.js';
import { byRule, clientFixture, ids } from './helpers.js';

describe('client config rules', () => {
  const claude = clientFixture('fixture-claude-config.json');

  it('warns on a type "sse" entry', () => {
    expect(byRule(claude, 'client-sse-transport')[0]!.pointer).toBe('/mcpServers/docs/type');
  });

  it('flags a pinned MCP-Protocol-Version header and shows only the version', () => {
    const f = byRule(claude, 'client-pinned-protocol-header');
    expect(f[0]!.message).toBe('headers.MCP-Protocol-Version is pinned to "2025-06-18"');
    expect(f[0]!.fix).toEqual([{ op: 'remove', path: '/mcpServers/tickets/headers/MCP-Protocol-Version' }]);
  });

  it('flags static Mcp-Method and Mcp-Session-Id headers with removal fixes', () => {
    expect(byRule(claude, 'client-static-routing-header')[0]!.fix).toEqual([{ op: 'remove', path: '/mcpServers/tickets/headers/Mcp-Method' }]);
    expect(byRule(claude, 'client-session-id-header')[0]!.severity).toBe('warning');
  });

  it('never echoes a header value other than a version', () => {
    const text = claude.findings.map((f) => f.message).join('\n');
    expect(text).not.toContain('pinned-session');
    expect(text).not.toContain('TICKETS_TOKEN');
    expect(text).not.toContain('tools/call');
  });

  it('notes legacy versions in args and env as advisory', () => {
    const f = byRule(claude, 'client-legacy-version-pin');
    expect(f.map((x) => x.pointer)).toEqual(['/mcpServers/local/args/3', '/mcpServers/local/env/MCP_PROTOCOL_VERSION']);
  });

  it('reads ~/.claude.json projects and notes a pin equal to the target revision', () => {
    const r = clientFixture('fixture-claude-user-config.json');
    expect(byRule(r, 'client-pinned-protocol-header')[0]!.message).toContain('breaks version fallback');
    const routing = byRule(r, 'client-static-routing-header');
    expect(routing[0]!.subject).toBe('/work/app:app-db');
    expect(routing[0]!.pointer).toBe('/projects/~1work~1app/mcpServers/app-db/headers/Mcp-Param-Region');
  });

  it('infers SSE from a /sse URL in a Cursor config and flags Last-Event-ID', () => {
    const r = clientFixture('fixture-cursor-config.json');
    expect(byRule(r, 'client-sse-transport')[0]!.message).toContain('/sse');
    expect(byRule(r, 'client-last-event-id-header')[0]!.subject).toBe('streamable');
  });

  it('reads the VS Code servers key', () => {
    const r = clientFixture('fixture-vscode-config.json');
    expect(ids(r).sort()).toEqual(['client-sse-transport', 'client-static-routing-header']);
  });

  it('reports nothing for a clean config', () => {
    expect(clientFixture('fixture-clean-config.json').findings).toEqual([]);
  });

  it('rejects a file with no server map', () => {
    expect(() => checkClientConfig({ hello: 1 }, 'x')).toThrow(ConfigError);
    expect(() => checkClientConfig([], 'x')).toThrow(ConfigError);
  });

  it('honours --disable', () => {
    const r = checkClientConfig({ mcpServers: { a: { type: 'sse', url: 'https://a.example.invalid/x' } } }, 'x', { disable: ['client-sse-transport'] });
    expect(r.findings).toEqual([]);
  });

  describe('VS Code input references', () => {
    const vscodeInput = clientFixture('fixture-vscode-inputs-config.json');

    it('shows input name for exact input reference headers', () => {
      const findings = vscodeInput.findings;
      const mcpNameFinding = findings.find(f => f.message.includes('Mcp-Name') && f.message.includes('input'));
      expect(mcpNameFinding).toBeDefined();
      expect(mcpNameFinding!.message).toContain('(value comes from input "mcp-name")');
      expect(mcpNameFinding!.message).not.toContain('${input:mcp-name}');
      expect(mcpNameFinding!.message).not.toContain('actual-mcp-name-value');
    });

    it('does not echo ordinary header values', () => {
      const findings = vscodeInput.findings;
      const messages = findings.map(f => f.message).join('\\n');
      expect(messages).not.toContain('secret-token');
      expect(messages).not.toContain('Bearer secret-token');
    });
  });
});
