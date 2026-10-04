import type { Exchange, ResultRef, View } from '../dump.js';
import { join } from '../pointer.js';
import { checkHeaderAnnotations, DIALECT_2020_12, externalRefs } from '../schema.js';
import {
  CACHEABLE_METHODS,
  ERROR_CODE,
  META,
  RETIRED_CODES,
  SECTION,
  TARGET_REVISION,
} from '../spec.js';
import type { Finding, PatchOp } from '../types.js';
import { has, isObject, type JsonObject } from '../util.js';
import { finding, type Rule } from './rule.js';

type ServerRule = Rule<View>;

function describeOutcome(ex: Exchange | undefined): string {
  if (!ex) return 'no response';
  if (ex.timedOut) return 'no response within the timeout';
  if (ex.transportError) return `a transport error (${ex.transportError})`;
  const status = ex.http ? `HTTP ${ex.http.status} with ` : '';
  if (ex.error) return `${status}JSON-RPC error ${ex.error.code}`;
  if (ex.result) return `${status}a result`;
  return `${status}an empty body`;
}

function retiredNote(code: number | undefined): string {
  if (code === undefined) return '';
  const note = RETIRED_CODES[code];
  return note ? ` (${code} is ${note})` : '';
}

// ---------------------------------------------------------------------------------------------
// version

const legacyOnlyServer: ServerRule = {
  id: 'legacy-only-server',
  family: 'version',
  side: 'server',
  severity: 'error',
  title: 'The server speaks only the initialize handshake and does not answer server/discover',
  change:
    'Implement server/discover and read the protocol version and client capabilities from each request\'s _meta. Keep initialize only if you also want to serve legacy clients (a dual-era server).',
  section: SECTION.discover,
  autofix: false,
  check(view) {
    if (view.era !== 'legacy') return [];
    const result = view.initialize?.exchange.result;
    const version = result && typeof result.protocolVersion === 'string' ? result.protocolVersion : 'unknown';
    const probe = view.discover ? `; server/discover returned ${describeOutcome(view.discover.exchange)}` : '';
    return [
      finding(
        this,
        'server',
        view.initialize?.ptr ?? '',
        `the server negotiated protocolVersion ${JSON.stringify(version)} through initialize${probe}. ` +
          `${TARGET_REVISION} removes the initialize handshake and requires server/discover`,
      ),
    ];
  },
};

const discoverResultShape: ServerRule = {
  id: 'discover-result-shape',
  family: 'version',
  side: 'server',
  severity: 'error',
  title: 'The server/discover result lacks supportedVersions or capabilities',
  change: 'Return supportedVersions (an array of version strings) and capabilities (an object) from server/discover.',
  section: SECTION.discover,
  autofix: false,
  check(view) {
    const result = view.discover?.exchange.result;
    if (!view.discover || !result) return [];
    const out: Finding[] = [];
    const sv = result.supportedVersions;
    if (!Array.isArray(sv) || sv.length === 0 || !sv.every((v) => typeof v === 'string')) {
      out.push(finding(this, 'server/discover', join(view.discover.ptr, 'supportedVersions'), 'supportedVersions is missing, empty or not an array of strings'));
    }
    if (!isObject(result.capabilities)) {
      out.push(finding(this, 'server/discover', join(view.discover.ptr, 'capabilities'), 'capabilities is missing or not an object'));
    }
    return out;
  },
};

const targetRevisionNotSupported: ServerRule = {
  id: 'target-revision-not-supported',
  family: 'version',
  side: 'server',
  severity: 'error',
  title: `The server is modern but does not list ${TARGET_REVISION} among its supported versions`,
  change: `Add "${TARGET_REVISION}" to supportedVersions once the server implements this revision.`,
  section: SECTION.versionNegotiation,
  autofix: false,
  check(view) {
    if (!view.discover) return [];
    const ex = view.discover.exchange;
    if (ex.error?.code === ERROR_CODE.unsupportedProtocolVersion) {
      const data = ex.error.data;
      const supported = isObject(data) && Array.isArray(data.supported) ? data.supported : [];
      return [
        finding(
          this,
          'server/discover',
          '/discover/error',
          `server/discover for ${TARGET_REVISION} returned UnsupportedProtocolVersionError; supported: ${JSON.stringify(supported)}`,
        ),
      ];
    }
    const sv = ex.result?.supportedVersions;
    if (Array.isArray(sv) && sv.length > 0 && !sv.includes(TARGET_REVISION)) {
      return [
        finding(this, 'server/discover', join(view.discover.ptr, 'supportedVersions'), `supportedVersions is ${JSON.stringify(sv)}`),
      ];
    }
    return [];
  },
};

