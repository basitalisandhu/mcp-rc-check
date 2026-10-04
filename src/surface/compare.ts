/** Compare a locked surface with a current one and classify every difference. */
import type { Lock } from './lockfile.js';
import { surfaceFromLock } from './lockfile.js';
import { RANK, RULE_ORDER, changeClassById, atOrAbove, type SurfaceSeverity } from './rules.js';
import { effectiveHints, type NormalisedSurface, type NormalisedTool, type Part } from './normalise.js';
import { canonicalJson, type JsonObject } from './json.js';

export interface Change {
  ruleId: string;
  severity: SurfaceSeverity;
  /** The configured server name, in verify-config; otherwise the server's reported name, if any. */
  server?: string;
  /** What changed: a tool name, `prompt:<name>`, `resource:<uri>`, `template:<uriTemplate>` or `server`. */
  subject: string;
  /** The tool name when the change is about one tool (used for deny rules). */
  tool?: string;
  message: string;
}

export interface SurfaceReport {
  /** What was compared, for headings: a lock path or a configuration path. */
  target: string;
  servers: { name: string; lock?: string; status: 'compared' | 'unlocked' | 'removed' | 'skipped' | 'error'; error?: string; tools?: number }[];
  changes: Change[];
  errors: string[];
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function change(ruleId: string, subject: string, message: string, tool?: string): Change {
  return { ruleId, severity: changeClassById(ruleId).severity, subject, message, ...(tool !== undefined ? { tool } : {}) };
}

function hintWord(v: boolean): string {
  return v ? 'true' : 'false';
}

function compareTool(name: string, old: NormalisedTool, cur: NormalisedTool): Change[] {
  const out: Change[] = [];
  if (old.description !== cur.description) {
    out.push(change('tool-description-changed', name, `description changed (${old.description?.length ?? 0} to ${cur.description?.length ?? 0} characters); see \`mcp-rc-check surface diff ${name}\``, name));
  }
  if (!same(old.inputSchema, cur.inputSchema)) out.push(change('tool-input-schema-changed', name, 'inputSchema changed', name));
  if (!same(old.outputSchema, cur.outputSchema)) {
    const what = old.outputSchema === undefined ? 'outputSchema added' : cur.outputSchema === undefined ? 'outputSchema removed' : 'outputSchema changed';
    out.push(change('tool-output-schema-changed', name, what, name));
  }
  const a = effectiveHints(old);
  const b = effectiveHints(cur);
  const downgrades: string[] = [];
  if (a.readOnly && !b.readOnly) downgrades.push('readOnlyHint true to false');
  if (!a.destructive && b.destructive) downgrades.push(`destructiveHint false to true${cur.annotations?.destructiveHint === undefined ? ' (not set, which defaults to true)' : ''}`);
  if (downgrades.length > 0) out.push(change('tool-annotation-downgrade', name, downgrades.join('; ') + (cur.annotations === undefined ? ' (annotations removed)' : ''), name));
  const { title: oldTitle, ...oldRest } = old.annotations ?? {};
  const { title: curTitle, ...curRest } = cur.annotations ?? {};
  if (!same(oldRest, curRest) && downgrades.length === 0) {
    const parts: string[] = [];
    for (const [key, x, y] of [
      ['readOnlyHint', a.readOnly, b.readOnly],
      ['destructiveHint', a.destructive, b.destructive],
      ['idempotentHint', a.idempotent, b.idempotent],
      ['openWorldHint', a.openWorld, b.openWorld],
    ] as const) {
      if (x !== y) parts.push(`${key} ${hintWord(x)} to ${hintWord(y)}`);
    }
    out.push(change('tool-annotation-changed', name, parts.length > 0 ? parts.join('; ') : 'annotations changed without changing an effective hint', name));
  }
  // Other hints that moved alongside a downgrade are covered by the downgrade finding.
  if (old.title !== cur.title || !same(oldTitle, curTitle)) out.push(change('tool-title-changed', name, 'title changed', name));
  const others: string[] = [];
  if (!same(old.execution, cur.execution)) others.push('execution');
  if (!same(old.icons, cur.icons)) others.push('icons');
  const keys = new Set([...Object.keys(old.other ?? {}), ...Object.keys(cur.other ?? {})]);
  for (const k of [...keys].sort()) if (!same(old.other?.[k], cur.other?.[k])) others.push(k);
  if (others.length > 0) out.push(change('tool-other-field-changed', name, `${others.join(', ')} changed`, name));
  return out;
}

function compareEntries(rule: string, prefix: string, label: string, old: Record<string, JsonObject>, cur: Record<string, JsonObject>): Change[] {
  const out: Change[] = [];
  for (const key of new Set([...Object.keys(old), ...Object.keys(cur)])) {
    if (!(key in cur)) out.push(change(rule, `${prefix}:${key}`, `${label} removed`));
    else if (!(key in old)) out.push(change(rule, `${prefix}:${key}`, `${label} added`));
    else if (!same(old[key], cur[key])) out.push(change(rule, `${prefix}:${key}`, `${label} changed`));
  }
  return out;
}

export function compareSurfaces(old: NormalisedSurface, cur: NormalisedSurface, required: Set<string> = new Set()): Change[] {
  const out: Change[] = [];
  for (const name of Object.keys(old.tools)) {
    const now = cur.tools[name];
    if (!now) {
      out.push(required.has(name) ? change('tool-removed-required', name, 'required tool removed', name) : change('tool-removed', name, 'tool removed', name));
      continue;
    }
    out.push(...compareTool(name, old.tools[name]!, now));
  }
  for (const name of Object.keys(cur.tools)) {
    if (name in old.tools) continue;
    const t = cur.tools[name]!;
    const h = effectiveHints(t);
    if (h.readOnly) out.push(change('tool-added-readonly', name, 'new tool, marked readOnlyHint: true', name));
    else {
      const why = !h.annotated ? 'no annotations' : t.annotations?.destructiveHint === true ? 'marked destructiveHint: true' : 'not marked readOnlyHint: true';
      out.push(change('tool-added-unsafe', name, `new tool (${why})`, name));
    }
  }
  const common = (list: string[], other: NormalisedSurface): string[] => list.filter((n) => n in other.tools);
  const a = common(old.toolOrder, cur);
  const b = common(cur.toolOrder, old);
  if (a.join('\0') !== b.join('\0')) out.push(change('tool-order-changed', 'tools', 'the tools are listed in a different order'));
  const both = (p: Part): boolean => old.covers.includes(p) && cur.covers.includes(p);
  if (both('server')) out.push(...compareServer(old, cur));
  if (both('prompts')) out.push(...compareEntries('prompt-changed', 'prompt', 'prompt', old.prompts, cur.prompts));
  if (both('resources')) {
    out.push(...compareEntries('resource-changed', 'resource', 'resource', old.resources, cur.resources));
    out.push(...compareEntries('resource-changed', 'template', 'resource template', old.resourceTemplates, cur.resourceTemplates));
  }
  return sortChanges(out);
}

function compareServer(old: NormalisedSurface, cur: NormalisedSurface): Change[] {
  const out: Change[] = [];
  if ((old.instructions ?? '') !== (cur.instructions ?? '')) {
    const what = old.instructions === undefined ? 'instructions added' : cur.instructions === undefined ? 'instructions removed' : 'instructions changed';
    out.push(change('server-instructions-changed', 'server', what));
  }
  if (old.server.name !== cur.server.name) {
    out.push(change('server-identity-changed', 'server', `serverInfo.name ${JSON.stringify(old.server.name ?? null)} to ${JSON.stringify(cur.server.name ?? null)}`));
  }
  const versions: string[] = [];
  if (old.server.version !== cur.server.version) versions.push(`serverInfo.version ${old.server.version ?? '-'} to ${cur.server.version ?? '-'}`);
  if (old.protocolVersion !== cur.protocolVersion) versions.push(`protocol version ${old.protocolVersion ?? '-'} to ${cur.protocolVersion ?? '-'}`);
  if (versions.length > 0) out.push(change('server-version-changed', 'server', versions.join('; ')));
  return out;
}

export function compareWithLock(lock: Lock, cur: NormalisedSurface): Change[] {
  const required = new Set(Object.entries(lock.tools).filter(([, t]) => t.required).map(([n]) => n));
  return compareSurfaces(surfaceFromLock(lock), cur, required);
}

export function sortChanges(changes: Change[]): Change[] {
  return [...changes].sort(
    (x, y) =>
      RANK[y.severity] - RANK[x.severity] ||
      (x.server ?? '').localeCompare(y.server ?? '') ||
      RULE_ORDER.get(x.ruleId)! - RULE_ORDER.get(y.ruleId)! ||
      (x.subject < y.subject ? -1 : x.subject > y.subject ? 1 : 0),
  );
}

export function fails(report: SurfaceReport, threshold: SurfaceSeverity): boolean {
  return report.changes.some((c) => atOrAbove(c.severity, threshold));
}

export function counts(changes: Change[]): Record<SurfaceSeverity, number> {
  return {
    high: changes.filter((c) => c.severity === 'high').length,
    medium: changes.filter((c) => c.severity === 'medium').length,
    low: changes.filter((c) => c.severity === 'low').length,
  };
}
