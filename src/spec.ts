/**
 * The specification revision this tool checks against, and the section URLs every rule cites.
 * Sources: https://modelcontextprotocol.io/specification/2026-07-28/changelog and the pages linked below.
 */
export const TARGET_REVISION = '2026-07-28';

/** Protocol versions earlier than the target that use the initialize handshake ("legacy" era). */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** The legacy version mcp-rc-check offers when it falls back to the initialize handshake. */
export const FALLBACK_LEGACY_VERSION = '2025-11-25';

const BASE = `https://modelcontextprotocol.io/specification/${TARGET_REVISION}`;

export const SECTION = {
  changelog: `${BASE}/changelog`,
  deprecated: `${BASE}/deprecated`,
  discover: `${BASE}/server/discover`,
  versionNegotiation: `${BASE}/basic/versioning#protocol-version-negotiation`,
  backwardCompat: `${BASE}/basic/versioning#backward-compatibility-with-initialization-based-versions`,
  extensions: `${BASE}/basic/versioning#extension-negotiation`,
  resultType: `${BASE}/basic/index#resulttype`,
  errorCodes: `${BASE}/basic/index#error-codes`,
  meta: `${BASE}/basic/index#meta`,
  schemaDialect: `${BASE}/basic/index#schema-dialect`,
  refResolution: `${BASE}/basic/index#ref-resolution`,
  caching: `${BASE}/server/utilities/caching#cacheable-results`,
  cacheModel: `${BASE}/server/utilities/caching#cacheable-model`,
  cachePagination: `${BASE}/server/utilities/caching#interaction-with-pagination`,
  logging: `${BASE}/server/utilities/logging`,
  tool: `${BASE}/server/tools#tool`,
  toolsCapabilities: `${BASE}/server/tools#capabilities`,
  xMcpHeader: `${BASE}/server/tools#x-mcp-header`,
  resourcesErrors: `${BASE}/server/resources#error-handling`,
  subscriptions: `${BASE}/basic/patterns/subscriptions`,
  protocolVersionHeader: `${BASE}/basic/transports/streamable-http#protocol-version-header`,
  standardHeaders: `${BASE}/basic/transports/streamable-http#standard-request-headers`,
  customHeaders: `${BASE}/basic/transports/streamable-http#custom-headers-from-tool-parameters`,
  serverValidation: `${BASE}/basic/transports/streamable-http#server-validation`,
  earlierHttp: `${BASE}/basic/transports/streamable-http#earlier-streamable-http-revisions`,
  clientRegistration: `${BASE}/basic/authorization/client-registration#dynamic-client-registration`,
  roots: `${BASE}/client/roots`,
  sampling: `${BASE}/client/sampling`,
} as const;

/** Reserved `_meta` keys used by the target revision. */
export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;

/** Error codes defined by the target revision (basic/index#error-codes). */
export const ERROR_CODE = {
  invalidParams: -32602,
  methodNotFound: -32601,
  headerMismatch: -32020,
  missingRequiredClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const;

/** Codes the target revision says implementations MUST NOT emit, or that were renumbered. */
export const RETIRED_CODES: Record<number, string> = {
  [-32002]: 'resource not found (2025-11-25 and earlier; replaced by -32602)',
  [-32042]: 'URL elicitation required (2025-11-25 only)',
  [-32001]: 'HeaderMismatch draft number (renumbered to -32020)',
  [-32003]: 'MissingRequiredClientCapability draft number (renumbered to -32021)',
  [-32004]: 'UnsupportedProtocolVersion draft number (renumbered to -32022)',
};

/** Error codes that identify a modern server when they come back from a probe. */
export const MODERN_ERROR_CODES: readonly number[] = [
  ERROR_CODE.headerMismatch,
  ERROR_CODE.missingRequiredClientCapability,
  ERROR_CODE.unsupportedProtocolVersion,
];

/** List operations whose complete results MUST carry ttlMs and cacheScope (server/utilities/caching). */
export const CACHEABLE_METHODS = [
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
] as const;

/** Which capability gates each list method. */
export const LIST_CAPABILITY: Record<string, string> = {
  'tools/list': 'tools',
  'resources/list': 'resources',
  'resources/templates/list': 'resources',
  'prompts/list': 'prompts',
};

/** The array field each list method returns. */
export const LIST_FIELD: Record<string, string> = {
  'tools/list': 'tools',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
  'prompts/list': 'prompts',
};
