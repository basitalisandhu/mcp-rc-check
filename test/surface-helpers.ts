import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { readDump } from '../src/surface/dump.js';
import { buildLock, type Lock } from '../src/surface/lockfile.js';
import { normaliseSurface, type NormalisedSurface } from '../src/surface/normalise.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'surface');
export const CLI = path.join(ROOT, 'dist', 'cli.js');
export const SERVER = path.join(FIXTURES, 'fixture-server.mjs');

export function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function surfaceOf(name: string): NormalisedSurface {
  return normaliseSurface(readDump(fixture(name)));
}

export function lockOf(name: string, required: string[] = []): Lock {
  return buildLock(surfaceOf(name), { generatorVersion: '0.0.0-test', source: { kind: 'dump', target: name }, required });
}

export function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'mrc-surface-test-'));
}

export interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run `mcp-rc-check surface <args>` in-process with the repository root as the working directory. */
export async function runMain(args: string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await main(['surface', ...args], { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd: ROOT });
  return { stdout, stderr, code };
}

/** Spawn the built CLI as `mcp-rc-check surface <args>`, for end-to-end exit-code checks. */
export function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile('node', [CLI, 'surface', ...args], { cwd: ROOT, env }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

/** A stdio command line for the surface fixture server. */
export const SERVER_CMD = `node "${SERVER}"`;
