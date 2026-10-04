# Tool-surface pinning: `mcp-rc-check surface`

`scan` tells you whether a server follows the 2026-07-28 revision. `surface` tells you whether the server you reviewed is still the server you are running. It records the tool surface of an MCP server (every tool, its description, input and output schema and annotations, the prompts, resources and resource templates, and the server instructions) in a lock file, and on every later run reports what changed, with a fixed severity for each kind of change.

This page is the reference: the commands, the lock file schema and hashing, what is normalised before comparing, and every change class.

## Why pin the surface

You review an MCP server's tools and approve them. Nothing in the MCP handshake records what you approved, so a later session uses whatever definitions the server sends then. A description can gain new text that the model reads as guidance, a parameter can be added, a destructive tool can appear, or a `readOnlyHint` that a permission rule relied on can flip. Each of these changes what a session can do without anyone looking at it again. `surface verify` compares the current surface with the approved one and reports the difference before the next session starts.

It compares definitions. It cannot see what a tool does when it runs, so a server that keeps its definitions and changes its behaviour is out of reach.

## Commands

| Command | What it does |
| --- | --- |
| `surface lock (--stdio \| --url \| --dump \| --config --server) [-o mcp-surface.lock.json] [--require <tool>...]` | Read the surface and write the lock. `--require` marks tools whose removal is HIGH; the marks survive a re-lock to the same file. |
| `surface verify [--lock <file>] (target) [--format table\|json\|sarif\|hook] [--fail-on low\|medium\|high]` | Compare the target with the lock. Exit 1 when a change reaches `--fail-on` (default `low`, so any change). |
| `surface diff <tool> [--lock <file>] (target)` | Unified diff of one normalised definition, lock against live. Also `prompt:<name>`, `resource:<uri>` and `template:<uriTemplate>`. Exit 1 when they differ. |
| `surface hook [--config .mcp.json] [--lock-dir .mcp-surface] [--fail-on high] [--exe mcp-rc-check]` | Print a Claude Code `SessionStart` hook block with one handler per server in the configuration. `--format claude-settings` prints a `permissions.deny` fragment for the changed tools instead. |
| `surface watch-config <config> [--lock-dir .mcp-surface] [--server <name>...]` | Lock every server a client configuration declares, one lock per server. |
| `surface verify-config <config> [--lock-dir .mcp-surface]` | Verify every server in a client configuration against its lock. A configured server without a lock is HIGH (`server-unlocked`). |
| `surface rules` | Print the change classes and their severities. |

Exit codes: 0 no change at or above `--fail-on`, 1 changes at or above it, 2 a usage, connection, configuration or lock file error. `verify --format hook` always exits 0 and speaks through its JSON output, because that is how a `SessionStart` hook reports.

### Targets