const unsupportedVersionError: ServerRule = {
  id: 'unsupported-version-error',
  family: 'version',
  side: 'server',
  severity: 'error',
  title: 'A request for an unknown protocol version does not get UnsupportedProtocolVersionError (-32022)',
  change:
    'Reject a request whose _meta protocolVersion you do not implement with error -32022 and data.supported listing your versions (HTTP: status 400).',
  section: SECTION.versionNegotiation,
  autofix: false,
  check(view) {
    const ex = view.probes.unsupportedVersion;
    if (!ex) return [];
    const ptr = '/probes/unsupportedVersion';
    if (ex.result) {
      return [finding(this, 'server', ptr, 'server/discover with protocol version "1900-01-01" was accepted instead of rejected')];
    }
    if (!ex.error) return [finding(this, 'server', ptr, `server/discover with protocol version "1900-01-01" returned ${describeOutcome(ex)}`)];
    const out: Finding[] = [];
    if (ex.error.code !== ERROR_CODE.unsupportedProtocolVersion) {
      out.push(finding(this, 'server', join(ptr, 'error', 'code'), `the error code is ${ex.error.code}, expected -32022${retiredNote(ex.error.code)}`));
    } else {
      const data = ex.error.data;
      if (!isObject(data) || !Array.isArray(data.supported)) {
        out.push(finding(this, 'server', join(ptr, 'error', 'data'), 'the error has no data.supported array listing the supported versions'));
      }
    }
    if (ex.http && ex.http.status !== 400) {
      out.push(finding(this, 'server', join(ptr, 'http', 'status'), `the HTTP status is ${ex.http.status}, expected 400`));
    }
    return out;
  },
};

const initializeErrorNamesVersions: ServerRule = {
  id: 'initialize-error-names-versions',
  family: 'version',
  side: 'server',
  severity: 'info',
  title: 'A modern-only server rejects initialize without naming the versions it supports',
  change: 'When rejecting initialize, put the supported protocol versions in the error message or data so legacy clients can show them.',
  section: SECTION.backwardCompat,
  autofix: false,
  advisory: 'The versioning page says SHOULD: legacy clients have no fall-forward, so the message is their only diagnostic.',
  check(view) {
    const ex = view.probes.initializeOnModern;
    if (!ex?.error) return [];
    const text = `${ex.error.message} ${JSON.stringify(ex.error.data ?? '')}`;
    if (/\d{4}-\d{2}-\d{2}/.test(text)) return [];
    return [finding(this, 'server', '/probes/initializeOnModern/error', 'the error returned for initialize does not mention any protocol version')];
  },
};

// ---------------------------------------------------------------------------------------------
// results

function isInterim(result: JsonObject): boolean {
  return result.resultType === 'input_required';
}

const resultTypeMissing: ServerRule = {
  id: 'result-type-missing',
  family: 'results',
  side: 'server',
  severity: 'error',
  title: 'A result has no resultType',
  change: 'Add "resultType": "complete" to every ordinary result ("input_required" for multi round-trip interim results).',
  section: SECTION.resultType,
  autofix: true,
  check(view) {
    const out: Finding[] = [];
    for (const ref of view.results) {
      if (!has(ref.result, 'resultType')) {
        out.push(
          finding(this, subjectOf(ref), ref.ptr, `the ${ref.method} result${pageNote(ref)} has no resultType`, [
            { op: 'add', path: join(ref.ptr, 'resultType'), value: 'complete' },
          ]),
        );
      } else if (typeof ref.result.resultType !== 'string') {
        out.push(finding(this, subjectOf(ref), join(ref.ptr, 'resultType'), `the ${ref.method} result${pageNote(ref)} has a resultType that is not a string`));
      }
    }
    return out;
  },
};

function subjectOf(ref: ResultRef): string {
  return ref.method;
}

function pageNote(ref: ResultRef): string {
  return ref.page > 0 ? ` (page ${ref.page + 1})` : '';
}

