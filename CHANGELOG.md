# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `cache-hints-missing` and `result-type-missing` now check the repeated `tools/list` result recorded as `toolsRepeat`, which the dump normaliser stores outside `view.results`. A second listing that omits `ttlMs`, `cacheScope` or `resultType` is reported at `/toolsRepeat/result`. Those findings carry no autofix: the first `tools/list` page remains the only page an autofix rewrites.

## [0.1.0] - 2026-10-04

First release. Published to two registries on GitHub Packages, using only the workflow's `GITHUB_TOKEN`:

- npm (`https://npm.pkg.github.com`): `@basitalisandhu/mcp-rc-check`. The package is scoped because GitHub Packages requires the owner's scope; the unscoped name `mcp-rc-check` is not published anywhere yet.
- GitHub Container Registry: `ghcr.io/basitalisandhu/mcp-rc-check`, tagged `0.1.0` and `latest`, for linux/amd64 and linux/arm64, with an SPDX SBOM, a build provenance attestation and a keyless cosign signature.

### Added

- `mcp-rc-check scan --stdio "<command>"` and `scan --url <endpoint>`: probe a live server with read-only requests. Detects the protocol era (modern, legacy or dual-era) through `server/discover` with a fallback to the `initialize` handshake, lists tools, resources, resource templates and prompts with pagination, and runs probes for unsupported-version errors, resource-not-found codes and HTTP header validation.
- `scan --dump <file>`: check a dump saved with `--save-dump`, or a plain `tools/list`, `server/discover` or `initialize` result.
- `mcp-rc-check client --config <file>`: check Claude Code (`.mcp.json`, `~/.claude.json`), Cursor and VS Code MCP configurations for static `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`, `Mcp-Session-Id` and `Last-Event-ID` headers, the HTTP+SSE transport, and legacy version pins.
- 35 rules across version negotiation, results (`resultType`, `ttlMs`, `cacheScope`, server identity in `_meta`), capabilities, tool schemas (`x-mcp-header`, `$ref`, dialect), error codes, the Streamable HTTP transport, client capabilities and client configuration. Each cites the 2026-07-28 specification section it enforces; rules where the text leaves room are labelled advisory with the reason in `docs/rules.md`.
- `--fix` writes a unified diff for the JSON input (never edits in place) for mechanical changes: `resultType`, conservative cache hints, server identity in `_meta`, and removal of static protocol headers from client configurations.
- Output formats `table`, `json` and `sarif` (SARIF 2.1.0 with the spec section as each rule's `helpUri`); `--fail-on` sets the exit-code threshold.
- Test suite with pre-revision and post-revision dumps, one fixture per rule family, a stdio fixture server and an HTTP fixture server on 127.0.0.1; nothing reaches the network. CI on Node 22 and 24, a container image published on version tags, and a guarded npmjs release workflow.

## Added

- `--format markdown` output for CI and pull-request summaries.

[Unreleased]: https://github.com/basitalisandhu/mcp-rc-check/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/basitalisandhu/mcp-rc-check/releases/tag/v0.1.0
