#!/usr/bin/env bash
# =============================================================================
# slate — pure-resolver checks
# =============================================================================
# Exercises the pure resolver pipeline in extension/worker-extensions.ts and the
# doctrine rule it feeds in extension/mode.ts, plus the model router in
# extension/model-router.ts (config sanitizer, candidate resolution and its
# warnings, effort predicate) against fabricated registries and profile tables.
# Prints one
#   CHECK <id> <PASS|FAIL> — <detail>
# line per check plus a summary. See verification/README.md.
#
# Usage:
#   bash verification/run-resolver-checks.sh --repo .
#   bash verification/run-resolver-checks.sh            # --repo defaults to .
#
#   --repo <dir>   slate checkout under test (default: ".")
#
# Exit status: 0 all checks passed · 1 a check failed · 2 refused to start
# (a missing tool, a bad --repo, or jiti could not be located).
#
# Everything runs against fabricated in-memory inputs — no network, no real pi
# session. The only writes land in a throwaway temp dir this script creates and
# removes on exit; it never touches real pi state or the repository. The TS is
# loaded through the jiti bundled with pi (node's strip-only TypeScript mode
# cannot load the modules), so `pi` and `node` must both be on PATH. Unlike the
# ladder this script uses only POSIX shell plus node — no GNU coreutils — so it
# runs on non-GNU platforms too (symlink canonicalisation is done by node's
# realpathSync, not the GNU-only `readlink -f`).
# =============================================================================
set -uo pipefail

exec 8>&2
die() { echo "verification: $*" >&8; exit 2; }

REPO="."
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || die "option '--repo' requires a value"; REPO="$2"; shift 2 ;;
		-h|--help) sed -n '2,30p' "$0"; exit 0 ;;
		*) die "unknown argument '$1' (try --help)" ;;
	esac
done

for t in pi node mktemp; do
	command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"
done

REPO="$(cd "$REPO" 2>/dev/null && pwd -P)" || die "bad --repo: not a directory"
[ -f "$REPO/extension/worker-extensions.ts" ] || die "not a slate checkout: $REPO/extension/worker-extensions.ts is missing"

# Locate the jiti bundled with pi, the way pi's own module graph resolves it, so
# this works regardless of where pi is installed or how deps are hoisted. The pi
# launcher is usually a symlink; node's realpathSync canonicalises it (portable —
# `readlink -f` is GNU-only) so createRequire walks up into the pi package's own
# node_modules where jiti lives. node prints the underlying error, so a failure
# here names its real cause rather than blaming the pi binary.
PI_BIN="$(command -v pi)" || die "pi not found on PATH"
JITI="$(node -e 'const {realpathSync}=require("node:fs");const {createRequire}=require("node:module");try{console.log(createRequire(realpathSync(process.argv[1])).resolve("jiti"))}catch(e){console.error(e&&e.message?e.message:String(e));process.exit(9)}' "$PI_BIN")" \
	|| die "could not locate jiti (it ships with pi) via $PI_BIN — see the node error above"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/slate-resolver.XXXXXX")" || die "could not create a scratch directory"
trap 'rm -rf "$WORK"' EXIT INT TERM

node --no-warnings "$(dirname "$0")/resolver-checks.mjs" "$REPO" "$JITI" "$WORK"
