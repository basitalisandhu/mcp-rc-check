/**
 * The Claude Code `SessionStart` hook that runs `mcp-rc-check surface verify` before each session.
 *
 * The settings shape is the documented one: an event name mapping to matcher groups, each with a
 * `hooks` list of handlers; the handler is in exec form (`command` plus `args`) so paths with spaces
 * stay one argument. `SessionStart` cannot block with exit code 2, so the verify run prints the JSON
 * field `continue: false` with a `stopReason` (exit code 0) when a change reaches the threshold, and a
 * `systemMessage` warning below it. One handler per configured server.
 */
import type { SurfaceSeverity } from './rules.js';

/** The SessionStart matcher: a new session and a resumed one. */
export const DEFAULT_MATCHER = 'startup|resume';
export const DEFAULT_HOOK_TIMEOUT = 30;

export interface SnippetOptions {
  exe: string;
  config: string;
  servers: { name: string; lock: string }[];
  failOn: SurfaceSeverity;
  timeout: number;
  matcher: string;
}

export interface HookHandler {
  type: 'command';
  command: string;
  args: string[];
  timeout: number;
  statusMessage: string;
}

export function settingsSnippet(o: SnippetOptions): { hooks: { SessionStart: { matcher?: string; hooks: HookHandler[] }[] } } {
  const words = o.exe.split(/\s+/).filter(Boolean);
  const handlers: HookHandler[] = o.servers.map((s) => ({
    type: 'command',
    command: words[0] ?? 'mcp-rc-check',
    args: [...words.slice(1), 'surface', 'verify', '--strict', '--format', 'hook', '--fail-on', o.failOn, '--config', o.config, '--server', s.name, '--lock', s.lock],
    timeout: o.timeout,
    statusMessage: `mcp-rc-check: verifying the tools of MCP server ${s.name}`,
  }));
  const group = o.matcher ? { matcher: o.matcher, hooks: handlers } : { hooks: handlers };
  return { hooks: { SessionStart: [group] } };
}