const cacheHintsMissing: ServerRule = {
  id: 'cache-hints-missing',
  family: 'results',
  side: 'server',
  severity: 'error',
  title: 'A cacheable result lacks ttlMs or cacheScope, or has an invalid value',
  change:
    'Return ttlMs (an integer >= 0, in milliseconds) and cacheScope ("public" or "private") on server/discover, tools/list, prompts/list, resources/list, resources/templates/list and resources/read. The autofix writes the conservative ttlMs 0 and cacheScope "private"; choose real values.',
  section: SECTION.caching,
  autofix: true,
  check(view) {
    const out: Finding[] = [];
    for (const ref of view.results) {
      if (!(CACHEABLE_METHODS as readonly string[]).includes(ref.method) || isInterim(ref.result)) continue;
      const r = ref.result;
      const where = `the ${ref.method} result${pageNote(ref)}`;
      if (!has(r, 'ttlMs')) {
        out.push(finding(this, subjectOf(ref), ref.ptr, `${where} has no ttlMs`, [{ op: 'add', path: join(ref.ptr, 'ttlMs'), value: 0 }]));
      } else if (typeof r.ttlMs !== 'number' || !Number.isInteger(r.ttlMs) || r.ttlMs < 0) {
        out.push(
          finding(this, subjectOf(ref), join(ref.ptr, 'ttlMs'), `${where} has ttlMs ${JSON.stringify(r.ttlMs)}; it must be an integer >= 0`, [
            { op: 'replace', path: join(ref.ptr, 'ttlMs'), value: 0 },
          ]),
        );
      }
      if (!has(r, 'cacheScope')) {
        out.push(
          finding(this, subjectOf(ref), ref.ptr, `${where} has no cacheScope`, [{ op: 'add', path: join(ref.ptr, 'cacheScope'), value: 'private' }]),
        );
      } else if (r.cacheScope !== 'public' && r.cacheScope !== 'private') {
        out.push(
          finding(this, subjectOf(ref), join(ref.ptr, 'cacheScope'), `${where} has cacheScope ${JSON.stringify(r.cacheScope)}; it must be "public" or "private"`, [
            { op: 'replace', path: join(ref.ptr, 'cacheScope'), value: 'private' },
          ]),
        );
      }
    }
    return out;
  },
};

const cacheScopePagesDiffer: ServerRule = {
  id: 'cache-scope-pages-differ',
  family: 'results',
  side: 'server',
  severity: 'error',
  title: 'Pages of one list carry different cacheScope values',
  change: 'Use the same cacheScope on every page of a paginated list response.',
  section: SECTION.cachePagination,
  autofix: false,
  check(view) {
    const out: Finding[] = [];
    for (const [method, pages] of Object.entries(view.lists)) {
      const scopes = pages.map((p) => p.result.cacheScope).filter((s) => s !== undefined);
      const distinct = [...new Set(scopes.map((s) => JSON.stringify(s)))];
      if (distinct.length > 1) {
        out.push(finding(this, method, pages[0]!.ptr, `${method} pages use cacheScope values ${distinct.join(', ')}`));
      }
    }
    return out;
  },
};

