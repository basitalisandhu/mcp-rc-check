/** A minimal line-based unified diff (Myers' O(ND) algorithm), enough for JSON patches. */

type Edit = { kind: ' ' | '-' | '+'; line: string; a: number; b: number };

/**
 * Above this many differences the edit script falls back to replacing the changed middle
 * block as a whole. The patch is still correct, only not minimal; without the cap a file
 * whose every line changed kept one search frontier per difference and ran out of memory.
 */
const MAX_EDIT_DISTANCE = 2000;

function myers(a: string[], b: string[]): Edit[] {
  // Lines shared at the start and the end are never part of the edit; trimming them first
  // keeps the search to the changed region, which is all of it for a typical fix.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const edits: Edit[] = [];
  for (let i = 0; i < pre; i++) edits.push({ kind: ' ', line: a[i]!, a: i, b: i });
  const middle = middleEdits(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
  for (const e of middle) edits.push({ ...e, a: e.a + pre, b: e.b + pre });
  for (let i = suf; i > 0; i--) {
    edits.push({ kind: ' ', line: a[a.length - i]!, a: a.length - i, b: b.length - i });
  }
  return edits;
}

function replaceAll(a: string[], b: string[]): Edit[] {
  return [
    ...a.map((line, i) => ({ kind: '-' as const, line, a: i, b: 0 })),
    ...b.map((line, i) => ({ kind: '+' as const, line, a: a.length, b: i })),
  ];
}

/** Myers' O(ND) diff over two line arrays with no common prefix or suffix. */
function middleEdits(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return replaceAll(a, b);
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  // trace[d] holds the frontier before step d for diagonals -d..d only, so memory grows
  // with the square of the edit distance, not with (edit distance) x (file length).
  const trace: Int32Array[] = [];
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return replaceAll(a, b);
  const at = (d: number, k: number): number => trace[d]![k + d]!;
  // backtrack
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const k = x - y;
    let prevK: number;
    if (d === 0) prevK = 0;
    else if (k === -d || (k !== d && at(d, k - 1) < at(d, k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : at(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ kind: ' ', line: a[x - 1]!, a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) edits.push({ kind: '+', line: b[y - 1]!, a: x, b: y - 1 });
      else edits.push({ kind: '-', line: a[x - 1]!, a: x - 1, b: y });
    }
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}

function splitLines(text: string): { lines: string[]; noEol: boolean } {
  if (text === '') return { lines: [], noEol: false };
  const noEol = !text.endsWith('\n');
  const lines = (noEol ? text : text.slice(0, -1)).split('\n');
  return { lines, noEol };
}

/** Produce a unified diff from `before` to `after`, or "" when they are equal. */
export function unifiedDiff(before: string, after: string, fromName: string, toName: string, context = 3): string {
  if (before === after) return '';
  const A = splitLines(before);
  const B = splitLines(after);
  const edits = myers(A.lines, B.lines);
  const out: string[] = [`--- ${fromName}`, `+++ ${toName}`];
  let i = 0;
  while (i < edits.length) {
    // find next change
    while (i < edits.length && edits[i]!.kind === ' ') i++;
    if (i >= edits.length) break;
    let start = Math.max(0, i - context);
    let end = i;
    // extend the hunk while changes are within 2*context of each other
    for (;;) {
      while (end < edits.length && edits[end]!.kind !== ' ') end++;
      let gap = end;
      while (gap < edits.length && edits[gap]!.kind === ' ') gap++;
      if (gap < edits.length && gap - end <= context * 2) {
        end = gap;
        continue;
      }
      end = Math.min(edits.length, end + context);
      break;
    }
    const hunk = edits.slice(start, end);
    const aStart = hunk.find((e) => e.kind !== '+')?.a ?? (hunk[0]!.a);
    const bStart = hunk.find((e) => e.kind !== '-')?.b ?? (hunk[0]!.b);
    const aLen = hunk.filter((e) => e.kind !== '+').length;
    const bLen = hunk.filter((e) => e.kind !== '-').length;
    out.push(`@@ -${aLen === 0 ? aStart : aStart + 1},${aLen} +${bLen === 0 ? bStart : bStart + 1},${bLen} @@`);
    for (const e of hunk) {
      out.push(e.kind + e.line);
      const lastA = e.kind !== '+' && e.a === A.lines.length - 1 && A.noEol;
      const lastB = e.kind !== '-' && e.b === B.lines.length - 1 && B.noEol;
      if ((e.kind === '-' && lastA) || (e.kind === '+' && lastB) || (e.kind === ' ' && (lastA || lastB))) {
        out.push('\\ No newline at end of file');
      }
    }
    i = end;
    start = end;
  }
  return out.join('\n') + '\n';
}
