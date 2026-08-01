#!/usr/bin/env bash
# =============================================================================
# slate — worker-extension resolver checks
# =============================================================================
# Exercises the pure resolver pipeline in extension/worker-extensions.ts and the
# doctrine rule it feeds in extension/mode.ts. Prints one
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
# (a missing tool, a bad --repo, no resolvable pi CLI, or jiti could not be
# located).
#
# Everything runs against fabricated in-memory inputs — no network, no real pi
# session. The only writes land in a throwaway temp dir this script creates and
# removes on exit; it never touches real pi state or the repository. The TS is
# loaded through the jiti bundled with pi (node's strip-only TypeScript mode
# cannot load the modules), so `node` must be on PATH and a pi installation must
# be findable — in resolution order: $PI_BIN, then the checkout's own
# node_modules/.bin/pi (what `npm ci` installs), then a PATH-resolved `pi`.
# Unlike the ladder this script uses only POSIX shell plus node — no GNU
# coreutils — so it runs on non-GNU platforms too (symlink canonicalisation is
# done by node's realpathSync, not the GNU-only `readlink -f`).
# =============================================================================
set -uo pipefail

exec 8>&2
# One vocabulary for every abort, shared with the other tier-1 harnesses: exit 2
# is documented as "refused to start", so the message says so too rather than
# leaving the reader to infer it from the status (WC2). Callers pass the reason.
die() { echo "verification: refused to start — $*" >&8; exit 2; }

REPO="."
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || die "option '--repo' requires a value"; REPO="$2"; shift 2 ;;
		-h|--help) sed -n '2,30p' "$0"; exit 0 ;;
		*) die "unknown argument '$1' (try --help)" ;;
	esac
done

# pi is NOT in this list: it is resolved below, from the checkout first. Looking
# for it on PATH was the whole defect (BG3) — a CI runner has no global pi, so
# this step aborted before a single check ran, while a developer machine with a
# global install never saw it.
for t in node mktemp; do
	command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"
done

REPO="$(cd "$REPO" 2>/dev/null && pwd -P)" || die "bad --repo: not a directory"
[ -f "$REPO/extension/worker-extensions.ts" ] || die "not a slate checkout: $REPO/extension/worker-extensions.ts is missing"

# --------------------------------------------------------------- the pi CLI --
# Same resolution order as verification/run-load-check.sh, so there is one
# convention to learn: $PI_BIN, then the checkout's own node_modules/.bin/pi,
# then a PATH-resolved pi. The repo-local install is what `npm ci` produces and
# the only one CI has. PI_BIN is honoured as an escape hatch and reported loudly,
# because a silently substituted CLI would silently substitute the jiti below; it
# is NOT a security boundary and is not treated as one (anyone who can set it can
# edit this script).
#
# Where this DOES differ from the load check: a PATH pi is an acceptable last
# resort here, and no version-drift guard is applied. All this script borrows
# from pi is the bundled jiti TypeScript loader; it starts no session and asserts
# nothing about pi's own behaviour, and the module graph it loads
# (worker-extensions.ts, mode.ts and their runtime imports) imports no pi SDK
# package at all — the SDK imports in both entry modules are `import type` and
# are erased at transpile time. A jiti old enough to matter cannot make a check
# pass wrongly either: it can only fail to transpile, which crashes this driver
# with a non-zero exit and no summary line. The load check has the opposite
# exposure (pi's rpc output shapes ARE its evidence, and a shape change reads as
# "no events"), which is why the pinned-version guard lives there and not here.
PI=""
if [ -n "${PI_BIN:-}" ]; then
	PI="$PI_BIN"
	echo "NOTE   PI_BIN override in use: $PI"
	echo "NOTE   the checkout's own node_modules/.bin/pi was NOT used. This is an escape"
	echo "NOTE   hatch, not a security boundary — the jiti below comes from that CLI."
elif [ -x "$REPO/node_modules/.bin/pi" ]; then
	PI="$REPO/node_modules/.bin/pi"
elif PI="$(command -v pi)" && [ -n "$PI" ]; then
	echo "NOTE   no pi in $REPO/node_modules/.bin — using the PATH one: $PI"
	echo "NOTE   run 'npm ci' in $REPO to exercise the pinned install instead."
else
	die "no pi CLI found: PI_BIN is unset, there is none at
       $REPO/node_modules/.bin/pi, and none on PATH. This script loads the
       repository's TypeScript through the jiti that ships inside pi.
       Remedy: run 'npm ci' in $REPO (or set PI_BIN=<path to pi>)."
fi
[ -x "$PI" ] || die "the pi CLI '$PI' is not executable"

# Locate the jiti bundled with that pi, the way pi's own module graph resolves
# it, so this works regardless of where pi is installed or how deps are hoisted.
# The pi launcher is usually a symlink; node's realpathSync canonicalises it
# (portable — `readlink -f` is GNU-only) so createRequire walks up into the pi
# package's own node_modules where jiti lives. node prints the underlying error,
# so a failure here names its real cause rather than blaming the pi binary.
JITI="$(node -e 'const {realpathSync}=require("node:fs");const {createRequire}=require("node:module");try{console.log(createRequire(realpathSync(process.argv[1])).resolve("jiti"))}catch(e){console.error(e&&e.message?e.message:String(e));process.exit(9)}' "$PI")" \
	|| die "could not locate jiti (it ships with pi) via $PI — see the node error above"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/slate-resolver.XXXXXX")" || die "could not create a scratch directory"
trap 'rm -rf "$WORK"' EXIT INT TERM

node --no-warnings "$(dirname "$0")/resolver-checks.mjs" "$REPO" "$JITI" "$WORK"
