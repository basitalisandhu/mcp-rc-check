import { createHash } from 'node:crypto';
import { allRules, ruleById } from './check.js';
import type { Report, Severity } from './types.js';

export type Format = 'table' | 'json' | 'sarif';

const LABEL: Record<Severity, string> = { error: 'ERROR', warning: 'WARN', info: 'INFO' };

/** Human-readable table, grouped as one line per finding with the change and the spec section. */
export function formatTable(report: Report): string {
  const lines: string[] = [];
  const era = report.era ? ` (era: ${report.era})` : '';
  lines.push(`mcp-rc-check ${report.mode === 'server' ? 'scan' : 'client'}: ${report.target}${era}`);
  if (report.findings.length === 0) {
    lines.push('No findings for the 2026-07-28 revision.');
    return lines.join('\n') + '\n';
  }
  lines.push('');
  for (const f of report.findings) {
    const rule = ruleById(f.ruleId);
    const tags = [rule?.advisory ? 'advisory' : '', f.fix ? 'autofix' : ''].filter(Boolean).join(', ');
    lines.push(`${LABEL[f.severity].padEnd(5)} ${f.ruleId}  [${f.subject}]${tags ? `  (${tags})` : ''}`);
    lines.push(`      ${f.message}`);
    if (rule) {
      lines.push(`      change: ${rule.change}`);
      lines.push(`      spec:   ${rule.section}`);
    }
    if (f.pointer) lines.push(`      at:     ${f.pointer}`);
    lines.push('');
  }
  const s = report.summary;
  const fixable = report.findings.filter((f) => f.fix).length;
  lines.push(`${s.errors} error(s), ${s.warnings} warning(s), ${s.infos} info; ${fixable} with an autofix`);
  return lines.join('\n') + '\n';
}

export function formatJson(report: Report, toolVersion: string): string {
  const doc = {
    tool: 'mcp-rc-check',
    version: toolVersion,
    revision: '2026-07-28',
    target: report.target,
    mode: report.mode,
    ...(report.era ? { era: report.era } : {}),
    summary: report.summary,
    findings: report.findings.map((f) => {
      const rule = ruleById(f.ruleId);
      return {
        ...f,
        section: rule?.section,
        change: rule?.change,
        advisory: rule?.advisory !== undefined,
      };
    }),
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { error: 'error', warning: 'warning', info: 'note' };

export interface SarifOptions {
  toolVersion: string;
  /** Artifact URI the results point at: the dump or config path, or the server URL. */
  artifactUri: string;
}

/** SARIF 2.1.0 with one reportingDescriptor per rule and the spec section as helpUri. */
export function formatSarif(report: Report, options: SarifOptions): string {
  const rules = allRules.filter((r) => r.side === report.mode || report.findings.some((f) => f.ruleId === r.id));
  const index = new Map(rules.map((r, i) => [r.id, i] as const));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'mcp-rc-check',
            version: options.toolVersion,
            informationUri: 'https://github.com/basitalisandhu/mcp-rc-check',
            rules: rules.map((r) => ({
              id: r.id,
              name: r.id
                .split('-')
                .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
                .join(''),
              shortDescription: { text: r.title },
              fullDescription: { text: r.advisory ? `${r.title}. Advisory: ${r.advisory}` : r.title },
              help: { text: `${r.change} See ${r.section}` },
              helpUri: r.section,
              defaultConfiguration: { level: LEVEL[r.severity] },
              properties: { tags: ['mcp', 'mcp-2026-07-28', r.family, ...(r.advisory ? ['advisory'] : [])] },
            })),
          },
        },
        artifacts: [{ location: { uri: options.artifactUri } }],
        results: report.findings.map((f) => ({
          ruleId: f.ruleId,
          ruleIndex: index.get(f.ruleId),
          level: LEVEL[f.severity],
          message: { text: `${f.subject}: ${f.message}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: options.artifactUri, index: 0 },
                region: { startLine: 1, startColumn: 1 },
              },
              logicalLocations: [{ name: f.subject, fullyQualifiedName: f.pointer || '/', kind: 'member' }],
            },
          ],
          partialFingerprints: {
            'mcpRcCheck/v1': createHash('sha256').update(`${f.ruleId}\n${f.subject}\n${f.pointer}`).digest('hex').slice(0, 32),
          },
          ...(f.fix ? { properties: { autofix: f.fix } } : {}),
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2) + '\n';
}

/** Rules as a table or JSON, for `mcp-rc-check rules`. */
export function formatRules(format: Format): string {
  if (format === 'json') return JSON.stringify(allRules, null, 2) + '\n';
  const lines = allRules.map(
    (r) => `${r.id.padEnd(32)} ${r.side.padEnd(6)} ${r.severity.padEnd(7)} ${r.autofix ? 'autofix ' : '        '}${r.advisory ? 'advisory ' : '         '}${r.section}`,
  );
  return ['id                               side   severity fix     advisory  section', ...lines].join('\n') + '\n';
}
