import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Exchange, RpcError } from '../dump.js';
import { isObject, type JsonObject } from '../util.js';
import { ConnectionError, type RequestOptions, type Transport } from './transport.js';

/** Environment variables passed to the server by default; anything else must be given with -e. */
const DEFAULT_ENV_KEYS =
  process.platform === 'win32'
    ? ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES']
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'TMPDIR', 'LANG'];

/** The minimal environment: a fixed list of variables copied from this process, nothing else. */
export function defaultEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith('()')) env[key] = value;
  }
  return env;
}

interface Pending {
  method: string;
  resolve: (ex: Exchange) => void;
  timer: NodeJS.Timeout;
}

export class StdioTransport implements Transport {
  readonly kind = 'stdio' as const;
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private exited: string | undefined;
  readonly stderrTail: string[] = [];

  constructor(command: string, args: string[], env: Record<string, string>, cwd?: string) {
    try {
      this.child = spawn(command, args, { env, ...(cwd !== undefined ? { cwd } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      throw new ConnectionError(`cannot start ${command}: ${(error as Error).message}`, { cause: error });
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    this.child.on('error', (error) => this.onExit(`cannot run ${command}: ${error.message}`));
    this.child.on('exit', (code, signal) => this.onExit(`server process exited (${signal ?? `code ${code}`})`));
    this.child.stdin.on('error', () => {
      // the process went away; onExit reports it
    });
  }

  private onExit(reason: string): void {
    if (this.exited) return;
    this.exited = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ method: p.method, transportError: reason });
      this.pending.delete(id);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line === '') continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes print non-protocol text; ignore it
      }
      if (!isObject(msg)) continue;
      if (typeof msg.method === 'string' && msg.id !== undefined) {
        // a server-initiated request (legacy servers may send roots/list); decline it
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      const ex: Exchange = { method: p.method };
      if (isObject(msg.result)) ex.result = msg.result;
      else if (isObject(msg.error)) ex.error = msg.error as unknown as RpcError;
      else ex.transportError = 'the response has neither result nor error';
      p.resolve(ex);
    }
  }

  private write(message: JsonObject): void {
    if (this.exited) return;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method: string, params: JsonObject | undefined, options: RequestOptions): Promise<Exchange> {
    if (this.exited) return Promise.resolve({ method, transportError: this.exited });
    const id = this.nextId++;
    return new Promise<Exchange>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ method, timedOut: true });
      }, options.timeoutMs);
      this.pending.set(id, { method, resolve, timer });
      this.write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  }

  async notify(method: string, params?: JsonObject): Promise<void> {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async close(): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 500);
    const hard = setTimeout(() => this.child.kill('SIGKILL'), 2500);
    await done;
    clearTimeout(timer);
    clearTimeout(hard);
  }
}