const serverInfoMetaMissing: ServerRule = {
  id: 'server-info-meta-missing',
  family: 'results',
  side: 'server',
  severity: 'warning',
  title: 'A result does not identify the server in _meta',
  change: `Put {"name", "version"} under _meta["${META.serverInfo}"] in every result; initialize's serverInfo no longer exists.`,
  section: SECTION.meta,
  autofix: true,
  advisory: 'The _meta section says SHOULD, and servers may be configured not to send it.',
  check(view) {
    const out: Finding[] = [];
    const info = view.serverInfo;
    for (const ref of view.results) {
      const meta = ref.result._meta;
      if (isObject(meta) && has(meta, META.serverInfo)) continue;
      let fix: PatchOp[] | undefined;
      if (info && typeof info.name === 'string') {
        const value = { name: info.name, ...(typeof info.version === 'string' ? { version: info.version } : {}) };
        fix = isObject(meta)
          ? [{ op: 'add', path: join(ref.ptr, '_meta', META.serverInfo), value }]
          : meta === undefined
            ? [{ op: 'add', path: join(ref.ptr, '_meta'), value: { [META.serverInfo]: value } }]
            : undefined;
      }
      out.push(finding(this, subjectOf(ref), ref.ptr, `the ${ref.method} result${pageNote(ref)} has no _meta["${META.serverInfo}"]`, fix));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// capabilities

const loggingDeprecated: ServerRule = {
  id: 'logging-capability-deprecated',
  family: 'capabilities',
  side: 'server',
  severity: 'warning',
  title: 'The server declares the deprecated logging capability',
  change:
    'Plan to drop Logging: log to stderr on stdio, or use OpenTelemetry. logging/setLevel is removed; a log level now arrives per request in _meta, and without it the server must not send notifications/message for that request.',
  section: SECTION.logging,
  autofix: false,
  advisory: 'Logging is Deprecated, not removed: it keeps working during the deprecation window (earliest removal: first revision on or after 2027-07-28).',
  check(view) {
    const caps = view.capabilities;
    if (!caps || !has(caps.value, 'logging')) return [];
    return [finding(this, 'capabilities', join(caps.ptr, 'logging'), 'capabilities.logging is declared')];
  },
};

const tasksCapabilityMoved: ServerRule = {
  id: 'tasks-capability-moved',
  family: 'capabilities',
  side: 'server',
  severity: 'error',
  title: 'The server declares tasks as a core capability',
  change:
    'Tasks moved out of the core protocol into the io.modelcontextprotocol/tasks extension: advertise it under capabilities.extensions and follow the extension (tasks/get polling, tasks/update; tasks/result and tasks/list are gone).',
  section: SECTION.changelog,
  autofix: false,
  check(view) {
    const caps = view.capabilities;
    if (!caps || !has(caps.value, 'tasks')) return [];
    return [finding(this, 'capabilities', join(caps.ptr, 'tasks'), 'capabilities.tasks is declared; ServerCapabilities in this revision has no tasks member')];
  },
};

/** _meta key prefix rules, applied to extension identifiers (prefix mandatory). */
export function extensionKeyProblem(key: string): string | undefined {
  const slash = key.indexOf('/');
  if (slash <= 0) return 'has no prefix (expected reverse-DNS labels followed by "/", e.g. "com.example/feature")';
  const prefix = key.slice(0, slash);
  const name = key.slice(slash + 1);
  const label = /^[A-Za-z]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
  if (!prefix.split('.').every((l) => label.test(l))) return 'has a prefix whose labels are not letters, digits and hyphens starting with a letter';
  if (name !== '' && !/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)) return 'has a name that does not begin and end with an alphanumeric character';
  return undefined;
}

const extensionKeyFormat: ServerRule = {
  id: 'extension-key-format',
  family: 'capabilities',
  side: 'server',
  severity: 'error',
  title: 'An extension identifier in capabilities.extensions does not follow the _meta key rules',
  change: 'Name extensions with a mandatory reverse-DNS prefix, for example "com.example/feature".',
  section: SECTION.extensions,
  autofix: false,
  check(view) {
    const caps = view.capabilities;
    if (!caps || !isObject(caps.value.extensions)) return [];
    const out: Finding[] = [];
    for (const key of Object.keys(caps.value.extensions)) {
      const problem = extensionKeyProblem(key);
      if (problem) out.push(finding(this, 'capabilities', join(caps.ptr, 'extensions', key), `extension ${JSON.stringify(key)} ${problem}`));
    }
    return out;
  },
};

const notificationsNeedListen: ServerRule = {
  id: 'notifications-need-listen',
  family: 'capabilities',
  side: 'server',
  severity: 'info',
  title: 'The server advertises change notifications, which now travel on subscriptions/listen',
  change:
    'Serve list-changed and resource-update notifications on the subscriptions/listen response stream, tagged with _meta["io.modelcontextprotocol/subscriptionId"]. resources/subscribe, resources/unsubscribe and the HTTP GET stream are removed.',
  section: SECTION.subscriptions,
  autofix: false,
  advisory: 'The listChanged and subscribe capability flags remain valid; whether the server delivers notifications the new way cannot be seen from a capabilities dump.',
  check(view) {
    const caps = view.capabilities;
    if (!caps) return [];
    const flags: string[] = [];
    for (const name of ['tools', 'prompts', 'resources']) {
      const c = caps.value[name];
      if (isObject(c) && c.listChanged === true) flags.push(`${name}.listChanged`);
    }
    const res = caps.value.resources;
    if (isObject(res) && res.subscribe === true) flags.push('resources.subscribe');
    if (flags.length === 0) return [];
    return [finding(this, 'capabilities', caps.ptr, `capabilities declare ${flags.join(', ')}`)];
  },
};

// ---------------------------------------------------------------------------------------------
// tools

const inputSchemaNotObject: ServerRule = {
  id: 'input-schema-not-object',
  family: 'tools',
  side: 'server',
  severity: 'error',
  title: 'A tool inputSchema is missing, not an object, or has no root "type": "object"',
  change:
    'Give every tool an inputSchema object with "type": "object" at the root; any JSON Schema 2020-12 keyword may sit beside it. For a tool with no parameters use {"type": "object", "additionalProperties": false}.',
  section: SECTION.tool,
  autofix: true,
  check(view) {
    const out: Finding[] = [];
    for (const { name, tool, ptr } of view.tools) {
      const schema = tool.inputSchema;
      const sp = join(ptr, 'inputSchema');
      if (!isObject(schema)) {
        out.push(finding(this, name, sp, schema === undefined ? 'inputSchema is missing' : `inputSchema is ${schema === null ? 'null' : typeof schema}, not an object`));
      } else if (!has(schema, 'type')) {
        out.push(finding(this, name, sp, 'inputSchema has no root type', [{ op: 'add', path: join(sp, 'type'), value: 'object' }]));
      } else if (schema.type !== 'object') {
        out.push(finding(this, name, join(sp, 'type'), `inputSchema root type is ${JSON.stringify(schema.type)}, expected "object"`));
      }
    }
    return out;
  },
};

const schemaDialectNotDefault: ServerRule = {
  id: 'schema-dialect-not-default',
  family: 'tools',
  side: 'server',
  severity: 'info',
  title: 'A tool schema declares a JSON Schema dialect other than 2020-12',
  change:
    'Prefer JSON Schema 2020-12 (omit $schema, or set it to https://json-schema.org/draft/2020-12/schema). Clients must support 2020-12 and may reject other dialects.',
  section: SECTION.schemaDialect,
  autofix: false,
  advisory:
    'Explicit dialects are allowed: the spec says schemas MAY declare another dialect and implementations SHOULD document which they support. Only 2020-12 support is required, so another dialect can be rejected by a conforming client.',
  check(view) {
    const out: Finding[] = [];
    for (const { name, tool, ptr } of view.tools) {
      for (const field of ['inputSchema', 'outputSchema']) {
        const schema = tool[field];
        if (isObject(schema) && typeof schema.$schema === 'string' && !DIALECT_2020_12.has(schema.$schema)) {
          out.push(finding(this, name, join(ptr, field, '$schema'), `${field} declares $schema ${JSON.stringify(schema.$schema)}`));
        }
      }
    }
    return out;
  },
};

const schemaExternalRef: ServerRule = {
  id: 'schema-external-ref',
  family: 'tools',
  side: 'server',
  severity: 'warning',
  title: 'A tool schema uses a $ref that points outside the schema document',
  change: 'Inline the referenced schema under $defs and point $ref at "#/$defs/...". Implementations must not fetch network $refs by default.',
  section: SECTION.refResolution,
  autofix: false,
  check(view) {
    const out: Finding[] = [];
    for (const { name, tool, ptr } of view.tools) {
      for (const field of ['inputSchema', 'outputSchema']) {
        for (const ref of externalRefs(tool[field], join(ptr, field))) {
          out.push(
            finding(this, name, ref.ptr, `${field} has $ref ${JSON.stringify(ref.ref)}; a client will not dereference it and SHOULD reject the schema`),
          );
        }
      }
    }
    return out;
  },
};

const xMcpHeaderInvalid: ServerRule = {
  id: 'x-mcp-header-invalid',
  family: 'tools',
  side: 'server',
  severity: 'error',
  title: 'An x-mcp-header annotation breaks the transport constraints, so Streamable HTTP clients drop the tool',
  change:
    'Use a non-empty RFC 9110 token, unique case-insensitively within the schema, on an integer, string or boolean property reached only through properties keys from the root.',
  section: SECTION.xMcpHeader,
  autofix: false,
  check(view) {
    const out: Finding[] = [];
    for (const { name, tool, ptr } of view.tools) {
      for (const p of checkHeaderAnnotations(tool.inputSchema, join(ptr, 'inputSchema')).problems) {
        out.push(finding(this, name, p.ptr, `x-mcp-header ${JSON.stringify(p.header)} on ${p.property}: ${p.reason}`));
      }
    }
    return out;
  },
};

const SENSITIVE = /(pass(word|wd)?|secret|token|api[-_]?key|credential|auth|cookie|session|ssn|private[-_]?key)/i;

const xMcpHeaderSensitive: ServerRule = {
  id: 'x-mcp-header-sensitive',
  family: 'tools',
  side: 'server',
  severity: 'warning',
  title: 'An x-mcp-header annotation is on a parameter whose name suggests a secret',
  change: 'Remove x-mcp-header from passwords, keys, tokens and personal data: header values are visible to every intermediary.',
  section: SECTION.xMcpHeader,
  autofix: false,
  advisory: 'The spec says SHOULD NOT; the check matches parameter and header names only, so it can miss or over-match.',
  check(view) {
    const out: Finding[] = [];
    for (const { name, tool, ptr } of view.tools) {
      for (const a of checkHeaderAnnotations(tool.inputSchema, join(ptr, 'inputSchema')).all) {
        if (SENSITIVE.test(a.property) || SENSITIVE.test(a.header)) {
          out.push(finding(this, name, a.ptr, `x-mcp-header ${JSON.stringify(a.header)} mirrors ${a.property} into an HTTP header`));
        }
      }
    }
    return out;
  },
};

const toolExecutionField: ServerRule = {
  id: 'tool-execution-field',
  family: 'tools',
  side: 'server',
  severity: 'info',
  title: 'A tool carries the 2025-11-25 execution field (task support)',
  change: 'Tasks are now the io.modelcontextprotocol/tasks extension; follow the extension\'s definition instead of the core execution.taskSupport field.',
  section: SECTION.changelog,
  autofix: false,
  advisory:
    'The core Tool type in this revision has no execution member, but the changelog moves tasks to an extension rather than deleting them, and the extension text is outside the core specification checked here.',
  check(view) {
    return view.tools
      .filter(({ tool }) => has(tool, 'execution'))
      .map(({ name, ptr }) => finding(this, name, join(ptr, 'execution'), 'the tool has an execution field'));
  },
};

const toolsOrderUnstable: ServerRule = {
  id: 'tools-order-unstable',
  family: 'tools',
  side: 'server',
  severity: 'warning',
  title: 'Two tools/list calls returned the same tools in a different order',
  change: 'Return tools in a deterministic order, for example sorted by name, so clients and prompt caches can reuse the list.',
  section: SECTION.toolsCapabilities,
  autofix: false,
  advisory: 'The tools page says SHOULD.',
  check(view) {
    const first = view.lists['tools/list']?.[0];
    const again = view.toolsRepeat;
    if (!first || !again) return [];
    const names = (r: JsonObject): string[] =>
      Array.isArray(r.tools) ? r.tools.map((t) => (isObject(t) && typeof t.name === 'string' ? t.name : '')) : [];
    const a = names(first.result);
    const b = names(again.result);
    const sameSet = a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
    if (sameSet && a.join('\n') !== b.join('\n')) {
      return [finding(this, 'tools/list', again.ptr, 'the second tools/list returned the same tool names in a different order')];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------------------------
// errors

const resourceNotFoundCode: ServerRule = {
  id: 'resource-not-found-code',
  family: 'errors',
  side: 'server',
  severity: 'error',
  title: 'Reading a resource that does not exist does not return -32602',
  change: 'Return JSON-RPC error -32602 (Invalid Params) for an unknown resource URI; never -32002 and never an empty contents array.',
  section: SECTION.resourcesErrors,
  autofix: false,
  check(view) {
    const ex = view.probes.resourceNotFound;
    if (!ex) return [];
    const ptr = '/probes/resourceNotFound';
    if (ex.error) {
      if (ex.error.code === ERROR_CODE.invalidParams) return [];
      return [finding(this, 'resources/read', join(ptr, 'error', 'code'), `the error code is ${ex.error.code}, expected -32602${retiredNote(ex.error.code)}`)];
    }
    if (ex.result) {
      const contents = ex.result.contents;
      if (Array.isArray(contents) && contents.length === 0) {
        return [finding(this, 'resources/read', join(ptr, 'result', 'contents'), 'an unknown URI returned an empty contents array')];
      }
    }
    return [];
  },
};

// ---------------------------------------------------------------------------------------------
// transport (HTTP probes)

function expectHeaderRejection(rule: ServerRule, ex: Exchange | undefined, ptr: string, what: string): Finding[] {
  if (!ex) return [];
  if (ex.result) return [finding(rule, 'transport', ptr, `${what} was accepted (HTTP ${ex.http?.status ?? '?'}); expected 400 with error -32020`)];
  const out: Finding[] = [];
  if (ex.http && ex.http.status !== 400) out.push(finding(rule, 'transport', join(ptr, 'http', 'status'), `${what} returned HTTP ${ex.http.status}; expected 400`));
  if (ex.error && ex.error.code !== ERROR_CODE.headerMismatch) {
    out.push(finding(rule, 'transport', join(ptr, 'error', 'code'), `${what} returned error ${ex.error.code}; expected -32020 (HeaderMismatch)${retiredNote(ex.error.code)}`));
  }
  return out;
}

const httpHeaderMismatchAccepted: ServerRule = {
  id: 'http-header-mismatch-accepted',
  family: 'transport',
  side: 'server',
  severity: 'error',
  title: 'The server does not reject an MCP-Protocol-Version header that differs from the body _meta',
  change: 'Compare MCP-Protocol-Version with _meta["io.modelcontextprotocol/protocolVersion"] and reject a mismatch with HTTP 400 and error -32020.',
  section: SECTION.protocolVersionHeader,
  autofix: false,
  check(view) {
    return expectHeaderRejection(this, view.probes.headerMismatch, '/probes/headerMismatch', 'a request with MCP-Protocol-Version 2025-11-25 and a 2026-07-28 body');
  },
};

const httpMissingHeaderAccepted: ServerRule = {
  id: 'http-missing-header-accepted',
  family: 'transport',
  side: 'server',
  severity: 'error',
  title: 'The server does not reject a POST that lacks the required Mcp-Method header',
  change: 'Require Mcp-Method on every POST (and Mcp-Name on tools/call, resources/read and prompts/get); reject a missing or mismatched header with HTTP 400 and error -32020.',
  section: SECTION.serverValidation,
  autofix: false,
  check(view) {
    return expectHeaderRejection(this, view.probes.missingMethodHeader, '/probes/missingMethodHeader', 'a request without Mcp-Method');
  },
};

const httpUnknownMethodStatus: ServerRule = {
  id: 'http-unknown-method-status',
  family: 'transport',
  side: 'server',
  severity: 'error',
  title: 'An unknown method does not get HTTP 404 with error -32601',
  change: 'Answer a method you do not implement with HTTP 404 and a JSON-RPC error -32601, so clients can tell it from a legacy endpoint.',
  section: SECTION.protocolVersionHeader,
  autofix: false,
  check(view) {
    const ex = view.probes.unknownMethod;
    if (!ex) return [];
    const ptr = '/probes/unknownMethod';
    const out: Finding[] = [];
    if (ex.http && ex.http.status !== 404) out.push(finding(this, 'transport', join(ptr, 'http', 'status'), `an unknown method returned HTTP ${ex.http.status}; expected 404`));
    if (!ex.error || ex.error.code !== ERROR_CODE.methodNotFound) {
      out.push(finding(this, 'transport', ptr, `an unknown method returned ${describeOutcome(ex)}; expected JSON-RPC error -32601`));
    }
    return out;
  },
};

const httpSessionId: ServerRule = {
  id: 'http-session-id',
  family: 'transport',
  side: 'server',
  severity: 'warning',
  title: 'The server still issues Mcp-Session-Id on modern requests',
  change: 'Stop minting and echoing session IDs; protocol-level sessions are removed. Keep cross-call state in explicit handles passed as tool arguments.',
  section: SECTION.earlierHttp,
  autofix: false,
  advisory: 'The transport page says a server supporting only this revision SHOULD NOT mint or echo session IDs; a dual-era server still issues them to legacy clients after initialize.',
  check(view) {
    if (view.era === 'legacy') return [];
    const hit = view.results.find((r) => r.exchange?.http?.sessionIdHeader === true);
    return hit ? [finding(this, 'transport', join(hit.exchangePtr ?? hit.ptr, 'http', 'sessionIdHeader'), `the ${hit.method} response carried an Mcp-Session-Id header`)] : [];
  },
};

const httpGetStream: ServerRule = {
  id: 'http-get-stream',
  family: 'transport',
  side: 'server',
  severity: 'warning',
  title: 'An HTTP GET to the MCP endpoint is not answered with 405',
  change: 'Respond 405 Method Not Allowed to GET (and DELETE); the standalone GET stream is replaced by subscriptions/listen.',
  section: SECTION.earlierHttp,
  autofix: false,
  advisory: 'The transport page says SHOULD for a server that supports only this revision; a dual-era server may keep the GET stream for legacy clients.',
  check(view) {
    const get = view.probes.httpGet;
    if (!get || get.transportError || get.status === 405) return [];
    const stream = get.contentType?.includes('text/event-stream') ? ' and opened an event stream' : '';
    return [finding(this, 'transport', '/probes/httpGet/status', `GET returned HTTP ${get.status}${stream}`)];
  },
};

// ---------------------------------------------------------------------------------------------
// client capabilities captured in a dump

const clientRootsDeprecated: ServerRule = {
  id: 'client-roots-deprecated',
  family: 'client-capabilities',
  side: 'client',
  severity: 'warning',
  title: 'The client declares the deprecated roots capability',
  change: 'Plan to pass directories or files through tool parameters, resource URIs or server configuration instead of Roots. notifications/roots/list_changed is removed.',
  section: SECTION.roots,
  autofix: false,
  advisory: 'Roots is Deprecated, not removed: it keeps working during the deprecation window.',
  check(view) {
    const c = view.clientCapabilities;
    if (!c || !has(c.value, 'roots')) return [];
    return [finding(this, 'clientCapabilities', join(c.ptr, 'roots'), 'clientCapabilities.roots is declared')];
  },
};

const clientSamplingDeprecated: ServerRule = {
  id: 'client-sampling-deprecated',
  family: 'client-capabilities',
  side: 'client',
  severity: 'warning',
  title: 'The client declares the deprecated sampling capability',
  change: 'Plan to drop Sampling (servers integrate with model provider APIs directly). If kept, do not advertise sampling.context: includeContext "thisServer" and "allServers" are deprecated.',
  section: SECTION.sampling,
  autofix: false,
  advisory: 'Sampling is Deprecated, not removed: it keeps working during the deprecation window.',
  check(view) {
    const c = view.clientCapabilities;
    if (!c || !has(c.value, 'sampling')) return [];
    const s = c.value.sampling;
    const ctx = isObject(s) && has(s, 'context') ? ', including sampling.context (deprecated includeContext values)' : '';
    return [finding(this, 'clientCapabilities', join(c.ptr, 'sampling'), `clientCapabilities.sampling is declared${ctx}`)];
  },
};

const clientTasksMoved: ServerRule = {
  id: 'client-tasks-capability-moved',
  family: 'client-capabilities',
  side: 'client',
  severity: 'error',
  title: 'The client declares tasks as a core capability',
  change: 'Advertise the io.modelcontextprotocol/tasks extension under capabilities.extensions instead of a core tasks capability.',
  section: SECTION.changelog,
  autofix: false,
  check(view) {
    const c = view.clientCapabilities;
    if (!c || !has(c.value, 'tasks')) return [];
    return [finding(this, 'clientCapabilities', join(c.ptr, 'tasks'), 'clientCapabilities.tasks is declared; ClientCapabilities in this revision has no tasks member')];
  },
};

export const serverRules: ServerRule[] = [
  legacyOnlyServer,
  discoverResultShape,
  targetRevisionNotSupported,
  unsupportedVersionError,
  initializeErrorNamesVersions,
  resultTypeMissing,
  cacheHintsMissing,
  cacheScopePagesDiffer,
  serverInfoMetaMissing,
  loggingDeprecated,
  tasksCapabilityMoved,
  extensionKeyFormat,
  notificationsNeedListen,
  inputSchemaNotObject,
  schemaDialectNotDefault,
  schemaExternalRef,
  xMcpHeaderInvalid,
  xMcpHeaderSensitive,
  toolExecutionField,
  toolsOrderUnstable,
  resourceNotFoundCode,
  httpHeaderMismatchAccepted,
  httpMissingHeaderAccepted,
  httpUnknownMethodStatus,
  httpSessionId,
  httpGetStream,
  clientRootsDeprecated,
  clientSamplingDeprecated,
  clientTasksMoved,
];
