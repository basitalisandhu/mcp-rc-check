# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `surface lock --check`: compare the generated lock byte for byte without writing;
  exit 0 for a match, 1 for a stale lock and 2 for a missing or unreadable lock.

## [0.2.0] - 2026-10-04

Tool-surface pinning and change detection, folded in from the standalone tool-surface-pin, lifted from an unpublished prototype by the same author. `scan` and `client` are unchanged: same flags, same rules, byte-identical output.

### Added

- `mcp-rc-check surface lock (--stdio | --url | --dump | --config --server) [-o mcp-surface.lock.json] [--require <tool>...]`: record a server's tool surface (every tool with its description, input and output schema and annotations, prompts, resources, resource templates, server instructions and identity) in a deterministic, versioned lock file (`lockfileVersion` 1) with one SHA-256 per entry, a tree hash per component and a surface hash. `--require` marks tools whose removal is HIGH.
- `surface verify [--lock <file>] (target) [--format table|json|sarif|hook] [--fail-on low|medium|high]`: compare a server with its lock and classify every difference into 19 change classes with fixed severities. HIGH: a changed description or input schema, a new tool not marked read-only, an annotation downgrade, a removed required tool, changed server instructions, a configured server without a lock. MEDIUM: a new read-only tool, an output schema, annotation upgrade, other field, prompt, resource or server name change. LOW: title, ordering, a removed unrequired tool, version changes, a lock without a server.
- `surface diff <tool>` (also `prompt:<name>`, `resource:<uri>`, `template:<uriTemplate>`): a unified diff of the normalised definition, lock against live.
- `surface hook`: a Claude Code `SessionStart` block with one exec-form handler per configured server; `verify --format hook` prints `continue: false` with a `stopReason` on a change at or above `--fail-on` (default HIGH) and a `systemMessage` below it. `--format claude-settings` prints a `permissions.deny` fragment for the changed tools instead.
- `surface watch-config <config>` and `surface verify-config <config>`: one lock per server declared in `.mcp.json`, `~/.claude.json`, Claude Desktop, Cursor or VS Code configurations, read with the same reader as `client`. stdio servers start with a minimal environment plus their own `env` block; `${VAR}` and `${VAR:-default}` are expanded and never printed; every request has a timeout; URLs with credentials are refused; HTTP+SSE servers are skipped.
- A `covers` field in every lock, so a lock made from a tools-only dump does not report prompts or resources as removed.
- `surface lock --dump` reads dumps written by `scan --save-dump`, and a lock from such a dump equals a lock from the live server.
- `docs/surface.md`: commands, lock file schema and hashing, what is normalised, and every change class. Six new good first issues for the surface commands.
- 108 new tests (231 in total): fixture dumps before and after each change class, a stdio fixture server with an unchanged and a changed mode, lock then verify clean, SARIF, exit codes, `watch-config` and `verify-config`, hook snippet parsing, normalisation stability, and a check that a scan dump and a live lock agree.

### Changed

- The SARIF writer is shared: `scan`, `client` and `surface verify` go through one `sarifLog` function (exported). `scan` and `client` SARIF output is unchanged byte for byte.
- `StdioTransport` takes an optional working directory, and `parseEndpoint` (exported from the live scan module) is the one place a URL is checked for scheme and credentials.
- The package version moved to `src/version.ts`; `VERSION` is still exported from the CLI module and now also from the package entry point.

### Adapted from the prototype

- One JSON-RPC client: the prototype's own stdio and HTTP transports are replaced by the ones `scan` uses, and the handshake order is `scan`'s (`server/discover` first, then `initialize`), so dump locks and live locks agree.
- Client configurations are read by `client`'s reader, which adds `projects.<path>.mcpServers` in `~/.claude.json`, Cursor configurations and `serverUrl` entries.
- Names: the default lock is `mcp-surface.lock.json`, the lock directory `.mcp-surface`, the lock `generator` is `mcp-rc-check`, and the hook runs `mcp-rc-check surface verify`. The prototype's own dump format and `lock --save-dump` were dropped in favour of `scan --save-dump`.

## [0.1.0] - 2026-10-04

First release. Published to two registries on GitHub Packages, using only the workflow's `GITHUB_TOKEN`:

- npm (`https://npm.pkg.github.com`): `@basitalisandhu/mcp-rc-check`. The package is scoped because GitHub Packages requires the owner's scope; the unscoped name `mcp-rc-check` is not published anywhere yet.
- GitHub Container Registry: `ghcr.io/basitalisandhu/mcp-rc-check`, tagged `0.1.0` and `latest`, for linux/amd64 and linux/arm64, with an SPDX SBOM, a build provenance attestation and a keyless cosign signature.

### Added

- `mcp-rc-check scan --stdio "<command>"` and `scan --url <endpoint>`: probe a live server with read-only requests. Detects the protocol era (modern, legacy or dual-era) through `server/discover` with a fallback to the `initialize` handshake, lists tools, resources, resource templates and prompts with pagination, and runs probes for unsupported-version errors, resource-not-found codes, `initialize` on a modern server, and (over HTTP) header validation, unknown-method status and the `GET` endpoint.
- `scan --dump <file>`: check a dump saved with `--save-dump`, or a plain list, `server/discover` or `initialize` result, a JSON-RPC response wrapping one, a captured client request, or a bare array of tools.
- `mcp-rc-check client --config <file>`: check Claude Code (`.mcp.json`, `~/.claude.json`), Cursor and VS Code MCP configurations for static `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`, `Mcp-Session-Id` and `Last-Event-ID` headers, the HTTP+SSE transport, and legacy version pins.
- 35 rules across version negotiation, results (`resultType`, `ttlMs`, `cacheScope`, server identity in `_meta`), capabilities, tool schemas (`x-mcp-header`, `$ref`, dialect), error codes, the Streamable HTTP transport, client capabilities and client configuration. Each cites the 2026-07-28 specification section it enforces; rules where the text leaves room are labelled advisory with the reason in `docs/rules.md`.
- `--fix` writes a unified diff for the JSON input (never edits in place) for mechanical changes: `resultType`, conservative cache hints, server identity in `_meta`, a missing root `type`, and removal of static protocol headers from client configurations.
- Output formats `table`, `json` and `sarif` (SARIF 2.1.0 with the spec section as each rule's `helpUri`); `--fail-on` sets the exit-code threshold.
- Test suite with pre-revision and post-revision dumps, one fixture per rule family, a stdio fixture server and a loopback HTTP fixture server, byte-for-byte patch checks, CI on Node 22 and 24, a container image published on version tags, and a guarded npmjs release workflow.

[Unreleased]: https://github.com/basitalisandhu/mcp-rc-check/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/basitalisandhu/mcp-rc-check/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/basitalisandhu/mcp-rc-check/releases/tag/v0.1.0
