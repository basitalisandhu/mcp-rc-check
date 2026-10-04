import type { Finding, PatchOp, RuleMeta } from '../types.js';

export interface Rule<T> extends RuleMeta {
  check: (input: T) => Finding[];
}

/** Build a finding for a rule. */
export function finding(
  rule: RuleMeta,
  subject: string,
  pointer: string,
  message: string,
  fix?: PatchOp[],
): Finding {
  return { ruleId: rule.id, severity: rule.severity, message, subject, pointer, ...(fix && fix.length > 0 ? { fix } : {}) };
}
