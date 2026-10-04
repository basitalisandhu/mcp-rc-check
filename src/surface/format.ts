/** Output of `surface verify` and `surface verify-config`: table, json, sarif (the shared writer) and hook. */
import { sarifLog, type SarifLevel } from '../format.js';
import { counts, fails, type Change, type SurfaceReport } from './compare.js';
import { ruleName } from './config.js';
import { atOrAbove, changeClassById, SURFACE_RULES, type SurfaceSeverity } from './rules.js';

export type SurfaceFormat = 'table' | 'json' | 'sarif' | 'hook';
export const VERIFY_FORMATS: SurfaceFormat[] = ['table', 'json', 'sarif', 'hook'];

const PREFIX = 'mcp-rc-check surface';
const DOCS = 'https://github.com/basitalisandhu/mcp-rc-check/blob/main/docs/surface.md';

function summaryLine(changes: Change[]): string {
  const c = counts(changes);
  return `${c.high} high, ${c.medium} medium, ${c.low} low`;
}

export function formatSurfaceTable(report: SurfaceReport): string {
  const lines: string[] = [`${PREFIX} verify: ${report.target}`];
  const multi = report.servers.length > 1 || report.servers.some((s) => s.status !== 'compared');
  if (multi) {
    lines.push('');
    for (const s of report.servers) {
      const n = report.changes.filter((c) => c.server === s.name).length;
      const detail = s.status === 'compared' ? `${n} change(s)` : s.status === 'error' ? `error: ${s.error}` : s.status === 'skipped' ? `skipped: ${s.error}` : s.status;
      lines.push(`  ${s.name.padEnd(24)} ${detail}`);
    }
  }
  if (report.changes.length === 0 && report.errors.length === 0) {
    lines.push('', 'No changes since the lock was written.');
    return lines.join('\n') + '\n';
  }
  if (report.changes.length > 0) {
    lines.push('');
    const subj = (c: Change): string => (multi && c.server ? `${c.server}/${c.subject}` : c.subject);
    const w1 = Math.max(...report.changes.map((c) => c.ruleId.length));
    const w2 = Math.max(...report.changes.map((c) => subj(c).length));
    for (const c of report.changes) {
      lines.push(`${c.severity.toUpperCase().padEnd(6)} ${c.ruleId.padEnd(w1)}  ${subj(c).padEnd(w2)}  ${c.message}`);
    }
  }
  for (const e of report.errors) lines.push(`ERROR  ${e}`);
  lines.push('', summaryLine(report.changes) + (report.errors.length ? `, ${report.errors.length} error(s)` : ''));
  if (report.changes.some((c) => c.tool !== undefined && c.ruleId !== 'tool-removed' && c.ruleId !== 'tool-removed-required')) {
    lines.push(`Review with \`${PREFIX} diff <tool>\`; accept a reviewed change by running \`${PREFIX} lock\` again.`);
  }
  return lines.join('\n') + '\n';
}

export function formatSurfaceJson(report: SurfaceReport, toolVersion: string): string {
  const doc = {
    tool: 'mcp-rc-check',
    command: 'surface verify',
    version: toolVersion,
    target: report.target,
    servers: report.servers,
    summary: counts(report.changes),
    changes: report.changes.map((c) => ({ ...c, title: changeClassById(c.ruleId).title })),
    errors: report.errors,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

const LEVEL: Record<SurfaceSeverity, SarifLevel> = { high: 'error', medium: 'warning', low: 'note' };
const SECURITY_SEVERITY: Record<SurfaceSeverity, string> = { high: '8.0', medium: '5.0', low: '2.0' };

/** SARIF 2.1.0 through the shared writer: one reportingDescriptor per change class, one result per change, located at the lock file. */
export function formatSurfaceSarif(report: SurfaceReport, options: { toolVersion: string; artifactUri: string; lockUris?: Record<string, string> }): string {
  const uri = (c: Change): string => (c.server && options.lockUris?.[c.server]) || options.artifactUri;
  return sarifLog({
    toolVersion: options.toolVersion,
    rules: SURFACE_RULES.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.help,
      helpUri: `${DOCS}#${r.id}`,
      level: LEVEL[r.severity],
      properties: { tags: ['security', 'mcp', 'tool-surface'], 'security-severity': SECURITY_SEVERITY[r.severity] },
    })),
    results: report.changes.map((c) => ({
      ruleId: c.ruleId,
      level: LEVEL[c.severity],
      message: `${c.server ? `${c.server}: ` : ''}${c.subject}: ${c.message}`,
      uri: uri(c),
      logicalName: c.subject,
      fullyQualifiedName: c.server ? `${c.server}/${c.subject}` : c.subject,
      fingerprint: { key: 'mcpRcCheckSurface/v1', text: `${c.ruleId}\n${c.server ?? ''}\n${c.subject}` },
    })),
    errors: report.errors,
  });
}

/** Claude Code SessionStart output: block at or above the threshold, warn below it, nothing when clean. */
export function formatHook(report: SurfaceReport, failOn: SurfaceSeverity, strict: boolean): string {
  if (report.errors.length > 0) {
    const msg = `${PREFIX}: cannot verify the MCP tool surface: ${report.errors.join('; ')}`;
    return JSON.stringify(strict ? { continue: false, stopReason: msg } : { systemMessage: msg }) + '\n';
  }
  if (report.changes.length === 0) return '';
  const shown = report.changes.slice(0, 6).map((c) => `${c.server ? `${c.server}/` : ''}${c.subject} ${c.ruleId} (${c.severity.toUpperCase()})`);
  const more = report.changes.length > shown.length ? ` and ${report.changes.length - shown.length} more` : '';
  const head = `${PREFIX}: ${report.changes.length} change(s) to the MCP tool surface since the lock was written: ${shown.join('; ')}${more}.`;
  const tail = ` Review with \`${PREFIX} verify\` and \`${PREFIX} diff <tool>\`; if the change is expected, accept it by running \`${PREFIX} lock\` again.`;
  if (fails(report, failOn)) {
    return JSON.stringify({ continue: false, stopReason: `${head} The session was stopped because a change is at or above ${failOn.toUpperCase()}.${tail}` }) + '\n';
  }
  return JSON.stringify({ systemMessage: head + tail }) + '\n';
}

/** A permissions.deny fragment naming every changed or added tool at or above the threshold. */
export function denyFragment(report: SurfaceReport, failOn: SurfaceSeverity, fallbackServer: string): string {
  const rules = new Set<string>();
  for (const c of report.changes) {
    if (c.tool === undefined || c.ruleId === 'tool-removed' || c.ruleId === 'tool-removed-required') continue;
    if (!atOrAbove(c.severity, failOn)) continue;
    rules.add(`mcp__${ruleName(c.server ?? fallbackServer)}__${c.tool}`);
  }
  return JSON.stringify({ permissions: { deny: [...rules].sort() } }, null, 2) + '\n';
}
