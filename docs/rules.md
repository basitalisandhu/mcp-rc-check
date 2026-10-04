# Rules

This file lists every rule mcp-rc-check implements, the section of the
[2026-07-28 specification revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
it enforces, and why a rule is labelled advisory. The rules come from the revision's changelog, its
[deprecated features registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated), the
TypeScript schema (`schema/2026-07-28/schema.ts` in the specification repository), and the pages linked from
each rule. Where the text leaves room, the rule is advisory and says why; no rule asks for something the
specification does not state.

## How severity is chosen

- **error**: the revision says MUST or MUST NOT, removes the construct, or changes the shape of a type, and
  a conforming peer can reject the message.
- **warning**: the revision says SHOULD or SHOULD NOT, or the construct is Deprecated and will be removed.
  Most warnings are advisory.
- **info**: something to check by hand. The construct is allowed, or the effect depends on facts a dump
  or a configuration file cannot show.

`--fail-on` (default `error`) decides which severities make the command exit 1.

## Autofix

`--fix` writes a unified diff for the JSON file given with `--dump` or `client --config`. It never edits
the file. A fix exists only when the change is mechanical and safe to make without knowing the server:

| Rule | What the patch does |
| --- | --- |
| `result-type-missing` | adds `"resultType": "complete"` |
| `cache-hints-missing` | adds `"ttlMs": 0` and `"cacheScope": "private"`, or replaces an invalid value with them. `0` means "immediately stale" and `"private"` forbids shared caches, which is the conservative choice; pick real values afterwards. |
| `server-info-meta-missing` | copies the server name and version (from initialize's `serverInfo` or discover's `_meta`) into the result's `_meta` |
| `input-schema-not-object` | adds `"type": "object"` when the root has no `type` at all |
| `client-session-id-header`, `client-pinned-protocol-header`, `client-static-routing-header`, `client-last-event-id-header` | removes the header from the server entry |

The patch keeps the input's indentation and trailing newline. A file that was not written as
`JSON.stringify` output (for example, with keys on one line) gets re-serialised, so the diff also shows
formatting changes. A patch carries three lines of context from your file; read it before sharing it.

## What a live scan sends

`scan --stdio` and `scan --url` send only read-only requests:

1. `server/discover` with `_meta` for 2026-07-28 (a short timeout; a legacy stdio server may not answer).
2. If that returns a result or a recognised modern error (-32020, -32021, -32022): `tools/list`,
   `resources/list`, `resources/templates/list` and `prompts/list` for each declared capability, following
   `nextCursor` (at most 50 pages), then `tools/list` once more to compare order; `server/discover` with
   protocol version `1900-01-01`; `resources/read` of `mcp-rc-check://probe/does-not-exist` when resources
   are declared; on HTTP, a header-mismatch request, a request without `Mcp-Method`, an unknown method and a
   `GET`; and last, `initialize`, which tells a modern-only server from a dual-era one.
3. Otherwise the legacy handshake: `initialize` offering 2025-11-25, `notifications/initialized`, then the
   same lists without `_meta`.

No tool is called. A stdio server gets only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`, `TMPDIR`
and `LANG` from your environment plus whatever you pass with `-e`. Headers given with `-H` are sent to the
URL and never written to a dump; the dump records the program name and argument count, not the arguments,
and the URL without its query string.

## Dump format

`--save-dump` writes, and `--dump` reads, a JSON document with `"mcpRcCheckDump": 1`, `source`, `era`,
`discover`, `initialize`, `lists` (pages per method), `toolsRepeat`, `probes` and, optionally,
`clientCapabilities`. Each exchange holds the `method` and either `result`, `error`, `timedOut` or
`transportError`, plus `http.status`, `http.contentType` and `http.sessionIdHeader` (true when an
`Mcp-Session-Id` header came back; the value is not stored). `--dump` also accepts, without that wrapper,
a `tools/list` (or resources, templates, prompts) result, a `server/discover` or `initialize` result, a
JSON-RPC response wrapping one of those, a captured client request (its capabilities are checked), a bare
array of tools, or an array of any of these.

## What is not checked, and why

- **Authorization changes** (validating `iss` per RFC 9207, `application_type` in Dynamic Client
  Registration, credentials keyed by issuer, Client ID Metadata Documents preferred over the now Deprecated
  DCR). These happen inside the client's OAuth code and the authorization server, not in a capabilities dump
  or an `mcp.json` file. Check the server side with
  [mcp-auth-doctor](https://github.com/basitalisandhu/mcp-auth-doctor).
- **Multi round-trip requests** (`InputRequiredResult` replacing server-initiated `sampling/createMessage`,
  `elicitation/create` and `roots/list`; the removal of `elicitationId` and
  `notifications/elicitation/complete`). These appear only while a tool is called, and mcp-rc-check never
  calls a tool.
- **Removed methods** (`ping`, `logging/setLevel`, `resources/subscribe`, `resources/unsubscribe`, the
  `tasks/*` core methods). A server may keep answering them for legacy clients, so their presence is not a
  finding; `notifications-need-listen` and `logging-capability-deprecated` point at the replacements.
- **Stream resumability** (`Last-Event-ID`) on the server side, and per-request `notifications/message`
  gating. Both need a long-running or logging request to observe.
- **Tool annotations, titles and names.** The revision does not change them; use
  [mcp-tools-lint](https://github.com/basitalisandhu/mcp-tools-lint) for those.
- **`x-mcp-header` on a property with no `type`.** The constraint is on primitive types, and an untyped
  property cannot be judged from the schema, so it is not flagged.
- **Deterministic order across pages or over time.** `tools-order-unstable` compares two consecutive
  first pages only.

## Version negotiation and discovery

### `legacy-only-server`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- Detects: The server speaks only the initialize handshake and does not answer server/discover.
- Change: Implement server/discover and read the protocol version and client capabilities from each request's _meta. Keep initialize only if you also want to serve legacy clients (a dual-era server).

### `discover-result-shape`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- Detects: The server/discover result lacks supportedVersions or capabilities.
- Change: Return supportedVersions (an array of version strings) and capabilities (an object) from server/discover.

### `target-revision-not-supported`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#protocol-version-negotiation
- Detects: The server is modern but does not list 2026-07-28 among its supported versions.
- Change: Add "2026-07-28" to supportedVersions once the server implements this revision.

### `unsupported-version-error`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#protocol-version-negotiation
- Detects: A request for an unknown protocol version does not get UnsupportedProtocolVersionError (-32022).
- Change: Reject a request whose _meta protocolVersion you do not implement with error -32022 and data.supported listing your versions (HTTP: status 400).

### `initialize-error-names-versions`

- Side: server. Severity: info. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions
- Detects: A modern-only server rejects initialize without naming the versions it supports.
- Change: When rejecting initialize, put the supported protocol versions in the error message or data so legacy clients can show them.
- Why advisory: The versioning page says SHOULD: legacy clients have no fall-forward, so the message is their only diagnostic.

## Results: resultType, caching, server identity

### `result-type-missing`

- Side: server. Severity: error. Autofix: yes.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/index#resulttype
- Detects: A result has no resultType.
- Change: Add "resultType": "complete" to every ordinary result ("input_required" for multi round-trip interim results).

### `cache-hints-missing`

- Side: server. Severity: error. Autofix: yes.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#cacheable-results
- Detects: A cacheable result lacks ttlMs or cacheScope, or has an invalid value.
- Change: Return ttlMs (an integer >= 0, in milliseconds) and cacheScope ("public" or "private") on server/discover, tools/list, prompts/list, resources/list, resources/templates/list and resources/read. The autofix writes the conservative ttlMs 0 and cacheScope "private"; choose real values.

### `cache-scope-pages-differ`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#interaction-with-pagination
- Detects: Pages of one list carry different cacheScope values.
- Change: Use the same cacheScope on every page of a paginated list response.

### `server-info-meta-missing`

- Side: server. Severity: warning. Autofix: yes. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta
- Detects: A result does not identify the server in _meta.
- Change: Put {"name", "version"} under _meta["io.modelcontextprotocol/serverInfo"] in every result; initialize's serverInfo no longer exists.
- Why advisory: The _meta section says SHOULD, and servers may be configured not to send it.

## Server capabilities

### `logging-capability-deprecated`

- Side: server. Severity: warning. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/logging
- Detects: The server declares the deprecated logging capability.
- Change: Plan to drop Logging: log to stderr on stdio, or use OpenTelemetry. logging/setLevel is removed; a log level now arrives per request in _meta, and without it the server must not send notifications/message for that request.
- Why advisory: Logging is Deprecated, not removed: it keeps working during the deprecation window (earliest removal: first revision on or after 2027-07-28).

### `tasks-capability-moved`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Detects: The server declares tasks as a core capability.
- Change: Tasks moved out of the core protocol into the io.modelcontextprotocol/tasks extension: advertise it under capabilities.extensions and follow the extension (tasks/get polling, tasks/update; tasks/result and tasks/list are gone).

### `extension-key-format`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#extension-negotiation
- Detects: An extension identifier in capabilities.extensions does not follow the _meta key rules.
- Change: Name extensions with a mandatory reverse-DNS prefix, for example "com.example/feature".

### `notifications-need-listen`

- Side: server. Severity: info. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions
- Detects: The server advertises change notifications, which now travel on subscriptions/listen.
- Change: Serve list-changed and resource-update notifications on the subscriptions/listen response stream, tagged with _meta["io.modelcontextprotocol/subscriptionId"]. resources/subscribe, resources/unsubscribe and the HTTP GET stream are removed.
- Why advisory: The listChanged and subscribe capability flags remain valid; whether the server delivers notifications the new way cannot be seen from a capabilities dump.

## Tool definitions and JSON Schema

### `input-schema-not-object`

- Side: server. Severity: error. Autofix: yes.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool
- Detects: A tool inputSchema is missing, not an object, or has no root "type": "object".
- Change: Give every tool an inputSchema object with "type": "object" at the root; any JSON Schema 2020-12 keyword may sit beside it. For a tool with no parameters use {"type": "object", "additionalProperties": false}.

### `schema-dialect-not-default`

- Side: server. Severity: info. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/index#schema-dialect
- Detects: A tool schema declares a JSON Schema dialect other than 2020-12.
- Change: Prefer JSON Schema 2020-12 (omit $schema, or set it to https://json-schema.org/draft/2020-12/schema). Clients must support 2020-12 and may reject other dialects.
- Why advisory: Explicit dialects are allowed: the spec says schemas MAY declare another dialect and implementations SHOULD document which they support. Only 2020-12 support is required, so another dialect can be rejected by a conforming client.

### `schema-external-ref`

- Side: server. Severity: warning. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/index#ref-resolution
- Detects: A tool schema uses a $ref that points outside the schema document.
- Change: Inline the referenced schema under $defs and point $ref at "#/$defs/...". Implementations must not fetch network $refs by default.

### `x-mcp-header-invalid`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/server/tools#x-mcp-header
- Detects: An x-mcp-header annotation breaks the transport constraints, so Streamable HTTP clients drop the tool.
- Change: Use a non-empty RFC 9110 token, unique case-insensitively within the schema, on an integer, string or boolean property reached only through properties keys from the root.

### `x-mcp-header-sensitive`

- Side: server. Severity: warning. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/server/tools#x-mcp-header
- Detects: An x-mcp-header annotation is on a parameter whose name suggests a secret.
- Change: Remove x-mcp-header from passwords, keys, tokens and personal data: header values are visible to every intermediary.
- Why advisory: The spec says SHOULD NOT; the check matches parameter and header names only, so it can miss or over-match.

### `tool-execution-field`

- Side: server. Severity: info. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Detects: A tool carries the 2025-11-25 execution field (task support).
- Change: Tasks are now the io.modelcontextprotocol/tasks extension; follow the extension's definition instead of the core execution.taskSupport field.
- Why advisory: The core Tool type in this revision has no execution member, but the changelog moves tasks to an extension rather than deleting them, and the extension text is outside the core specification checked here.

### `tools-order-unstable`

- Side: server. Severity: warning. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/server/tools#capabilities
- Detects: Two tools/list calls returned the same tools in a different order.
- Change: Return tools in a deterministic order, for example sorted by name, so clients and prompt caches can reuse the list.
- Why advisory: The tools page says SHOULD.

## Error codes

### `resource-not-found-code`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/server/resources#error-handling
- Detects: Reading a resource that does not exist does not return -32602.
- Change: Return JSON-RPC error -32602 (Invalid Params) for an unknown resource URI; never -32002 and never an empty contents array.

## Streamable HTTP transport (live --url scans only)

### `http-header-mismatch-accepted`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header
- Detects: The server does not reject an MCP-Protocol-Version header that differs from the body _meta.
- Change: Compare MCP-Protocol-Version with _meta["io.modelcontextprotocol/protocolVersion"] and reject a mismatch with HTTP 400 and error -32020.

### `http-missing-header-accepted`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation
- Detects: The server does not reject a POST that lacks the required Mcp-Method header.
- Change: Require Mcp-Method on every POST (and Mcp-Name on tools/call, resources/read and prompts/get); reject a missing or mismatched header with HTTP 400 and error -32020.

### `http-unknown-method-status`

- Side: server. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header
- Detects: An unknown method does not get HTTP 404 with error -32601.
- Change: Answer a method you do not implement with HTTP 404 and a JSON-RPC error -32601, so clients can tell it from a legacy endpoint.

### `http-session-id`

- Side: server. Severity: warning. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions
- Detects: The server still issues Mcp-Session-Id on modern requests.
- Change: Stop minting and echoing session IDs; protocol-level sessions are removed. Keep cross-call state in explicit handles passed as tool arguments.
- Why advisory: The transport page says a server supporting only this revision SHOULD NOT mint or echo session IDs; a dual-era server still issues them to legacy clients after initialize.

### `http-get-stream`

- Side: server. Severity: warning. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions
- Detects: An HTTP GET to the MCP endpoint is not answered with 405.
- Change: Respond 405 Method Not Allowed to GET (and DELETE); the standalone GET stream is replaced by subscriptions/listen.
- Why advisory: The transport page says SHOULD for a server that supports only this revision; a dual-era server may keep the GET stream for legacy clients.

## Client capabilities captured in a dump

### `client-roots-deprecated`

- Side: client. Severity: warning. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/client/roots
- Detects: The client declares the deprecated roots capability.
- Change: Plan to pass directories or files through tool parameters, resource URIs or server configuration instead of Roots. notifications/roots/list_changed is removed.
- Why advisory: Roots is Deprecated, not removed: it keeps working during the deprecation window.

### `client-sampling-deprecated`

- Side: client. Severity: warning. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/client/sampling
- Detects: The client declares the deprecated sampling capability.
- Change: Plan to drop Sampling (servers integrate with model provider APIs directly). If kept, do not advertise sampling.context: includeContext "thisServer" and "allServers" are deprecated.
- Why advisory: Sampling is Deprecated, not removed: it keeps working during the deprecation window.

### `client-tasks-capability-moved`

- Side: client. Severity: error. Autofix: no.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Detects: The client declares tasks as a core capability.
- Change: Advertise the io.modelcontextprotocol/tasks extension under capabilities.extensions instead of a core tasks capability.

## Client configuration (mcp-rc-check client)

### `client-sse-transport`

- Side: client. Severity: warning. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/deprecated
- Detects: A server entry uses the deprecated HTTP+SSE transport.
- Change: Switch the entry to Streamable HTTP ("type": "http") once the server offers it.
- Why advisory: HTTP+SSE is Deprecated (earliest removal three months after SEP-2596 reaches Final), not removed. An entry with no type whose URL path ends in /sse is reported as likely SSE from the URL alone.

### `client-session-id-header`

- Side: client. Severity: warning. Autofix: yes.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions
- Detects: A server entry sets a static Mcp-Session-Id header.
- Change: Remove the header: protocol-level sessions are removed and a server on this revision ignores it.

### `client-pinned-protocol-header`

- Side: client. Severity: error. Autofix: yes.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header
- Detects: A server entry pins MCP-Protocol-Version as a static header.
- Change: Remove the header. The client sets MCP-Protocol-Version per request to match the body _meta; a static value that differs is rejected with HTTP 400 and error -32020.

### `client-static-routing-header`

- Side: client. Severity: error. Autofix: yes.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation
- Detects: A server entry sets Mcp-Method, Mcp-Name or Mcp-Param-* as a static header.
- Change: Remove the header. These mirror each request body; a static value mismatches most requests and the server rejects them with HTTP 400 and error -32020.

### `client-last-event-id-header`

- Side: client. Severity: warning. Autofix: yes.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions
- Detects: A server entry sets a static Last-Event-ID header.
- Change: Remove the header: stream resumability is removed, and a broken stream is retried as a new request.

### `client-legacy-version-pin`

- Side: client. Severity: info. Autofix: no. Advisory.
- Section: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#protocol-version-negotiation
- Detects: A server entry passes a legacy protocol version in its arguments or environment.
- Change: Check whether the program uses the value to pin the protocol version; if so, allow 2026-07-28.
- Why advisory: What a program does with an argument or variable is not visible in the configuration; the match is on the version string only.

