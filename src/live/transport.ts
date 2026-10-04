import type { Exchange } from '../dump.js';
import type { JsonObject } from '../util.js';

export interface RequestOptions {
  timeoutMs: number;
  /** HTTP only: header overrides; null removes a header the transport would otherwise send. */
  headers?: Record<string, string | null>;
}

export interface Transport {
  readonly kind: 'stdio' | 'http';
  request(method: string, params: JsonObject | undefined, options: RequestOptions): Promise<Exchange>;
  notify(method: string, params?: JsonObject): Promise<void>;
  close(): Promise<void>;
}

/** Thrown when the target cannot be reached or does not speak MCP. The CLI maps it to exit code 2. */
export class ConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConnectionError';
  }
}
