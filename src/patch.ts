import { parse } from './pointer.js';
import type { Finding, PatchOp } from './types.js';
import { isObject } from './util.js';

/** Collect fix operations from findings, dropping duplicates and ops whose path is already touched. */
export function collectOps(findings: Finding[]): PatchOp[] {
  const seen = new Set<string>();
  const ops: PatchOp[] = [];
  for (const f of findings) {
    for (const op of f.fix ?? []) {
      if (seen.has(op.path)) continue;
      seen.add(op.path);
      ops.push(op);
    }
  }
  return ops;
}

/** Apply RFC 6902 add, remove and replace operations to a deep copy of a document. */
export function applyOps(doc: unknown, ops: PatchOp[]): unknown {
  const copy = structuredClone(doc);
  for (const op of ops) {
    const tokens = parse(op.path);
    const last = tokens.pop();
    if (last === undefined) throw new Error('cannot patch the document root');
    let parent: unknown = copy;
    for (const t of tokens) {
      parent = Array.isArray(parent) ? parent[Number(t)] : isObject(parent) ? parent[t] : undefined;
    }
    if (Array.isArray(parent)) {
      const i = last === '-' ? parent.length : Number(last);
      if (op.op === 'add') parent.splice(i, 0, op.value);
      else if (op.op === 'remove') parent.splice(i, 1);
      else parent[i] = op.value;
    } else if (isObject(parent)) {
      if (op.op === 'remove') delete parent[last];
      else parent[last] = op.value;
    } else {
      throw new Error(`cannot apply ${op.op} at ${op.path}: parent is not a container`);
    }
  }
  return copy;
}

/** Detect the indentation of a JSON text (the first indented line), defaulting to two spaces. */
export function detectIndent(text: string): string | number {
  const m = text.match(/^[{[]\s*\n([ \t]+)\S/);
  if (m) return m[1]!;
  return 2;
}

/** Serialise a document the way the input file was written (indent and trailing newline). */
export function serialiseLike(original: string, doc: unknown): string {
  const out = JSON.stringify(doc, null, detectIndent(original));
  return original.endsWith('\n') ? out + '\n' : out;
}
