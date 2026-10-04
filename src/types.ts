/** Severity of a finding. `--fail-on` compares against this order: error > warning > info. */
export type Severity = 'error' | 'warning' | 'info';

export const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };

/** Which side of the protocol a rule is about. */
export type Side = 'server' | 'client';

/** Rule families, used for grouping in docs and output. */
export type Family =
  | 'version'
  | 'results'
  | 'capabilities'
  | 'tools'
  | 'errors'
  | 'transport'
  | 'client-capabilities'
  | 'client-config';

/** An RFC 6902 operation. Paths are RFC 6901 JSON Pointers into the input document. */
export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown };

export interface RuleMeta {
  /** Stable kebab-case id. */
  id: string;
  family: Family;
  side: Side;
  severity: Severity;
  /** One line: what the rule detects. */
  title: string;
  /** What to change, in one or two sentences. */
  change: string;
  /** The specification section the rule enforces (a modelcontextprotocol.io URL). */
  section: string;
  /** True when `--fix` can write the change as a patch. */
  autofix: boolean;
  /**
   * Set when the specification text is not a hard requirement for this case (a SHOULD, a deprecation,
   * or wording that leaves room). The string says why; docs/rules.md repeats it.
   */
  advisory?: string;
}

/** A finding produced by a rule. */
export interface Finding {
  ruleId: string;
  severity: Severity;
  /** What was found, in plain language. Never contains header values other than protocol versions. */
  message: string;
  /** The thing the finding is about: a tool name, a list method, a server entry, or "server". */
  subject: string;
  /** JSON Pointer to the offending value in the input document ("" for the root). */
  pointer: string;
  /** Patch operations against the input document that make the change, when mechanical. */
  fix?: PatchOp[];
}

export interface Summary {
  errors: number;
  warnings: number;
  infos: number;
}

export interface Report {
  /** What was checked: the dump or config path, the URL, or the stdio command. */
  target: string;
  /** "server" for scan, "client" for client. */
  mode: Side;
  /** Detected protocol era of the server, for scan. */
  era?: Era;
  findings: Finding[];
  summary: Summary;
}

/** Era terms from the versioning page: modern (per-request _meta), legacy (initialize), dual (both). */
export type Era = 'modern' | 'legacy' | 'dual' | 'unknown';
