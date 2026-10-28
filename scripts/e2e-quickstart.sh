#!/usr/bin/env bash
# Run the README quick start on a fresh install.
#
# 1. "Quick start": a fresh clone of this checkout, `npm ci && npm run build`, then
#    `node dist/cli.js scan --dump` on the bundled pre-revision dump, checking the sample.
# 2. "Quickstart": `npm pack`, install the tarball into a new empty project, and run each
#    command of that section against the bundled fixture server and fixtures.
#
#   scripts/e2e-quickstart.sh        (npm run e2e)
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

expect() { # expect <file> <text>
  if ! grep -qF -- "$2" "$1"; then
    echo "FAIL: expected to find: $2" >&2
    cat "$1" >&2
    exit 1
  fi
}
run() { # run <expected exit code> <output file> <command...>
  local want="$1" out="$2"
  shift 2
  set +e
  "$@" >"$out" 2>"$out.err"
  local got=$?
  set -e
  if [ "$got" != "$want" ]; then
    echo "FAIL: $* exited $got, expected $want" >&2
    cat "$out" "$out.err" >&2
    exit 1
  fi
}

echo "== Quick start from a fresh clone"
git clone --quiet "$repo" "$work/clone"
(cd "$work/clone" && npm ci --no-audit --no-fund --silent && npm run --silent build)
cd "$work/clone"
run 1 "$work/sample.txt" node dist/cli.js scan --dump test/fixtures/fixture-pre-revision.json
expect "$work/sample.txt" "ERROR cache-hints-missing  [tools/list]  (autofix)"
expect "$work/sample.txt" "the tools/list result has no ttlMs"
expect "$work/sample.txt" "at:     /lists/tools~1list/0/result"
run 0 "$work/stdio.txt" node dist/cli.js scan --stdio "node test/fixtures/fixture-server.mjs modern"

echo "== Quickstart from the packed tarball"
tarball="$(npm pack --silent --pack-destination "$work")"
mkdir "$work/project"
cd "$work/project"
git init --quiet
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "$work/$tarball"
fixtures="$work/clone/test/fixtures"
bin="$work/project/node_modules/.bin/mcp-rc-check"

# A local stdio server: probe it, keep what it said, and see the findings.
run 1 legacy.txt "$bin" scan --stdio "node $fixtures/fixture-server.mjs legacy" --save-dump rc-dump.json
expect legacy.txt "ERROR legacy-only-server  [server]"
test -s rc-dump.json

# Re-check a saved dump and write the mechanical fixes as a patch.
run 1 fix.txt "$bin" scan --dump rc-dump.json --fix
test -s rc-dump.json.patch
cp "$fixtures/fixture-tools.json" tools-list.json
git add tools-list.json
# scan exits 1 because it found something; only git apply's status matters here.
(set +o pipefail; "$bin" scan --dump tools-list.json --fix --patch-file - | git apply)
git diff --quiet tools-list.json && { echo "FAIL: the patch changed nothing" >&2; exit 1; }
run 1 fixed.txt "$bin" scan --dump tools-list.json
expect fixed.txt "0 with an autofix"

# A client configuration.
run 1 client.txt "$bin" client --config "$fixtures/fixture-claude-config.json"

# CI: SARIF for code scanning.
run 1 rc.sarif "$bin" scan --dump rc-dump.json --format sarif --fail-on warning
node -e "const s=JSON.parse(require('fs').readFileSync('rc.sarif','utf8')); if (s.version!=='2.1.0' || !s.runs[0].results.length) process.exit(1)"

# Every rule with its spec section.
run 0 rules.txt "$bin" rules
expect rules.txt "cache-hints-missing"

# Pin the tool surface.
run 0 lock.txt "$bin" surface lock --dump "$fixtures/surface/fixture-base.json"
run 0 verify.txt "$bin" surface verify --dump "$fixtures/surface/fixture-base.json"

echo "quick start OK on a fresh install"
