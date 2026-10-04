import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClientConfig, checkDump } from '../src/check.js';
import { main } from '../src/cli.js';
import type { Finding, Report } from '../src/types.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
export const CLI = path.join(ROOT, 'dist', 'cli.js');
export const SERVER = path.join(FIXTURES, 'fixture-server.mjs');

export function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

export function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(fixture(name), 'utf8'));
}

export function scanFixture(name: string): Report {
  return checkDump(readFixture(name), name);
}

export function clientFixture(name: string): Report {
  return checkClientConfig(readFixture(name), name);
}

export function ids(report: Report): string[] {
  return report.findings.map((f) => f.ruleId);
}

export function byRule(report: Report, id: string): Finding[] {
  return report.findings.filter((f) => f.ruleId === id);
}

export interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run the CLI in-process with the repository root as the working directory. */
export async function runMain(args: string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd: ROOT });
  return { stdout, stderr, code };
}

/** Spawn the built CLI, for end-to-end exit-code checks. */
export function runCli(args: string[]): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile('node', [CLI, ...args], { cwd: ROOT }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

/** A stdio command line for the fixture server in a given mode. */
export function serverCommand(mode: string): string {
  return `node "${SERVER}" ${mode}`;
}
