// Shared message handling for the fixture servers. Modes:
//   modern  - follows the 2026-07-28 revision
//   lax     - answers server/discover but gets many details wrong
//   dual    - modern, and also answers initialize for legacy clients
//   legacy  - 2025-11-25 server: initialize handshake only
//   silent  - legacy server that never answers a request sent before initialize
// No network access, no filesystem access, no randomness.

export const REVISION = '2026-07-28';
const SERVER_INFO = { name: 'fixture-server', version: '1.0.0' };
const META_PV = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';

const goodTools = [
  {
    name: 'get_weather',
    title: 'Weather',
    description: 'Get the weather for a location',
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'string', description: 'City name', 'x-mcp-header': 'Location' } },
      required: ['location'],
    },
    outputSchema: { type: 'object', properties: { temperature: { type: 'number' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_cities',
    description: 'List known cities',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

const laxTools = [
  {
    name: 'create_record',
    description: 'Create a record',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        region: { type: 'number', 'x-mcp-header': 'Region' },
        api_key: { type: 'string', 'x-mcp-header': 'Api-Key' },
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', 'x-mcp-header': 'Item Id' } } } },
      },
    },
    execution: { taskSupport: 'optional' },
  },
  {
    name: 'lookup',
    description: 'Look something up',
    inputSchema: { properties: { q: { $ref: 'https://schemas.example.invalid/q.json' } } },
  },
  { name: 'zeta', description: 'Last tool', inputSchema: { type: 'object' } },
];

const resources = [{ uri: 'fixture://readme', name: 'readme', mimeType: 'text/plain' }];
const templates = [{ uriTemplate: 'fixture://notes/{id}', name: 'note' }];
const prompts = [{ name: 'summarise', description: 'Summarise a text' }];

function rpcError(code, message, data) {
  return { error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function complete(body, mode) {
  if (mode === 'lax') return { result: body };
  return {
    result: {
      resultType: 'complete',
      ...body,
      ttlMs: 60000,
      cacheScope: 'public',
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    },
  };
}

/** State per connection (stdio process) or per server (HTTP). */
export function newState() {
  return { initialized: false, toolsCalls: 0 };
}

function capabilities(mode) {
  if (mode === 'lax') {
    return {
      tools: { listChanged: true },
      resources: { subscribe: true },
      logging: {},
      tasks: { list: {} },
      extensions: { 'no-prefix': {}, 'com.example/ok': {} },
    };
  }
  return { tools: {}, resources: {}, prompts: {} };
}

function handleLegacy(msg, state) {
  const { method } = msg;
  if (method === 'initialize') {
    state.initialized = true;
    return {
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: true }, logging: {}, tasks: { list: {}, requests: { tools: { call: {} } } } },
        serverInfo: { name: 'fixture-legacy', version: '0.9.0' },
      },
    };
  }
  if (!state.initialized) return rpcError(-32000, 'Server not initialized');
  if (method === 'tools/list') {
    return {
      result: {
        tools: [
          {
            name: 'search',
            description: 'Search documents',
            inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { q: { type: 'string' } } },
            execution: { taskSupport: 'optional' },
          },
        ],
      },
    };
  }
  return rpcError(-32601, 'Method not found');
}

/**
 * Handle one JSON-RPC request. Returns { result } or { error }, or null for "no response".
 * `http` carries the request headers (lower-case) for HTTP; undefined on stdio.
 */
export function handle(msg, mode, state) {
  const { method, params = {} } = msg;
  if (mode === 'legacy' || mode === 'silent') {
    if (mode === 'silent' && !state.initialized && method !== 'initialize') return null;
    return handleLegacy(msg, state);
  }
  if (method === 'initialize') {
    if (mode === 'dual') {
      state.initialized = true;
      return { result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
    }
    if (mode === 'lax') return rpcError(-32601, 'Method not found');
    return rpcError(-32601, `initialize is not supported; supported protocol versions: ${REVISION}`, { supported: [REVISION] });
  }
  const meta = params._meta ?? {};
  const requested = meta[META_PV];
  if (typeof requested !== 'string' || meta[META_CAPS] === undefined) {
    return rpcError(-32602, 'Missing required _meta fields');
  }
  if (requested !== REVISION) {
    if (mode === 'lax') return rpcError(-32004, 'Unsupported protocol version');
    return rpcError(-32022, 'Unsupported protocol version', { supported: [REVISION], requested });
  }
  switch (method) {
    case 'server/discover':
      if (mode === 'lax') return { result: { supportedVersions: [REVISION], capabilities: capabilities(mode) } };
      return complete({ supportedVersions: [REVISION], capabilities: capabilities(mode) }, mode);
    case 'tools/list': {
      if (mode === 'lax') {
        state.toolsCalls += 1;
        const tools = state.toolsCalls % 2 === 0 ? [...laxTools].reverse() : laxTools;
        return { result: { tools } };
      }
      if (params.cursor === undefined) return complete({ tools: [goodTools[0]], nextCursor: 'page-2' }, mode);
      if (params.cursor === 'page-2') return complete({ tools: [goodTools[1]] }, mode);
      return rpcError(-32602, 'Invalid cursor');
    }
    case 'resources/list':
      return complete({ resources }, mode);
    case 'resources/templates/list':
      return complete({ resourceTemplates: templates }, mode);
    case 'prompts/list':
      return complete({ prompts }, mode);
    case 'resources/read': {
      const found = resources.find((r) => r.uri === params.uri);
      if (found) return complete({ contents: [{ uri: found.uri, mimeType: 'text/plain', text: 'fixture' }] }, mode);
      if (mode === 'lax') return rpcError(-32002, 'Resource not found');
      return rpcError(-32602, 'Resource not found', { uri: params.uri });
    }
    default:
      return rpcError(-32601, 'Method not found');
  }
}
