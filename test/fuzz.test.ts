// Seeded fuzz and scaling tests for every file the CLI reads and for the diff behind
// --fix and `surface diff`. Bad input must end in exit 2 with a message naming the file,
// never an "unexpected error" stack trace, and never take more than a few seconds.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { unifiedDiff } from '../src/diff.js';
import { FIXTURES } from './helpers.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-rc-check-fuzz-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A small seeded generator (a linear congruential one), so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

async function run(args: string[]): Promise<{ code: number; stderr: string }> {
  let stderr = '';
  const code = await main(args, { stdout: () => {}, stderr: (t) => (stderr += t), cwd: dir });
  return { code, stderr };
}

const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8')) as unknown);

const SCALARS: unknown[] = [null, true, 0, -1, 1e308, '', 'x', '\u0000', '01', [], {}, 'a'.repeat(3000)];
const KEYS = ['tools', '__proto__', 'constructor', 'result', 'mcpServers', 'servers', 'capabilities', 'lists', 'nextCursor', 'inputSchema'];

function mutate(next: () => number, value: unknown, depth = 0): unknown {
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]!;
  if (next() < 0.15 || depth > 6) return pick(SCALARS);
  if (Array.isArray(value)) {
    if (next() < 0.2) return Object.fromEntries(value.map((x, i) => [String(i), x]));
    return value.map((x) => mutate(next, x, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value)) {
      if (next() < 0.1) continue;
      out[k] = next() < 0.7 ? x : mutate(next, x, depth + 1);
    }
    if (next() < 0.2) out[pick(KEYS)] = pick(SCALARS);
    return out;
  }
  return next() < 0.3 ? pick(SCALARS) : value;
}

function commands(file: string): string[][] {
  const lock = path.join(dir, 'fuzz.lock.json');
  return [
    ['scan', '--dump', file],
    ['scan', '--dump', file, '--fix', '--patch-file', path.join(dir, 'fuzz.patch')],
    ['scan', '--dump', file, '--format', 'sarif'],
    ['client', '--config', file],
    ['client', '--config', file, '--fix', '--patch-file', path.join(dir, 'fuzz2.patch')],
    ['surface', 'lock', '--dump', file, '-o', lock],
    ['surface', 'verify', '--dump', file, '--lock', lock, '--format', 'json'],
    ['surface', 'verify', '--dump', path.join(FIXTURES, 'fixture-tools.json'), '--lock', file],
    ['surface', 'verify-config', file],
  ];
}

function expectHandled(args: string[], result: { code: number; stderr: string }): void {
  expect([0, 1, 2], `${args.join(' ')}\n${result.stderr}`).toContain(result.code);
  expect(result.stderr, args.join(' ')).not.toMatch(/unexpected error|\n\s+at /);
}

describe('fuzzed input files', () => {
  for (const block of [0, 1, 2]) {
    it(`mutated fixtures never crash a reader (block ${block})`, async () => {
      const next = rng(7281 + block);
      const file = path.join(dir, `in-${block}.json`);
      for (let i = 0; i < 60; i++) {
        const fixture = fixtures[Math.floor(next() * fixtures.length)];
        writeFileSync(file, JSON.stringify(mutate(next, fixture)));
        for (const args of commands(file)) {
          const started = Date.now();
          expectHandled(args, await run(args));
          expect(Date.now() - started, args.join(' ')).toBeLessThan(5000);
        }
      }
    });
  }

  const deepSchema =
    '{"tools":[{"name":"a","inputSchema":' + '{"properties":{"x":'.repeat(20000) + '{}' + '}}'.repeat(20000) + '}]}';
  const cases: Array<[string, Buffer, RegExp]> = [
    ['utf16.json', Buffer.from('﻿{"tools":[]}', 'utf16le'), /is UTF-16 text; save it as UTF-8/],
    ['latin1.json', Buffer.from([...Buffer.from('{"tools":[{"name":"caf'), 0xe9, ...Buffer.from('"}]}')]), /is not UTF-8 text/],
    ['deep-array.json', Buffer.from('['.repeat(100000) + ']'.repeat(100000)), /nested more than 256 levels deep/],
    ['deep-schema.json', Buffer.from(deepSchema), /nested more than 256 levels deep/],
    ['empty.json', Buffer.alloc(0), /is not valid JSON/],
  ];
  for (const [name, bytes, message] of cases) {
    it(`${name} is refused with exit 2 and the file name`, async () => {
      const file = path.join(dir, name);
      writeFileSync(file, bytes);
      for (const args of commands(file).filter((a) => a.includes(file) && a[a.indexOf(file) - 1] !== '--lock')) {
        const result = await run(args);
        expect(result.code, args.join(' ')).toBe(2);
        expect(result.stderr, args.join(' ')).toContain(name);
        expect(result.stderr, args.join(' ')).toMatch(message);
      }
    });
  }

  it('a lock file that is not UTF-8 is refused by name', async () => {
    const lock = path.join(dir, 'latin1.lock.json');
    writeFileSync(lock, Buffer.from([0x7b, 0xe9, 0x7d]));
    const result = await run(['surface', 'verify', '--dump', path.join(FIXTURES, 'fixture-tools.json'), '--lock', lock]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/latin1\.lock\.json is not UTF-8 text/);
  });

  it('a UTF-8 byte order mark is accepted and kept by the patch', async () => {
    const file = path.join(dir, 'bom.json');
    writeFileSync(file, '﻿' + readFileSync(path.join(FIXTURES, 'fixture-pre-revision.json'), 'utf8'));
    expect((await run(['scan', '--dump', file])).code).toBe(1);
    expect((await run(['surface', 'lock', '--dump', file, '-o', path.join(dir, 'bom.lock.json')])).code).toBe(0);
  });
});

