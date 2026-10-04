# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability") rather than a public issue. Include the version, the command you ran, a dump or configuration that reproduces the problem (with secrets removed), and what you expected.

You will get an acknowledgement within 7 days and a fix or a mitigation plan within 30 days for confirmed issues. Credit is given in the release notes unless you prefer otherwise.

## Scope

mcp-rc-check connects to a server you name (by starting a stdio command or sending HTTP requests to a URL), or reads JSON files you name, and prints findings. It writes only the files you ask for (`--save-dump`, `--fix`). Issues of interest include:

- A request sent during a live scan that is not read-only, or a request sent to a host other than the one given with `--url`.
- Headers given with `-H` or environment values given with `-e` appearing in a dump, a finding, a patch or an error message.
- A finding or error message that echoes a header value other than a protocol version.
- A stdio server receiving environment variables beyond the documented minimal set and the ones passed with `-e`.
- `--fix` editing an input file in place, or writing outside the path given with `--patch-file`.
- A rule that reports a requirement the cited specification section does not state.

What is not a vulnerability in this tool: a server that behaves badly when probed with the documented read-only requests, and the context lines a patch copies from your own file (documented in the README).
