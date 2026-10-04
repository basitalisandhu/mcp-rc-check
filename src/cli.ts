#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClientConfig, checkDump, failsAt, ruleById } from './check.js';
import { ConfigError } from './config.js';
import { unifiedDiff } from './diff.js';
import { DumpError } from './dump.js';
import { formatJson, formatRules, formatSarif, formatTable, formatMarkdown, type Format } from './format.js';
import { scanHttp, scanStdio } from './live/scan.js';
import { ConnectionError } from './live/transport.js';
import { applyOps, collectOps, serialiseLike } from './patch.js';
import type { Report, Severity } from './types.js';

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const USAGE = `Usage: mcp-rc-check <command> [options]

MCP specification migration checker for the 2026-07-28 revision: what a server or client
must change, the spec section for each finding, and a patch where the fix is mechanical.

Commands:
  scan                     Check a server, live or from a saved dump
  client --config <file>   Check a client configuration (.mcp.json, ~/.claude.json, Cursor or VS Code mcp.json)
  rules                    List the rules with their spec sections

Scan targets (exactly one):
  --stdio "<command>"      Start the server and speak to it over stdio
  --url <url>              Speak to a Streamable HTTP endpoint
  --dump <file>            Read a saved dump (from --save-dump) or a saved list/discover/initialize result

Options:
  -e, --env KEY=VALUE      Environment for a --stdio server (repeatable; only a minimal set is passed otherwise)
  -H, --header "K: V"      Header for a --url server, for example Authorization (repeatable; never saved)
  --timeout <ms>           Per-request timeout (default 10000)
  --save-dump <file>       Write what a live scan saw, to re-check later with --dump
  --fix                    Write a unified diff with the mechanical fixes (with --dump or client --config)
  --patch-file <file>      Where --fix writes the patch (default: <input>.patch; "-" for stdout)
  --format <fmt>           table (default), json, sarif, markdown
  --fail-on <severity>     Exit 1 when a finding is at or above this severity: error (default), warning, info
  --disable <rule-id>      Skip a rule (repeatable)
  -h, --help               Show this help
  -V, --version            Show the version

Exit codes: 0 no findings at or above --fail-on, 1 findings at or above --fail-on,
2 usage, connection or input error.
`;

export class UsageError extends Error {}

export interface CliOptions {
  command?: string;
  stdio?: string;
  url?: string;
  dump?: string;
  config?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  timeoutMs: number;
  saveDump?: string;
  fix: boolean;
  patchFile?: string;
  format: Format;
  failOn: Severity;
  disable: string[];
  help: boolean;
  version: boolean;
}

function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new UsageError(`${flag} needs a value`);
  return v;
}

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { env: {}, headers: {}, timeoutMs: 10_000, fix: false, format: 'table', failOn: 'error', disable: [], help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = takeValue(argv, i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help':
        o.help = true;
        break;
      case '-V':
      case '--version':
        o.version = true;
        break;
      case '--stdio':
        o.stdio = value();
        break;
      case '--url':
        o.url = value();
        break;
      case '--dump':
        o.dump = value();
        break;
      case '--config':
        o.config = value();
        break;
      case '-e':
      case '--env': {
        const kv = value();
        const k = kv.indexOf('=');
        if (k <= 0) throw new UsageError(`--env expects KEY=VALUE, got ${JSON.stringify(kv)}`);
        o.env[kv.slice(0, k)] = kv.slice(k + 1);
        break;
      }
      case '-H':
      case '--header': {
        const hv = value();
        const k = hv.indexOf(':');
        if (k <= 0) throw new UsageError('--header expects "Name: value"');
        o.headers[hv.slice(0, k).trim()] = hv.slice(k + 1).trim();
        break;
      }
      case '--timeout': {
        const n = Number(value());
        if (!Number.isInteger(n) || n <= 0) throw new UsageError('--timeout expects a positive number of milliseconds');
        o.timeoutMs = n;
        break;
      }
      case '--save-dump':
        o.saveDump = value();
        break;
      case '--fix':
        o.fix = true;
        break;
      case '--patch-file':
        o.patchFile = value();
        break;
        case '--format': {
        const f = value();
        if (f !== 'table' && f !== 'json' && f !== 'sarif' && f !== 'markdown') throw new UsageError(`--format must be table, json, sarif or markdown, got ${JSON.stringify(f)}`);
        o.format = f;
        break;
      }
      case '--fail-on': {
        const s = value();
        if (s !== 'error' && s !== 'warning' && s !== 'info') throw new UsageError(`--fail-on must be error, warning or info, got ${JSON.stringify(s)}`);
        o.failOn = s;
        break;
      }
      case '--disable': {
        const id = value();
        if (!ruleById(id)) throw new UsageError(`unknown rule id ${JSON.stringify(id)} (see mcp-rc-check rules)`);
        o.disable.push(id);
        break;
      }
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
        if (o.command === undefined) o.command = a;
        else throw new UsageError(`unexpected argument ${JSON.stringify(a)}`);
    }
  }
  return o;
}

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

