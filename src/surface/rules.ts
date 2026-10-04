/** Every kind of change verify can report, with its severity. docs/surface.md documents each one. */

export type SurfaceSeverity = 'high' | 'medium' | 'low';
export const SEVERITIES: SurfaceSeverity[] = ['high', 'medium', 'low'];
export const RANK: Record<SurfaceSeverity, number> = { high: 3, medium: 2, low: 1 };

export interface ChangeClass {
  id: string;
  severity: SurfaceSeverity;
  title: string;
  /** Why the change matters and what to do about it. */
  help: string;
}

export const SURFACE_RULES: ChangeClass[] = [
  {
    id: 'tool-description-changed',
    severity: 'high',
    title: 'The description of a locked tool changed',
    help: 'The model reads tool descriptions as instructions. A changed description is the classic rug pull: approve a harmless text, then swap it. Read the diff before accepting it.',
  },
  {
    id: 'tool-input-schema-changed',
    severity: 'high',
    title: 'The input schema of a locked tool changed',
    help: 'New or renamed parameters, parameter descriptions and defaults change what the model sends to the tool. Read the diff before accepting it.',
  },
  {
    id: 'tool-added-unsafe',
    severity: 'high',
    title: 'A new tool that is not marked read-only',
    help: 'The tool was not in the lock and does not declare readOnlyHint: true (it is a write tool, is marked destructive, or has no annotations). Review it before a session can call it.',
  },
  {
    id: 'tool-annotation-downgrade',
    severity: 'high',
    title: 'A locked tool lost a safety hint',
    help: 'readOnlyHint went from true to false, or destructiveHint from false to true (absent hints count as their specification defaults). Permission rules that trusted the old hint may now allow a write.',
  },
  {
    id: 'tool-removed-required',
    severity: 'high',
    title: 'A tool the lock marks as required is gone',
    help: 'The lock was created with --require for this tool. Workflows that depend on it will break, or a renamed tool is standing in for it.',
  },
  {
    id: 'server-instructions-changed',
    severity: 'high',
    title: 'The server instructions changed',
    help: 'Instructions from initialize are given to the model like a description. Treated like a description change (classification inferred, see docs/surface.md).',
  },
  {
    id: 'server-unlocked',
    severity: 'high',
    title: 'A configured server has no lock',
    help: 'The client configuration declares a server that has never been locked, so nothing about its tools has been reviewed. Lock it with surface watch-config after reviewing it.',
  },
  {
    id: 'tool-added-readonly',
    severity: 'medium',
    title: 'A new tool marked read-only',
    help: 'The tool declares readOnlyHint: true. Annotations are hints the server chooses, so review the description and schema anyway.',
  },
  {
    id: 'tool-output-schema-changed',
    severity: 'medium',
    title: 'The output schema of a locked tool changed',
    help: 'Structured results now have a different shape. Text in an output schema can also reach the model.',
  },
  {
    id: 'tool-annotation-changed',
    severity: 'medium',
    title: 'Another annotation of a locked tool changed',
    help: 'For example readOnlyHint false to true, openWorldHint or idempotentHint. A tool that newly claims to be read-only may now be auto-allowed by rules generated from annotations; check that the claim is true.',
  },
  {
    id: 'tool-other-field-changed',
    severity: 'medium',
    title: 'Another field of a locked tool changed',
    help: 'execution, icons or a field this version does not know about changed.',
  },
  {
    id: 'prompt-changed',
    severity: 'medium',
    title: 'A prompt was added, removed or changed',
    help: 'Prompts are templates a user can insert; their text reaches the model when used.',
  },
  {
    id: 'resource-changed',
    severity: 'medium',
    title: 'A resource or resource template was added, removed or changed',
    help: 'Resource names and descriptions are shown to the user and can be attached to the context.',
  },
  {
    id: 'server-identity-changed',
    severity: 'medium',
    title: 'The server reports a different name',
    help: 'serverInfo.name changed. Check that the command or URL still points at the server you reviewed.',
  },
  {
    id: 'tool-title-changed',
    severity: 'low',
    title: 'The display title of a locked tool changed',
    help: 'title or annotations.title changed. Titles are for people, not the model (inferred, see docs/surface.md).',
  },
  {
    id: 'tool-order-changed',
    severity: 'low',
    title: 'The tools are listed in a different order',
    help: 'Same tools, same definitions, new order.',
  },
  {
    id: 'tool-removed',
    severity: 'low',
    title: 'A tool is gone',
    help: 'Removing a tool cannot widen what a session can do. Mark tools you depend on with surface lock --require to make their removal HIGH.',
  },
  {
    id: 'server-version-changed',
    severity: 'low',
    title: 'The server reports a different version or protocol version',
    help: 'Informational: serverInfo.version or the negotiated protocol version changed. The tool surface itself is compared separately.',
  },
  {
    id: 'server-removed',
    severity: 'low',
    title: 'A locked server is no longer configured',
    help: 'A lock exists for a server that the client configuration no longer declares.',
  },
];

const BY_ID = new Map(SURFACE_RULES.map((r) => [r.id, r] as const));
export const RULE_ORDER = new Map(SURFACE_RULES.map((r, i) => [r.id, i] as const));

export function changeClassById(id: string): ChangeClass {
  const r = BY_ID.get(id);
  if (!r) throw new Error(`unknown change class ${id}`);
  return r;
}

export function atOrAbove(severity: SurfaceSeverity, threshold: SurfaceSeverity): boolean {
  return RANK[severity] >= RANK[threshold];
}
