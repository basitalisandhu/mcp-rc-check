# Contributing

Thanks for considering a contribution. The project is small on purpose: read a server (live or from a
dump) or a client configuration, check it against the 2026-07-28 revision of the MCP specification, and say
what to change. The most useful contributions are rule fixes against the current specification text, new
fixture dumps from real servers (with private data removed), and documentation corrections.

## Set up

Requires Node 22 or newer.

```bash
git clone https://github.com/basitalisandhu/mcp-rc-check
cd mcp-rc-check
npm install
npm test            # builds first, then runs vitest
```

`npm run build` compiles `src/` to `dist/`; `npm run typecheck` runs the compiler without emitting. The tests
use the fixtures under `test/fixtures/`: saved dumps, client configurations, a stdio fixture server and an
HTTP fixture server bound to 127.0.0.1. Nothing reaches the network.

## Before you open a pull request

- `npm test` passes on Node 22 and 24 (CI runs both).
- Every rule cites the specification section it enforces (`section` in the rule) and quotes nothing the
  specification does not say. If the text is a SHOULD, a deprecation, or leaves room, set `advisory` to one
  sentence saying why, and regenerate the rule's entry in [docs/rules.md](docs/rules.md) and the table in the
  README (the meta test checks both).
- A new rule has a fixture that triggers it and a fixture that does not.
- A new autofix is mechanical (no guessing about the server), has a byte-for-byte expected patch under
  `test/fixtures/expected/`, and the patch applies with `git apply`.
- Fixture files are named `fixture-*.json` or `fixture-*.mjs` so that no common ignore pattern hides them,
  and contain no real hostnames, tokens or personal data (use `example.invalid`).
- Add a line under `Unreleased` in `CHANGELOG.md`.

## Style

- TypeScript strict mode, ESM, no runtime dependencies.
- No model or vendor identifiers in the repository.
- Messages say what was found and where; the rule's `change` says what to do. Never echo a header value
  other than a protocol version, and never write `-H` headers or `-e` values to a dump.
- Deterministic output: findings are sorted by severity, then rule order, then pointer, and there are no
  timestamps.

## Reporting security issues

See [SECURITY.md](SECURITY.md).
