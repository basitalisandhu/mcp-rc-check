/** A minimal line-based unified diff (Myers' O(ND) algorithm), enough for JSON patches. */

type Edit = { kind: ' ' | '-' | '+'; line: string; a: number; b: number };

function myers(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(next);
        v = next;
        break outer;
      }
    }
    v = next;
  }
  // backtrack
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK]!;
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
  while (x > 0 && y > 0) {
    edits.push({ kind: ' ', line: a[x - 1]!, a: x - 1, b: y - 1 });
    x--;
    y--;
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
