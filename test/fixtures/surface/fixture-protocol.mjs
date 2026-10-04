// Shared message handling for the fixture servers. Behaviour is set by environment variables:
//   FIXTURE_MODE=unchanged|changed   changed: a changed description, a new parameter, a new destructive tool
//   FIXTURE_PAGE_SIZE=<n>            paginate every list with n entries per page
//   FIXTURE_ERA=legacy|modern        modern: no initialize, server/discover only (2026-07-28)
//   FIXTURE_REPORT_ENV=1             add a tool whose description lists the environment variable names it received
//   FIXTURE_FAULT=<fault>            cursor-loop | no-tools-array | list-error | init-error | server-request
// No network access, no filesystem access, no randomness.

const MODERN = '2026-07-28';
const SERVER_INFO = { name: 'fixture-files', version: '1.0.0' };
const INSTRUCTIONS = 'Use read_file before write_file.';

const readFile = {
  name: 'read_file',
  title: 'Read file',
  description: 'Read a file from the workspace and return its text.',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the workspace' } }, required: ['path'] },
  annotations: { readOnlyHint: true, openWorldHint: false },
};
const searchFiles = {
  name: 'search_files',
  description: 'Search file names in the workspace.',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  outputSchema: { type: 'object', properties: { matches: { type: 'array', items: { type: 'string' } } } },
  annotations: { readOnlyHint: true, openWorldHint: false },
};
const writeFile = {
  name: 'write_file',
  description: 'Write text to a file in the workspace.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

function tools(env) {
  const list = [readFile, searchFiles, writeFile];
  if (env.FIXTURE_MODE === 'changed') {
    list[0] = {
      ...readFile,
      description: readFile.description + ' Also summarise the file.',
      inputSchema: { ...readFile.inputSchema, properties: { ...readFile.inputSchema.properties, notes: { type: 'string' } } },
    };
    list.push({
      name: 'delete_file',
      description: 'Delete a file from the workspace.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
  }
  if (env.FIXTURE_REPORT_ENV === '1') {
    list.push({ name: 'env_keys', description: Object.keys(env).sort().join(','), inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } });
  }
  return list;
}

const prompts = [{ name: 'summarise', description: 'Summarise a file', arguments: [{ name: 'path', required: true }] }];
const resources = [{ uri: 'fixture://readme', name: 'readme', mimeType: 'text/plain' }];
const templates = [{ uriTemplate: 'fixture://notes/{id}', name: 'note' }];

function page(items, field, cursor, env) {
  const size = Number(env.FIXTURE_PAGE_SIZE ?? 0);
  if (!size) return { result: { [field]: items } };
  const start = cursor === undefined ? 0 : Number(String(cursor).replace('page-', ''));
  if (!Number.isInteger(start) || start < 0 || start >= Math.max(items.length, 1)) return { error: { code: -32602, message: 'Invalid cursor' } };
  const next = start + size < items.length ? `page-${start + size}` : undefined;
  return { result: { [field]: items.slice(start, start + size), ...(next ? { nextCursor: next } : {}) } };
}

const capabilities = { tools: {}, prompts: {}, resources: {} };

/** Returns {result} or {error} for a request, or null for no reply. */
export function handle(msg, env) {
  const params = msg.params ?? {};
  const modern = env.FIXTURE_ERA === 'modern';
  const fault = env.FIXTURE_FAULT;
  if (msg.method === 'tools/list') {
    if (fault === 'cursor-loop') return { result: { tools: [readFile], nextCursor: 'again' } };
    if (fault === 'no-tools-array') return { result: { items: [] } };
    if (fault === 'list-error') return { error: { code: -32603, message: 'Internal error' } };
  }
  if (fault === 'init-error' && (msg.method === 'initialize' || msg.method === 'server/discover')) {
    return { error: { code: -32603, message: 'Internal error' } };
  }
  switch (msg.method) {
    case 'initialize':
      if (modern) return { error: { code: -32601, message: 'Method not found' } };
      return { result: { protocolVersion: '2025-11-25', capabilities, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } };
    case 'server/discover':
      if (!modern) return { error: { code: -32601, message: 'Method not found' } };
      return { result: { supportedVersions: [MODERN], capabilities, instructions: INSTRUCTIONS, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } } };
    case 'tools/list':
      return page(tools(env), 'tools', params.cursor, env);
    case 'prompts/list':
      return page(prompts, 'prompts', params.cursor, env);
    case 'resources/list':
      return page(resources, 'resources', params.cursor, env);
    case 'resources/templates/list':
      return page(templates, 'resourceTemplates', params.cursor, env);
    default:
      return { error: { code: -32601, message: 'Method not found' } };
  }
}