- `--stdio "<command>"` starts the server with a minimal environment (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`, `TMPDIR`, `LANG` on Unix) plus what you pass with `-e KEY=VALUE`.
- `--url <endpoint>` speaks Streamable HTTP. Headers given with `-H` are sent, never saved. A URL with credentials in it is refused.
- `--dump <file>` reads a saved surface: a dump written by `mcp-rc-check scan --save-dump`, a `tools/list` result (optionally with `serverInfo`, `protocolVersion`, `instructions`, `prompts`, `resources` and `resourceTemplates`), a JSON-RPC response wrapping one, an array of `tools/list` pages, or a bare array of tools.
- `--config <file> --server <name>` starts one server the way a client configuration declares it.

### Servers from a client configuration

`watch-config`, `verify-config`, `hook` and `--config --server` read the same files `mcp-rc-check client` reads: Claude Code's `.mcp.json` and `~/.claude.json` (including `projects.<path>.mcpServers`), Claude Desktop's `claude_desktop_config.json`, Cursor's `mcp.json` and VS Code's `mcp.json`. `${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env`, `cwd`, `url` and `headers`, the way Claude Code expands them; an unset variable without a default is an error that names the variable. Values are passed to the server and never printed: errors name a variable, never its value, and the server's stderr is left out of whole-configuration runs.

stdio and Streamable HTTP servers are supported; servers on the legacy HTTP+SSE transport are skipped and listed as skipped. Every request has a timeout (`--timeout`, default 15000 ms) and a stdio server is stopped when the run ends.

### The Claude Code hook

`surface hook` prints a block to merge into the `hooks` of `~/.claude/settings.json` or `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "mcp-rc-check",
            "args": ["surface", "verify", "--strict", "--format", "hook", "--fail-on", "high", "--config", "/path/to/.mcp.json", "--server", "files", "--lock", "/path/to/.mcp-surface/files.lock.json"],
            "timeout": 30,
            "statusMessage": "mcp-rc-check: verifying the tools of MCP server files"
          }
        ]
      }
    ]
  }
}
```

The handler is in exec form (`command` plus `args`), so paths with spaces stay one argument. A `SessionStart` hook cannot block with exit code 2, so `verify --format hook` prints `{"continue": false, "stopReason": "..."}` when a change reaches `--fail-on` (default `high` for the hook) and `{"systemMessage": "..."}` for changes below it; a clean run prints nothing. With `--strict`, a run that cannot verify at all (no lock, the server does not start) also stops the session. Run `surface watch-config` before installing the hook, or every session stops on `no lock`.

## Where the inputs come from

A live run sends only these requests, over the same transports `scan` uses, and follows `nextCursor` through every page of each list:

| Request | Used for |
| --- | --- |
| `server/discover` | `serverInfo` (from `_meta`), `instructions` and `capabilities` of a server on the 2026-07-28 revision; `protocolVersion` is then recorded as `2026-07-28` |
| `initialize` (protocol version `2025-11-25` offered), only when `server/discover` has no result | The same for an earlier server, with the negotiated `protocolVersion` |
| `tools/list` | Tools (when the server declares the `tools` capability) |
| `prompts/list` | Prompts (`prompts` capability) |
| `resources/list`, `resources/templates/list` | Resources and resource templates (`resources` capability; a method-not-found answer to the templates list means no templates) |

The handshake order is the one `scan` uses, so a lock made from a `scan --save-dump` dump and a lock made from the live server agree. Unlike `scan`, `surface` sends no probes: no tool is called, no prompt is fetched and no resource is read. A server-initiated request (for example `roots/list`) is answered with method-not-found.

Lists are followed until a page has no `nextCursor`. A cursor that repeats is an error (the pagination loops), as is a list that still has pages after `--max-pages` (default 100). Pages are joined in order, so `toolOrder` is the order a client would see.

## What is compared

| Part | Compared | Source |
| --- | --- | --- |
| Tool `description` | Exact text after whitespace normalisation | tools/list |
| Tool `inputSchema` | Canonical JSON | tools/list |
| Tool `outputSchema` | Canonical JSON | tools/list |
| Tool `annotations` | Effective hints for downgrades; exact values otherwise | tools/list |
| Tool `title`, `annotations.title` | Exact text after whitespace normalisation | tools/list |
| Tool `execution`, `icons`, unknown fields | Canonical JSON | tools/list |
| Tool set and order | Names added, removed; order of the common names | tools/list, all pages |
| Prompts | Canonical JSON of each entry | prompts/list |
| Resources, templates | Canonical JSON of each entry (never the contents) | resources/list, resources/templates/list |
| Server instructions | Exact text after whitespace normalisation | server/discover or initialize |
| Server identity | `serverInfo.name`; `version` and protocol version separately | server/discover or initialize |

## What is normalised

Each entry is normalised before it is hashed or compared. Statements marked **(inferred)** are design decisions where neither the MCP specification nor a client's documentation settles the question.

1. **Key order.** Every object's keys are sorted by UTF-16 code unit order. JSON object key order carries no meaning in MCP messages, and servers built on different SDK versions emit keys in different orders.
2. **Runs of ASCII whitespace in text.** `description` and `title` (on the tool, in `annotations.title`, in every JSON Schema node and on prompt arguments), `$comment` in schemas, and the server instructions have each run of space, tab, CR, LF, form feed and vertical tab replaced by one space, and are trimmed. Template literals and reformatted source code routinely change indentation and line breaks without changing the text a person or model reads. **(inferred)**
3. **The order of `required` in a JSON Schema.** A `required` array of strings is de-duplicated and sorted: it is a set in JSON Schema validation. Keywords are recognised only where JSON Schema puts them (`properties`, `patternProperties`, `$defs`, `definitions` and `dependentSchemas` map names to schemas; `items`, `additionalProperties`, `not`, `if`, `then`, `else`, `contains`, `propertyNames` and similar hold one schema; `allOf`, `anyOf`, `oneOf` and `prefixItems` hold arrays of schemas), so a property called `description` or `required` is left alone.
4. **`_meta`** on tools, prompts and resources is dropped. The specification reserves `_meta` for protocol and implementation metadata, and servers put per-response data there. **(inferred)** If a client you use shows `_meta` content to the model, this is a gap; open an issue.
5. Tools keep `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, `execution`, `icons`, and any other top-level field under `other`.

