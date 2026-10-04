import type { Exchange, RpcError } from '../dump.js';
import { isObject, type JsonObject } from '../util.js';
import type { RequestOptions, Transport } from './transport.js';

const NAME_SOURCES: Record<string, string> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };

/** Plain-ASCII header values pass through; anything else uses the Base64 sentinel form. */
function headerValue(value: string): string {
  if (/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value)) return value;
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Parse Server-Sent Events from a stream until a JSON-RPC response with the given id arrives. */
async function readSse(body: ReadableStream<Uint8Array>, id: number): Promise<JsonObject | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          if (data.length > 0) {
            try {
              const msg: unknown = JSON.parse(data.join('\n'));
              if (isObject(msg) && msg.id === id && ('result' in msg || 'error' in msg)) return msg;
            } catch {
              // not JSON; ignore the event
            }
          }
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return undefined;
}

export class HttpTransport implements Transport {
  readonly kind = 'http' as const;
  private nextId = 1;
  /** Set after a legacy initialize; sent back as Mcp-Session-Id. Never written to the dump. */
  sessionId: string | undefined;
  /** Protocol version for the MCP-Protocol-Version header on requests without _meta (legacy mode). */
  legacyVersion: string | undefined;

  constructor(
    readonly url: URL,
    private readonly extraHeaders: Record<string, string>,
  ) {}

  private headersFor(method: string, params: JsonObject | undefined, overrides: Record<string, string | null> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    for (const [k, v] of Object.entries(this.extraHeaders)) h[k.toLowerCase()] = v;
    const meta = params && isObject(params._meta) ? params._meta : undefined;
    const version = meta && typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string' ? (meta['io.modelcontextprotocol/protocolVersion'] as string) : this.legacyVersion;
    if (version) h['mcp-protocol-version'] = version;
    h['mcp-method'] = method;
    const nameKey = NAME_SOURCES[method];
    if (nameKey && params && typeof params[nameKey] === 'string') h['mcp-name'] = headerValue(params[nameKey] as string);
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) delete h[k.toLowerCase()];
      else h[k.toLowerCase()] = v;
    }
    return h;
  }

  async request(method: string, params: JsonObject | undefined, options: RequestOptions): Promise<Exchange> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const ex: Exchange = { method };
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: this.headersFor(method, params, options.headers),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
        signal: controller.signal,
        redirect: 'manual',
      });
      const contentType = res.headers.get('content-type') ?? undefined;
      const session = res.headers.get('mcp-session-id');
      ex.http = { status: res.status, ...(contentType ? { contentType } : {}), ...(session !== null ? { sessionIdHeader: true } : {}) };
      if (method === 'initialize' && session !== null) this.sessionId = session;
      let msg: JsonObject | undefined;
      if (contentType?.includes('text/event-stream') && res.body) {
        msg = await readSse(res.body, id);
      } else {
        const text = await res.text();
        if (text.trim() !== '') {
          try {
            const parsed: unknown = JSON.parse(text);
            if (isObject(parsed)) msg = parsed;
          } catch {
            ex.transportError = `HTTP ${res.status} with a body that is not JSON`;
          }
        }
      }
      if (msg) {
        if (isObject(msg.result)) ex.result = msg.result;
        else if (isObject(msg.error)) ex.error = msg.error as unknown as RpcError;
        else ex.transportError ??= `HTTP ${res.status} with a body that is not a JSON-RPC response`;
      } else if (!ex.transportError) {
        ex.transportError = `HTTP ${res.status} with no JSON-RPC response`;
      }
    } catch (error) {
      if (controller.signal.aborted) ex.timedOut = true;
      else ex.transportError = (error as Error).message + ((error as { cause?: Error }).cause ? `: ${(error as { cause: Error }).cause.message}` : '');
    } finally {
      clearTimeout(timer);
    }
    return ex;
  }

  async notify(method: string, params?: JsonObject): Promise<void> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: this.headersFor(method, params),
        body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(5000),
      });
      await res.body?.cancel();
    } catch {
      // a lost notification only affects the legacy listing that follows, which reports its own errors
    }
  }

  /** GET the endpoint and report the status and content type, without reading a stream body. */
  async probeGet(timeoutMs: number): Promise<{ status: number; contentType?: string; transportError?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      for (const [k, v] of Object.entries(this.extraHeaders)) headers[k.toLowerCase()] = v;
      const res = await fetch(this.url, { method: 'GET', headers, signal: controller.signal, redirect: 'manual' });
      const contentType = res.headers.get('content-type') ?? undefined;
      controller.abort();
      return { status: res.status, ...(contentType ? { contentType } : {}) };
    } catch (error) {
      return { status: 0, transportError: (error as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const headers: Record<string, string> = { 'mcp-session-id': this.sessionId };
      for (const [k, v] of Object.entries(this.extraHeaders)) headers[k.toLowerCase()] = v;
      if (this.legacyVersion) headers['mcp-protocol-version'] = this.legacyVersion;
      const res = await fetch(this.url, { method: 'DELETE', headers, signal: AbortSignal.timeout(3000) });
      await res.body?.cancel();
    } catch {
      // best effort
    }
  }
}
