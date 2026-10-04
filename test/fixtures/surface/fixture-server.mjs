#!/usr/bin/env node
// A stdio MCP fixture server: newline-delimited JSON-RPC on stdin and stdout.
// Set FIXTURE_MODE=changed to serve the "after a rug pull" surface; see fixture-protocol.mjs for the other flags.
import { createInterface } from 'node:readline';
import { handle } from './fixture-protocol.mjs';

process.stdout.write('fixture server starting (not JSON, must be ignored)\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification
  if (process.env.FIXTURE_FAULT === 'server-request' && msg.method === 'tools/list') {
    // a server-initiated request the client must decline without acting on it
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' }) + '\n');
  }
  const reply = handle(msg, process.env);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n');
});
rl.on('close', () => process.exit(0));