Deliberately not normalised:

- **Every non-ASCII character**, including zero-width characters, non-breaking spaces, bidirectional controls and look-alike letters. Hidden characters in a description can carry text a person does not see, so adding one is a change.
- **`enum` order, `default` values, `examples`, `$schema`.** These can change what a model sends.
- **Case.** `Read` and `read` differ.

## Coverage: the `covers` field

A lock records which parts of the surface it describes in `covers`: `tools`, `prompts`, `resources` (with templates) and `server` (identity, protocol version and instructions). A lock from a live server covers all four, because a list the server has no capability for is known to be empty; so does a lock from a `scan --save-dump` dump, which carries the handshake. A lock from a bare `tools/list` result covers `tools` only. `verify` compares only the parts that both the lock and the current surface cover, so a tools-only lock does not report every prompt as removed or added.

## Severities

- A change to anything the model reads as guidance about an existing tool (its description, or its input schema including parameter descriptions) is HIGH.
- A new tool is HIGH unless it declares `readOnlyHint: true`, in which case it is MEDIUM. Annotations are hints chosen by the server and are not proof of behaviour, so a new read-only tool is still worth a look.
- An annotation **downgrade** is HIGH: effective `readOnlyHint` true to false, or effective `destructiveHint` false to true. Effective values use the defaults in the MCP specification (`readOnlyHint` false, `destructiveHint` true, `idempotentHint` false, `openWorldHint` true), so removing all annotations from a read-only tool is a downgrade.
- An annotation **upgrade**, for example `readOnlyHint` false to true, is MEDIUM, not LOW: permission rules generated from annotations may now auto-allow a tool that was previously asked about. **(inferred)**
- Server instructions are HIGH because clients pass them to the model like tool descriptions. **(inferred)**
- A removed tool is LOW because removal cannot widen what a session can do, unless the lock marks it required (`surface lock --require`), which makes it HIGH.
- Output schema, prompts and resources are MEDIUM: their text can reach the model, but only through a tool result or a user's choice.
- Titles are LOW because they are display names for people. **(inferred)** A client that shows the title to the model would make a title change a description change in effect.
- Tool order and a different server version or protocol version alone are LOW and informational.

In SARIF, HIGH is `error` (security-severity 8.0), MEDIUM is `warning` (5.0) and LOW is `note` (2.0). SARIF results point at the lock file, and `partialFingerprints` (`mcpRcCheckSurface/v1`) are stable across versions of the tool.

## Change classes

