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

const LEVEL: Record<Severity, SarifLevel> = { error: 'error', warning: 'warning', info: 'note' };

export type SarifLevel = 'error' | 'warning' | 'note';

/** One reportingDescriptor for the shared SARIF writer. */
export interface SarifRule {
  id: string;
  title: string;
  description: string;
  help?: string;
  helpUri: string;
  level: SarifLevel;
  properties: Record<string, unknown>;
}

/** One result for the shared SARIF writer. */
export interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: string;
  uri: string;
  /** Index into the run's artifacts, when the run lists them. */
  artifactIndex?: number;
  logicalName: string;
  fullyQualifiedName: string;
  /** partialFingerprints key and the text hashed into its value. */
  fingerprint: { key: string; text: string };
  properties?: Record<string, unknown>;
}

export interface SarifRun {
  toolVersion: string;
  rules: SarifRule[];
  results: SarifResult[];
  artifacts?: string[];
  /** Errors that stopped part of the run; recorded as tool execution notifications. */
  errors?: string[];
}

/** PascalCase name of a kebab-case rule id. */
function pascal(id: string): string {
  return id
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** The one SARIF 2.1.0 writer behind `scan`, `client` and `surface verify`. */
export function sarifLog(run: SarifRun): string {
  const index = new Map(run.rules.map((r, i) => [r.id, i] as const));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'mcp-rc-check',
            version: run.toolVersion,
            informationUri: 'https://github.com/basitalisandhu/mcp-rc-check',
            rules: run.rules.map((r) => ({
              id: r.id,
              name: pascal(r.id),
              shortDescription: { text: r.title },
              fullDescription: { text: r.description },
              ...(r.help !== undefined ? { help: { text: r.help } } : {}),
              helpUri: r.helpUri,
              defaultConfiguration: { level: r.level },
              properties: r.properties,
            })),
          },
        },
        ...(run.artifacts ? { artifacts: run.artifacts.map((uri) => ({ location: { uri } })) } : {}),
        results: run.results.map((f) => ({
          ruleId: f.ruleId,
          ruleIndex: index.get(f.ruleId),
          level: f.level,
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.uri, ...(f.artifactIndex !== undefined ? { index: f.artifactIndex } : {}) },
                region: { startLine: 1, startColumn: 1 },
              },
              logicalLocations: [{ name: f.logicalName, fullyQualifiedName: f.fullyQualifiedName, kind: 'member' }],
            },
          ],
          partialFingerprints: {
            [f.fingerprint.key]: createHash('sha256').update(f.fingerprint.text).digest('hex').slice(0, 32),
          },
          ...(f.properties ? { properties: f.properties } : {}),
        })),
        ...(run.errors && run.errors.length > 0
          ? { invocations: [{ executionSuccessful: false, toolExecutionNotifications: run.errors.map((e) => ({ level: 'error', message: { text: e } })) }] }
          : {}),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2) + '\n';
}

export interface SarifOptions {
  toolVersion: string;
  /** Artifact URI the results point at: the dump or config path, or the server URL. */
  artifactUri: string;
}

/** SARIF 2.1.0 with one reportingDescriptor per rule and the spec section as helpUri. */
export function formatSarif(report: Report, options: SarifOptions): string {
  const rules = allRules.filter((r) => r.side === report.mode || report.findings.some((f) => f.ruleId === r.id));
  return sarifLog({
    toolVersion: options.toolVersion,
    rules: rules.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.advisory ? `${r.title}. Advisory: ${r.advisory}` : r.title,
      help: `${r.change} See ${r.section}`,
      helpUri: r.section,
      level: LEVEL[r.severity],
      properties: { tags: ['mcp', 'mcp-2026-07-28', r.family, ...(r.advisory ? ['advisory'] : [])] },
    })),
    artifacts: [options.artifactUri],
    results: report.findings.map((f) => ({
      ruleId: f.ruleId,
      level: LEVEL[f.severity],
      message: `${f.subject}: ${f.message}`,
      uri: options.artifactUri,
      artifactIndex: 0,
      logicalName: f.subject,
      fullyQualifiedName: f.pointer || '/',
      fingerprint: { key: 'mcpRcCheck/v1', text: `${f.ruleId}\n${f.subject}\n${f.pointer}` },
      ...(f.fix ? { properties: { autofix: f.fix } } : {}),
    })),
  });
}

/** Rules as a table or JSON, for `mcp-rc-check rules`. */
export function formatRules(format: Format): string {
  if (format === 'json') return JSON.stringify(allRules, null, 2) + '\n';
  const lines = allRules.map(
    (r) => `${r.id.padEnd(32)} ${r.side.padEnd(6)} ${r.severity.padEnd(7)} ${r.autofix ? 'autofix ' : '        '}${r.advisory ? 'advisory ' : '         '}${r.section}`,
  );
  return ['id                               side   severity fix     advisory  section', ...lines].join('\n') + '\n';
}
