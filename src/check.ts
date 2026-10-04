import { clientView, type ClientView } from './config.js';
import { normalise, type View } from './dump.js';
import { clientRules } from './rules/client.js';
import { serverRules } from './rules/server.js';
import { SEVERITY_RANK, type Finding, type Report, type RuleMeta, type Severity, type Summary } from './types.js';

/** Every rule this version implements, server rules first. */
export const allRules: RuleMeta[] = [...serverRules, ...clientRules].map(({ check: _check, ...meta }) => meta);

export function ruleById(id: string): RuleMeta | undefined {
  return allRules.find((r) => r.id === id);
}

function sortFindings(findings: Finding[]): Finding[] {
  const order = new Map(allRules.map((r, i) => [r.id, i] as const));
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (order.get(a.ruleId) ?? 0) - (order.get(b.ruleId) ?? 0) ||
      a.pointer.localeCompare(b.pointer),
  );
}

export function summarise(findings: Finding[]): Summary {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length,
  };
}

export interface CheckOptions {
  /** Rule ids to skip. */
  disable?: string[];
}

/** Run the server rules over an already-normalised view. */
export function checkView(view: View, target: string, options: CheckOptions = {}): Report {
  const skip = new Set(options.disable ?? []);
  const findings = sortFindings(serverRules.filter((r) => !skip.has(r.id)).flatMap((r) => r.check(view)));
  return { target, mode: 'server', era: view.era, findings, summary: summarise(findings) };
}

/** Normalise a dump document and check it. */
export function checkDump(doc: unknown, target: string, options: CheckOptions = {}): Report {
  return checkView(normalise(doc), target, options);
}

/** Check a client configuration document. */
export function checkClientConfig(doc: unknown, target: string, options: CheckOptions = {}): Report {
  const view: ClientView = clientView(doc);
  const skip = new Set(options.disable ?? []);
  const findings = sortFindings(clientRules.filter((r) => !skip.has(r.id)).flatMap((r) => r.check(view)));
  return { target, mode: 'client', findings, summary: summarise(findings) };
}

/** True when any finding is at or above the threshold. */
export function failsAt(report: Report, threshold: Severity): boolean {
  return report.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[threshold]);
}