| Class | Severity |
| --- | --- |
| [`tool-description-changed`](#tool-description-changed) | HIGH |
| [`tool-input-schema-changed`](#tool-input-schema-changed) | HIGH |
| [`tool-added-unsafe`](#tool-added-unsafe) | HIGH |
| [`tool-annotation-downgrade`](#tool-annotation-downgrade) | HIGH |
| [`tool-removed-required`](#tool-removed-required) | HIGH |
| [`server-instructions-changed`](#server-instructions-changed) | HIGH |
| [`server-unlocked`](#server-unlocked) | HIGH |
| [`tool-added-readonly`](#tool-added-readonly) | MEDIUM |
| [`tool-output-schema-changed`](#tool-output-schema-changed) | MEDIUM |
| [`tool-annotation-changed`](#tool-annotation-changed) | MEDIUM |
| [`tool-other-field-changed`](#tool-other-field-changed) | MEDIUM |
| [`prompt-changed`](#prompt-changed) | MEDIUM |
| [`resource-changed`](#resource-changed) | MEDIUM |
| [`server-identity-changed`](#server-identity-changed) | MEDIUM |
| [`tool-title-changed`](#tool-title-changed) | LOW |
| [`tool-order-changed`](#tool-order-changed) | LOW |
| [`tool-removed`](#tool-removed) | LOW |
| [`server-version-changed`](#server-version-changed) | LOW |
| [`server-removed`](#server-removed) | LOW |

### tool-description-changed

**HIGH.** The description of a locked tool changed.

The model reads tool descriptions as instructions. A changed description is the classic rug pull: approve a harmless text, then swap it. Read the diff before accepting it.

Triggered when the whitespace-normalised `description` of a tool in the lock differs from the live one, including a description that was added or removed. `surface diff <tool>` shows the change.

### tool-input-schema-changed

**HIGH.** The input schema of a locked tool changed.

New or renamed parameters, parameter descriptions and defaults change what the model sends to the tool. Read the diff before accepting it.

Triggered when the canonicalised `inputSchema` differs: any keyword, property, property description, default, enum or `$schema` change. Key order, whitespace in schema descriptions and titles, and the order of `required` entries do not count.

### tool-added-unsafe

**HIGH.** A new tool that is not marked read-only.

The tool was not in the lock and does not declare readOnlyHint: true (it is a write tool, is marked destructive, or has no annotations). Review it before a session can call it.

Triggered for a tool that is not in the lock and whose effective `readOnlyHint` is false: it says `readOnlyHint: false`, or has no `readOnlyHint`, or has no annotations at all.

### tool-annotation-downgrade

**HIGH.** A locked tool lost a safety hint.

readOnlyHint went from true to false, or destructiveHint from false to true (absent hints count as their specification defaults). Permission rules that trusted the old hint may now allow a write.

Effective values use the specification defaults: `readOnlyHint` false, `destructiveHint` true (meaningful only when the tool is not read-only). Removing all annotations from a read-only tool is therefore a downgrade.

### tool-removed-required

**HIGH.** A tool the lock marks as required is gone.

The lock was created with --require for this tool. Workflows that depend on it will break, or a renamed tool is standing in for it.

Mark a tool with `surface lock --require <tool>`. The mark survives a re-lock to the same file.

### server-instructions-changed

**HIGH.** The server instructions changed.

Instructions from initialize are given to the model like a description. Treated like a description change (classification inferred, see docs/surface.md).

Compares the whitespace-normalised `instructions` string from the `server/discover` (or `initialize`) result.

### server-unlocked

**HIGH.** A configured server has no lock.

The client configuration declares a server that has never been locked, so nothing about its tools has been reviewed. Lock it with surface watch-config after reviewing it.

Only from `surface verify-config` and `surface hook --format claude-settings`. Servers on an unsupported transport (the legacy HTTP+SSE transport) are listed as skipped instead.

### tool-added-readonly

**MEDIUM.** A new tool marked read-only.

The tool declares readOnlyHint: true. Annotations are hints the server chooses, so review the description and schema anyway.

Triggered for a tool that is not in the lock and declares `readOnlyHint: true`.

### tool-output-schema-changed

**MEDIUM.** The output schema of a locked tool changed.

Structured results now have a different shape. Text in an output schema can also reach the model.

Includes an output schema that was added or removed.

### tool-annotation-changed

**MEDIUM.** Another annotation of a locked tool changed.

For example readOnlyHint false to true, openWorldHint or idempotentHint. A tool that newly claims to be read-only may now be auto-allowed by rules generated from annotations; check that the claim is true.

Any change to the annotations other than `title` that is not a downgrade. The message lists every effective hint that moved.

### tool-other-field-changed

**MEDIUM.** Another field of a locked tool changed.

execution, icons or a field this version does not know about changed.

Compares `execution`, `icons` and any other top-level tool field except `_meta`.

### prompt-changed

**MEDIUM.** A prompt was added, removed or changed.

Prompts are templates a user can insert; their text reaches the model when used.

Compares the normalised prompt entries from `prompts/list` (name, title, description, arguments). The subject is `prompt:<name>`.

### resource-changed

**MEDIUM.** A resource or resource template was added, removed or changed.

Resource names and descriptions are shown to the user and can be attached to the context.

Compares the normalised entries from `resources/list` and `resources/templates/list`. The subject is `resource:<uri>` or `template:<uriTemplate>`. Resource contents are never read.

### server-identity-changed

**MEDIUM.** The server reports a different name.

serverInfo.name changed. Check that the command or URL still points at the server you reviewed.

Compares `serverInfo.name`.

### tool-title-changed

**LOW.** The display title of a locked tool changed.

title or annotations.title changed. Titles are for people, not the model (inferred, see docs/surface.md).

Compares `title` and `annotations.title`.

### tool-order-changed

**LOW.** The tools are listed in a different order.

Same tools, same definitions, new order.

Compares the order of the tools present in both the lock and the live list.

### tool-removed

**LOW.** A tool is gone.

Removing a tool cannot widen what a session can do. Mark tools you depend on with surface lock --require to make their removal HIGH.

A tool in the lock that the server no longer lists, without the required mark.

### server-version-changed

**LOW.** The server reports a different version or protocol version.

Informational: serverInfo.version or the negotiated protocol version changed. The tool surface itself is compared separately.

Compares `serverInfo.version` and the negotiated protocol version.

### server-removed

**LOW.** A locked server is no longer configured.

A lock exists for a server that the client configuration no longer declares.

Only from `surface verify-config`: a `<name>.lock.json` under the lock directory with no server of that name in the configuration.

## The lock file: `mcp-surface.lock.json`

Schema version: `"lockfileVersion": 1`. A reader that sees any other value must refuse the file; `mcp-rc-check` exits 2 and asks you to re-create it. A change to the shape, the normalisation or the hashing bumps the version.

### Hashing

- **Canonical JSON** is `JSON.stringify` of the normalised value with sorted keys and no whitespace.
- **Entry hash**: `sha256:` plus the hex SHA-256 of the canonical JSON of the normalised definition. For a tool the definition is the normalised tool object; for prompts, resources and templates it is the normalised entry.
- **Instructions hash**: SHA-256 of the normalised instructions string.
- **Tree hash** (each entry of `components`): sort the entry keys by UTF-16 code unit order, then SHA-256 the concatenation of `<key>`, a NUL byte, `<hash>` and a newline for each entry. An empty component hashes the empty string. The `instructions` component is the tree hash of `{"instructions": <instructions hash>}`, or of nothing when the server has no instructions.
- **Surface hash** (`surfaceHash`): the tree hash of the five component hashes, keyed `instructions`, `prompts`, `resourceTemplates`, `resources` and `tools`.

`toolOrder` and the `required` marks are not part of any hash, so reordering is reported separately (as LOW) and marking a tool required does not change the surface hash.

### Document shape

The top-level keys appear in this order; every object below them has sorted keys. The file ends with a newline and carries no timestamps, so two locks of an unchanged server are byte-identical. This is the lock of the test fixture server, shortened:

```json
{
  "lockfileVersion": 1,
  "generator": "mcp-rc-check",
  "generatorVersion": "0.2.0",
  "hashAlgorithm": "sha256",
  "source": { "kind": "stdio", "target": "node (+1 argument)" },
  "covers": ["tools", "prompts", "resources", "server"],
  "server": { "name": "fixture-files", "version": "1.0.0" },
  "protocolVersion": "2025-11-25",
  "surfaceHash": "sha256:effcd04a8a0d089971a55eccd222f014fc34a0ad68d8c853a19d482847815795",
  "components": {
    "instructions": "sha256:...",
    "prompts": "sha256:...",
    "resourceTemplates": "sha256:...",
    "resources": "sha256:...",
    "tools": "sha256:..."
  },
  "instructions": { "hash": "sha256:...", "text": "Use read_file before write_file." },
  "toolOrder": ["read_file", "search_files", "write_file"],
  "tools": {
    "read_file": {
      "definition": {
        "annotations": { "openWorldHint": false, "readOnlyHint": true },
        "description": "Read a file from the workspace and return its text.",
        "inputSchema": { "properties": { "path": { "description": "Path relative to the workspace", "type": "string" } }, "required": ["path"], "type": "object" },
        "name": "read_file",
        "title": "Read file"
      },
      "hash": "sha256:470d773d2f22...",
      "required": false
    }
  },
  "prompts": { "summarise": { "definition": { "...": "..." }, "hash": "sha256:..." } },
  "resources": { "fixture://readme": { "definition": { "...": "..." }, "hash": "sha256:..." } },
  "resourceTemplates": { "fixture://notes/{id}": { "definition": { "...": "..." }, "hash": "sha256:..." } }
}
```

| Field | Meaning |
| --- | --- |
| `source` | How the surface was read: `stdio` (the program name and the number of arguments, never the arguments, which may carry secrets), `http` (origin and path, never the query string or credentials) or `dump` (the file name) |
| `covers` | The parts the lock describes; see "Coverage" above |
| `server` | `serverInfo` `name`, `version` and `title`, when the server sent them |
| `protocolVersion` | `2026-07-28` after `server/discover`, or the version `initialize` negotiated |
| `instructions` | The normalised instructions and their hash, when the server sent any |
| `toolOrder` | Tool names in the order the server listed them (pages joined in order) |
| `tools.<name>` | `definition` (the full normalised tool), `hash` and `required` |
| `prompts.<name>`, `resources.<uri>`, `resourceTemplates.<uriTemplate>` | `definition` and `hash` |

Headers given with `-H` and environment values given with `-e` or in a client configuration are never written to a lock.

### Reading a lock

`verify` and `diff` refuse a lock that is not version 1, was not written by `mcp-rc-check`, lacks a required key, or has a `definition` whose recomputed hash does not match its `hash`. That last check catches a lock edited by hand: to accept a change, run `surface lock` again rather than editing the file. The `required` flag is the one field you may edit by hand; it is not hashed.

### One lock per server

`watch-config` writes `<lock-dir>/<server>.lock.json` for each server in a client configuration, with every character outside `A-Z a-z 0-9 . _ -` in the server name replaced by `_` and leading dots replaced by one `_`. The default lock directory is `.mcp-surface`.

## Claude Code permission rule names

`surface hook --format claude-settings` writes rules as `mcp__<server>__<tool>`, with the server name as it appears in the client configuration. Characters outside `A-Z a-z 0-9 _ -` in the server name are replaced by `_` to match how Claude Code forms these names. **(inferred)** Check the generated names against `/permissions` in Claude Code before relying on them.

## Library use

Everything above is exported from the package entry point: `normaliseSurface`, `buildLock`, `serialiseLock`, `parseLock`, `compareWithLock`, `SURFACE_RULES`, `formatSurfaceSarif`, `settingsSnippet` and the rest, alongside the `scan` API.