function readJson(file: string, what: string): { text: string; doc: unknown } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new DumpError(`cannot read ${what} ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  try {
    return { text, doc: JSON.parse(text) };
  } catch (error) {
    throw new DumpError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

function render(report: Report, o: CliOptions, artifactUri: string): string {
  if (o.format === 'json') return formatJson(report, VERSION);
  if (o.format === 'sarif') return formatSarif(report, { toolVersion: VERSION, artifactUri });
  if (o.format === 'markdown') return formatMarkdown(report);
  return formatTable(report);
}

function relativeUri(file: string, cwd: string): string {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  return (rel.startsWith('..') ? path.resolve(cwd, file) : rel).split(path.sep).join('/');
}

/** Write the fix patch for a JSON input file. Returns a note for stderr. */
function writePatch(report: Report, input: { file: string; text: string; doc: unknown }, o: CliOptions, io: Io): string {
  const ops = collectOps(report.findings);
  const name = relativeUri(input.file, io.cwd);
  const patch = ops.length === 0 ? '' : unifiedDiff(input.text, serialiseLike(input.text, applyOps(input.doc, ops)), `a/${name}`, `b/${name}`);
  const target = o.patchFile ?? `${input.file}.patch`;
  if (target === '-') {
    io.stdout(patch);
    return '';
  }
  if (patch === '') return 'mcp-rc-check: no mechanical fixes; no patch written\n';
  writeFileSync(path.resolve(io.cwd, target), patch);
  return `mcp-rc-check: wrote ${ops.length} fix operation(s) to ${target} (apply with: git apply ${target}, or patch -p1 < ${target})\n`;
}

export async function main(argv: string[], io: Io): Promise<number> {
  let o: CliOptions;
  try {
    o = parseArgs(argv);
  } catch (error) {
    io.stderr(`mcp-rc-check: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (o.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (o.help || o.command === undefined) {
    io.stdout(USAGE);
    return o.help ? 0 : 2;
  }
  try {
    if (o.command === 'rules') {
      io.stdout(formatRules(o.format));
      return 0;
    }
    if (o.command === 'client') {
      if (!o.config) throw new UsageError('client needs --config <file>');
      const input = readJson(path.resolve(io.cwd, o.config), 'config');
      let report: Report;
      try {
        report = checkClientConfig(input.doc, o.config, { disable: o.disable });
      } catch (error) {
        if (error instanceof ConfigError) throw new DumpError(`${o.config}: ${error.message}`);
        throw error;
      }
      if (o.fix) io.stderr(writePatch(report, { file: o.config, ...input }, o, io));
      if (!(o.fix && o.patchFile === '-')) io.stdout(render(report, o, relativeUri(o.config, io.cwd)));
      return failsAt(report, o.failOn) ? 1 : 0;
    }
    if (o.command !== 'scan') throw new UsageError(`unknown command ${JSON.stringify(o.command)}`);
    const targets = [o.stdio, o.url, o.dump].filter((t) => t !== undefined).length;
    if (targets !== 1) throw new UsageError('scan needs exactly one of --stdio, --url or --dump');
    if (o.fix && !o.dump) throw new UsageError('--fix needs --dump: a live server cannot be patched; save a dump first with --save-dump');
    if (o.dump) {
      if (o.saveDump) throw new UsageError('--save-dump only applies to a live scan');
      const input = readJson(path.resolve(io.cwd, o.dump), 'dump');
      const report = checkDump(input.doc, o.dump, { disable: o.disable });
      if (o.fix) io.stderr(writePatch(report, { file: o.dump, ...input }, o, io));
      if (!(o.fix && o.patchFile === '-')) io.stdout(render(report, o, relativeUri(o.dump, io.cwd)));
      return failsAt(report, o.failOn) ? 1 : 0;
    }
    const live = { timeoutMs: o.timeoutMs, env: o.env, headers: o.headers, clientVersion: VERSION };
    const dump = o.stdio !== undefined ? await scanStdio(o.stdio, live) : await scanHttp(o.url!, live);
    if (o.saveDump) {
      writeFileSync(path.resolve(io.cwd, o.saveDump), JSON.stringify(dump, null, 2) + '\n');
      io.stderr(`mcp-rc-check: saved the dump to ${o.saveDump}\n`);
    }
    const report = checkDump(dump, dump.source.target, { disable: o.disable });
    io.stdout(render(report, o, dump.source.kind === 'http' ? dump.source.target : 'stdio'));
    return failsAt(report, o.failOn) ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`mcp-rc-check: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof ConnectionError || error instanceof DumpError) {
      io.stderr(`mcp-rc-check: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2), {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    cwd: process.cwd(),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`mcp-rc-check: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
