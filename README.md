# mcp-rc-check: MCP specification migration checker

**mcp-rc-check tells you what an MCP server or client must change for the 2026-07-28 specification revision: it reads the live server (stdio or HTTP) or a saved capabilities and tools dump, flags every deprecated or changed construct with the spec section, and writes the autofix patch where one is mechanical.**

[![CI](https://github.com/basitalisandhu/mcp-rc-check/actions/workflows/ci.yml/badge.svg)](https://github.com/basitalisandhu/mcp-rc-check/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-blue.svg)](package.json)

## What it does, who it is for, and why

The [2026-07-28 revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog) of the Model Context Protocol removes the `initialize` handshake and protocol-level sessions, makes servers implement `server/discover`, puts the protocol version and client capabilities in every request's `_meta`, requires `resultType` on every result and `ttlMs` and `cacheScope` on list results, adds the `Mcp-Method` and `Mcp-Name` request headers and `x-mcp-header` parameter mirroring, renumbers its error codes, moves tasks into an extension, and deprecates Roots, Sampling, Logging, Dynamic Client Registration and the HTTP+SSE transport. Reading the changelog tells you what changed; it does not tell you which of those changes your server or your client configuration trips over.

mcp-rc-check answers that. It is for people who maintain an MCP server or SDK integration, or who run MCP clients against remote servers, and want a list of concrete changes with the spec section behind each one.

- `scan --stdio "<command>"` or `scan --url <endpoint>` probes a running server with read-only requests: `server/discover` (falling back to the legacy `initialize` handshake), the tools, resources, templates and prompts lists, and a few probes for version errors, resource-not-found codes and HTTP header validation.
- `scan --dump <file>` checks a saved dump instead: one written by `--save-dump`, or a plain `tools/list`, `server/discover` or `initialize` result.
- `client --config <file>` checks a Claude Code, Cursor or VS Code MCP configuration for static headers and transports the revision breaks.
- Every finding carries a rule id, a severity, the spec section URL, what to change, and whether `--fix` can write it. `--fix` writes a unified diff for the input file; it never edits in place.

Output is `table` (default), `json`, `sarif` or `markdown`; the command exits 1 when a finding reaches `--fail-on`. TypeScript, Node 22 or newer, no runtime dependencies.

## Install

Requires Node 22 or newer.

Every release is published by `publish-github-packages.yml` in two places on GitHub Packages: the npm package `@basitalisandhu/mcp-rc-check` and the container image `ghcr.io/basitalisandhu/mcp-rc-check`. The package is not on npmjs.com yet; when it is, it will use the same scoped name.

### npm from GitHub Packages

Point the `@basitalisandhu` scope at GitHub Packages in `~/.npmrc` (GitHub's npm registry asks for a token with the `read:packages` scope even for public packages, exported as `GITHUB_TOKEN`):

```
@basitalisandhu:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npx @basitalisandhu/mcp-rc-check scan --dump tools.json     # run without installing
npm install -g @basitalisandhu/mcp-rc-check@0.1.0           # or install the mcp-rc-check command
```

### Container image

The image runs as the non-root `node` user with `/work` as the working directory; mount the files to check there:

```bash
docker run --rm -v "$PWD:/work" ghcr.io/basitalisandhu/mcp-rc-check:0.1.0 scan --dump dump.json
docker run --rm ghcr.io/basitalisandhu/mcp-rc-check:0.1.0 scan --url https://mcp.example.com/mcp
```

## Quickstart

```bash
# A local stdio server: probe it, keep what it said, and see the findings
mcp-rc-check scan --stdio "node build/server.js" --save-dump rc-dump.json

# A remote Streamable HTTP server (headers are sent, never saved)
mcp-rc-check scan --url https://mcp.example.com/mcp -H "Authorization: Bearer $TOKEN"

# Re-check a saved dump and write the mechanical fixes as a patch
mcp-rc-check scan --dump rc-dump.json --fix            # writes rc-dump.json.patch
mcp-rc-check scan --dump tools-list.json --fix --patch-file - | git apply

# A client configuration
mcp-rc-check client --config .mcp.json
mcp-rc-check client --config ~/.cursor/mcp.json --fix

# CI: SARIF for code scanning, fail on warnings too
mcp-rc-check scan --dump rc-dump.json --format sarif --fail-on warning > rc.sarif

# Every rule with its spec section
mcp-rc-check rules
```

A pre-revision server (from the test fixtures) produces findings like:

```
ERROR legacy-only-server  [server]
      the server negotiated protocolVersion "2025-11-25" through initialize; server/discover returned JSON-RPC error -32000. 2026-07-28 removes the initialize handshake and requires server/discover
      change: Implement server/discover and read the protocol version and client capabilities from each request's _meta. Keep initialize only if you also want to serve legacy clients (a dual-era server).
      spec:   https://modelcontextprotocol.io/specification/2026-07-28/server/discover
      at:     /initialize/result

ERROR cache-hints-missing  [tools/list]  (autofix)
      the tools/list result has no ttlMs
      ...
```

and `--fix` writes:

```diff
@@ -58,7 +58,16 @@
                 "taskSupport": "optional"
               }
             }
-          ]
+          ],
+          "resultType": "complete",
+          "ttlMs": 0,
+          "cacheScope": "private",
+          "_meta": {
+            "io.modelcontextprotocol/serverInfo": {
+              "name": "fixture-legacy",
+              "version": "0.9.0"
+            }
+          }
```

## When to use this

- **Is my server ready for 2026-07-28?** `scan --stdio` or `scan --url` reports the era it detected (legacy, modern or dual-era) and every rule it fails, with the section to read.
- **What exactly do I change?** Each finding names the change; `--fix` writes the mechanical part (resultType, cache hints, server identity in `_meta`, a missing root `type`) as a patch you review.
- **Will my client config break against updated servers?** `client --config` finds pinned `MCP-Protocol-Version`, static `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`, `Mcp-Session-Id` and `Last-Event-ID` headers, and SSE transports.
- **Can CI keep it from regressing?** Save a dump once, then run `scan --dump` (or a live scan of a test server) with `--format sarif` in CI.
- **Is my HTTP endpoint validating the new headers?** A live `--url` scan sends a mismatched `MCP-Protocol-Version`, a request without `Mcp-Method`, an unknown method and a `GET`, and checks the status codes and error codes the transport page requires.

## Rules

Severity follows the specification's wording: MUST and removed constructs are errors, SHOULD and Deprecated features are warnings or info. Rules marked advisory are ones where the text leaves room; [docs/rules.md](docs/rules.md) says why for each, describes what a live scan sends, and lists what is not checked (authorization flows, multi round-trip requests, anything that needs a tool call).

| Rule | Side | Severity | Fix | Spec section |
| --- | --- | --- | --- | --- |
| `legacy-only-server` | server | error |  | [server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) |
| `discover-result-shape` | server | error |  | [server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) |
| `target-revision-not-supported` | server | error |  | [basic/versioning#protocol-version-negotiation](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#protocol-version-negotiation) |
| `unsupported-version-error` | server | error |  | [basic/versioning#protocol-version-negotiation](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#protocol-version-negotiation) |
| `initialize-error-names-versions` (advisory) | server | info |  | [basic/versioning#backward-compatibility-with-initialization-based-versions](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions) |
| `result-type-missing` | server | error | yes | [basic/index#resulttype](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#resulttype) |
| `cache-hints-missing` | server | error | yes | [server/utilities/caching#cacheable-results](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#cacheable-results) |
| `cache-scope-pages-differ` | server | error |  | [server/utilities/caching#interaction-with-pagination](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#interaction-with-pagination) |
| `server-info-meta-missing` (advisory) | server | warning | yes | [basic/index#meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta) |
| `logging-capability-deprecated` (advisory) | server | warning |  | [server/utilities/logging](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/logging) |
| `tasks-capability-moved` | server | error |  | [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) |
| `extension-key-format` | server | error |  | [basic/versioning#extension-negotiation](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#extension-negotiation) |
| `notifications-need-listen` (advisory) | server | info |  | [basic/patterns/subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions) |
| `input-schema-not-object` | server | error | yes | [server/tools#tool](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool) |
| `schema-dialect-not-default` (advisory) | server | info |  | [basic/index#schema-dialect](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#schema-dialect) |
| `schema-external-ref` | server | warning |  | [basic/index#ref-resolution](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#ref-resolution) |
| `x-mcp-header-invalid` | server | error |  | [server/tools#x-mcp-header](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#x-mcp-header) |
| `x-mcp-header-sensitive` (advisory) | server | warning |  | [server/tools#x-mcp-header](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#x-mcp-header) |
| `tool-execution-field` (advisory) | server | info |  | [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) |
| `tools-order-unstable` (advisory) | server | warning |  | [server/tools#capabilities](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#capabilities) |
| `resource-not-found-code` | server | error |  | [server/resources#error-handling](https://modelcontextprotocol.io/specification/2026-07-28/server/resources#error-handling) |
| `http-header-mismatch-accepted` | server | error |  | [basic/transports/streamable-http#protocol-version-header](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header) |
| `http-missing-header-accepted` | server | error |  | [basic/transports/streamable-http#server-validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation) |
| `http-unknown-method-status` | server | error |  | [basic/transports/streamable-http#protocol-version-header](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header) |
| `http-session-id` (advisory) | server | warning |  | [basic/transports/streamable-http#earlier-streamable-http-revisions](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions) |
| `http-get-stream` (advisory) | server | warning |  | [basic/transports/streamable-http#earlier-streamable-http-revisions](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions) |
| `client-roots-deprecated` (advisory) | client | warning |  | [client/roots](https://modelcontextprotocol.io/specification/2026-07-28/client/roots) |
| `client-sampling-deprecated` (advisory) | client | warning |  | [client/sampling](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling) |
| `client-tasks-capability-moved` | client | error |  | [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) |
| `client-sse-transport` (advisory) | client | warning |  | [deprecated](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) |
| `client-session-id-header` | client | warning | yes | [basic/transports/streamable-http#earlier-streamable-http-revisions](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions) |
| `client-pinned-protocol-header` | client | error | yes | [basic/transports/streamable-http#protocol-version-header](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header) |
| `client-static-routing-header` | client | error | yes | [basic/transports/streamable-http#server-validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation) |
| `client-last-event-id-header` | client | warning | yes | [basic/transports/streamable-http#earlier-streamable-http-revisions](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions) |
| `client-legacy-version-pin` (advisory) | client | info |  | [basic/versioning#protocol-version-negotiation](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#protocol-version-negotiation) |

## Frequently asked questions

**Does a scan change anything on the server?**
No tool is called. A live scan sends list requests, `server/discover`, one `resources/read` of a URI that cannot exist, and, last, an `initialize` probe; over HTTP it also sends three malformed requests and a `GET` to check that the server rejects them. All are read-only. [docs/rules.md](docs/rules.md) lists every request.

**Does `--fix` edit my files?**
No. It writes a unified diff (by default `<input>.patch`, or stdout with `--patch-file -`) that you review and apply with `git apply` or `patch -p1`. Fixes exist only where the change is mechanical; the cache hints it writes (`ttlMs: 0`, `cacheScope: "private"`) are the conservative values, so choose real ones afterwards.

**What does a patch to a saved dump give me if the server is live?**
The dump shows the shape your server must return. If your server serves static JSON (a tools file, a fixture, a recorded response), the patch applies to it directly; otherwise read the patch as the diff your handler code has to produce.

**My server answers both `initialize` and `server/discover`. Is that allowed?**
Yes. The [versioning page](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions) calls that a dual-era server, and mcp-rc-check reports the era as `dual` without a finding.

**Why is a draft-07 `$schema` only info here when mcp-tools-lint calls it an error?**
The revision allows an explicit `$schema` and only requires implementations to support 2020-12, so a draft-07 schema is legal but may be rejected by a client. mcp-tools-lint checks what clients accept today; mcp-rc-check checks what the revision says.

**Can it check OAuth?**
Not here. The authorization changes in this revision (validating `iss`, `application_type` during registration, issuer-bound credentials, Client ID Metadata Documents) live in the client's OAuth code and the authorization server. Use [mcp-auth-doctor](https://github.com/basitalisandhu/mcp-auth-doctor) for the server side.

**Are my credentials safe?**
Headers given with `-H` are sent only to the URL you name and never written to a dump. A URL with embedded credentials is refused. A stdio server gets a minimal environment plus what you pass with `-e`. Findings never echo header values other than protocol versions. A `--fix` patch includes three lines of context from your file, so read it before sharing.

## What this is not

- **It is not a conformance test suite.** It checks the constructs this revision changed or deprecated, through read-only requests and saved dumps. It does not call tools, run multi round-trip flows, or exercise OAuth.
- **It is not an SDK or a migration tool that rewrites code.** It tells you what to change and patches JSON where the change is mechanical; your handler code is yours to update.
- **It does not invent requirements.** Where the specification text is a SHOULD, a deprecation, or leaves room, the rule is advisory and says why.

## Development

```bash
npm install
npm test            # builds, then runs vitest against fixture dumps and fixture servers
npm run typecheck
```

The tests use fixture dumps, fixture client configurations, a stdio fixture server (`test/fixtures/fixture-server.mjs`) and an HTTP fixture server on 127.0.0.1; nothing reaches the network. See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/rules.md](docs/rules.md), [docs/good-first-issues.md](docs/good-first-issues.md) and [SECURITY.md](SECURITY.md).

## Related projects

More tools by the same author: https://github.com/basitalisandhu

- [mcp-tools-lint](https://github.com/basitalisandhu/mcp-tools-lint): lint MCP tool schemas and annotations before clients reject them.
- [mcp-auth-doctor](https://github.com/basitalisandhu/mcp-auth-doctor): diagnose OAuth discovery problems on remote MCP servers.
- [mcp-egress](https://github.com/basitalisandhu/mcp-egress): record every host an MCP server contacts, per tool, and fail CI on new ones.
- [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers): MCP servers for everyday development and security checks.

## Licence

MIT, see [LICENSE](LICENSE). Copyright 2026 Muhammad Basit Ali.
