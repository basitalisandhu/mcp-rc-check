// A Streamable HTTP fixture server on 127.0.0.1 with an ephemeral port. Modes as in fixture-protocol.mjs.
// modern answers with SSE for tools/list (to exercise the SSE parser) and JSON otherwise.
import { createServer } from 'node:http';
import { handle, newState, REVISION } from './fixture-protocol.mjs';

const MODERN_CODES = new Set([-32020, -32021, -32022, -32602]);

export function startServer(mode) {
  const state = newState();
  const sessions = new Set();
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      if (mode === 'lax') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end();
        return;
      }
      res.writeHead(405).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(mode === 'legacy' ? 200 : 405).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const send = (status, payload, extra = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...extra });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }));
      };
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const h = req.headers;
      if (mode === 'legacy') {
        if (msg.method === 'initialize') {
          const reply = handle(msg, mode, { initialized: false });
          sessions.add('fixture-session');
          send(200, reply, { 'mcp-session-id': 'fixture-session' });
          return;
        }
        if (!sessions.has(h['mcp-session-id'])) {
          send(400, { error: { code: -32000, message: 'Bad Request: No valid session ID provided' } });
          return;
        }
        send(200, handle(msg, mode, { initialized: true }));
        return;
      }
      if (mode === 'modern' || mode === 'dual') {
        const bodyVersion = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
        if (msg.method !== 'initialize') {
          if (!h['mcp-method'] || h['mcp-method'] !== msg.method || !h['mcp-protocol-version'] || h['mcp-protocol-version'] !== bodyVersion) {
            send(400, { error: { code: -32020, message: 'Header mismatch' } });
            return;
          }
        }
      }
      const reply = handle(msg, mode, state);
      const extra = mode === 'lax' ? { 'mcp-session-id': 'should-not-be-here' } : {};
      if (reply.error) {
        let status = 200;
        if (mode !== 'lax') {
          if (reply.error.code === -32601) status = msg.method === 'initialize' ? 400 : 404;
          else if (MODERN_CODES.has(reply.error.code)) status = 400;
        }
        send(status, reply, extra);
        return;
      }
      if (mode === 'modern' && msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': comment line\n\n');
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply })}\n\n`);
        return;
      }
      send(200, reply, extra);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        revision: REVISION,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