/** Apply a unified diff produced by unifiedDiff to `before` (texts that end in a newline). */
function applyDiff(before: string, patch: string): string {
  if (patch === '') return before;
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const out: string[] = [];
  let ai = 0;
  for (const line of patch.split('\n').slice(2)) {
    const hunk = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(line);
    if (hunk) {
      const start = Number(hunk[2]) === 0 ? Number(hunk[1]) : Number(hunk[1]) - 1;
      while (ai < start) out.push(a[ai++]!);
    } else if (line.startsWith(' ')) out.push(a[ai++]!);
    else if (line.startsWith('-')) ai++;
    else if (line.startsWith('+')) out.push(line.slice(1));
  }
  while (ai < a.length) out.push(a[ai++]!);
  return out.length ? out.join('\n') + '\n' : '';
}

describe('unified diff', () => {
  it('applying the diff of random line edits gives the new text (2,000 cases)', () => {
    const next = rng(6902);
    for (let c = 0; c < 2000; c++) {
      const words = ['{', '}', '"a": 1,', '"b": 2', '[', ']', 'x', 'y'];
      const before = Array.from({ length: Math.floor(next() * 40) }, () => words[Math.floor(next() * words.length)]!);
      const after = before.flatMap((w) => {
        const r = next();
        if (r < 0.1) return [];
        if (r < 0.2) return [w, words[Math.floor(next() * words.length)]!];
        if (r < 0.3) return ['changed'];
        return [w];
      });
      const a = before.length ? before.join('\n') + '\n' : '';
      const b = after.length ? after.join('\n') + '\n' : '';
      expect(applyDiff(a, unifiedDiff(a, b, 'a', 'b')), `case ${c}`).toBe(b);
    }
  });

  it('a diff where every line changed is linear and still correct', () => {
    const a = Array.from({ length: 30000 }, (_, i) => `a${i}`).join('\n') + '\n';
    const b = Array.from({ length: 30000 }, (_, i) => `b${i}`).join('\n') + '\n';
    const started = Date.now();
    const patch = unifiedDiff(a, b, 'a', 'b');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(applyDiff(a, patch)).toBe(b);
  });

  it('more differences than the cap fall back to one replaced block', () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
    const changed = lines.map((l, i) => (i % 7 === 0 ? `changed ${i}` : l));
    const a = lines.join('\n') + '\n';
    const b = changed.join('\n') + '\n';
    const started = Date.now();
    const patch = unifiedDiff(a, b, 'a', 'b');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(applyDiff(a, patch)).toBe(b);
  });
});

describe('scaling', () => {
  function toolsDump(n: number): string {
    const tools = Array.from({ length: n }, (_, i) => ({
      name: `tool_${i}`,
      description: `Does thing ${i}.`,
      inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    }));
    return JSON.stringify({ tools });
  }

  it('--fix on a one-line 10,000-tool dump finishes quickly and changes one line', async () => {
    // Before 0.5.0 this re-indented the whole file and diffed every line, which took
    // 2.4 s for 1,000 tools and ran out of memory for 10,000.
    const file = path.join(dir, 'big.json');
    writeFileSync(file, toolsDump(10000));
    const started = Date.now();
    const result = await run(['scan', '--dump', file, '--fix', '--patch-file', path.join(dir, 'big.patch')]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.code).toBe(1);
    const patch = readFileSync(path.join(dir, 'big.patch'), 'utf8');
    expect(patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))).toHaveLength(1);
  });
});
