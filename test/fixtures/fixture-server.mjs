#!/usr/bin/env node
// A stdio MCP fixture server: newline-delimited JSON-RPC on stdin and stdout.
// Usage: node fixture-server.mjs <modern|lax|dual|legacy|silent|crash>
import { createInterface } from 'node:readline';
import { handle, newState } from './fixture-protocol.mjs';

const mode = process.argv[2] ?? 'modern';
if (mode === 'crash') {
  process.stderr.write('fixture: crashing on purpose\n');
  process.exit(3);
}
const state = newState();
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
  const reply = handle(msg, mode, state);
  if (reply === null) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n');
});
rl.on('close', () => process.exit(0));
