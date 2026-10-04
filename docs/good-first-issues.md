# Good first issues

Issues the maintainer intends to open under the `good first issue` label, written out so they can be
filed in one sitting. Each is self-contained and has acceptance criteria that `npm test` can verify. Read
[CONTRIBUTING.md](../CONTRIBUTING.md) first: TypeScript strict mode, no new runtime dependencies, a fixture
for every rule, and an `advisory` reason for anything the specification states only as a SHOULD.

## 1. Add `--format markdown`

**Context.** A pull-request comment or a CI job summary reads better as Markdown than as the table.

**Acceptance criteria.**

- `--format markdown` prints a heading with the target and era, then a table with severity, rule id
  (linked to its spec section), subject and message, then the summary line.
- `--format` accepts `markdown` for `scan`, `client` and `rules`, and the usage text lists it.
- Tests in `test/sarif.test.ts` (or a new `test/markdown.test.ts`) assert the heading, one row and a
  link for the pre-revision fixture.

## 2. Check `ttlMs` on every page, not only the first listing

**Context.** `cache-hints-missing` already checks every page in `lists`, but `toolsRepeat` (the second
`tools/list`) is not in `view.results`, so a server that only sometimes omits `ttlMs` can pass.

**Acceptance criteria.**

- `toolsRepeat` is checked by `cache-hints-missing` and `result-type-missing` without a fix (its pointer is
  `/toolsRepeat/result`, which the autofix must not touch because the first page carries the fix).
- A fixture whose second listing lacks `ttlMs` produces one finding at `/toolsRepeat/result`.

## 3. Flag `includeContext` values in captured sampling requests

**Context.** The revision lists `includeContext: "thisServer"` and `"allServers"` as Deprecated. A dump that
captures a server's `sampling/createMessage` request (or an `InputRequiredResult` carrying one) could show
them.

**Acceptance criteria.**

- `normalise` accepts a captured `sampling/createMessage` request and an `InputRequiredResult` with
  `inputRequests`, and a new advisory rule `sampling-include-context` (warning) points at the value.
- The rule cites `https://modelcontextprotocol.io/specification/2026-07-28/deprecated`, and docs/rules.md and
  the README table list it.
- Fixtures with `"thisServer"` (one finding) and `"none"` (no finding).

## 4. Read `.vscode/mcp.json` inputs without echoing them

**Context.** VS Code configurations can reference `${input:...}` variables in headers. The client rules
remove static headers, which is right, but the message should say when the value is an input reference so
the user knows where it comes from.

**Acceptance criteria.**

- When a flagged header value is exactly an `${input:name}` reference, the message adds
  `(value comes from input "name")`; any other value is still never echoed.
- A fixture `fixture-vscode-inputs-config.json` and a test asserting both cases.

## 5. Add a `--only <family>` filter

**Context.** Teams migrate one area at a time, for example results first, then transport.

**Acceptance criteria.**

- `--only <family>` (repeatable) runs only rules of the named families (`version`, `results`,
  `capabilities`, `tools`, `errors`, `transport`, `client-capabilities`, `client-config`); an unknown family
  is a usage error (exit 2).
- `--only` and `--disable` combine; tests cover both and the usage text documents the flag.

## 6. Ship a composite GitHub Action

**Context.** The sibling project mcp-tools-lint ships `action/action.yml` that runs the CLI and uploads
SARIF. The same would let a repository check a committed dump on every push.

**Acceptance criteria.**

- `action/action.yml` takes `dump`, `fail-on` and `sarif-file` inputs, runs `npx` on the published package
  with `--format sarif`, and uploads the file with `github/codeql-action/upload-sarif` pinned by commit SHA.
- `files` in package.json includes `action`, and the README gains a short "GitHub Action" section.
- A CI job runs the action against `test/fixtures/fixture-post-revision.json`.
