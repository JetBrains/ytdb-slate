#!/usr/bin/env bash
# =============================================================================
# slate — pure-resolver checks
# =============================================================================
#:HELP_START
# Exercises the pure resolver pipelines that have no other regression net:
#   · the worker-extension resolver in extension/worker-extensions.ts and the
#     doctrine rule it feeds in extension/mode.ts;
#   · the model router in extension/model-router.ts — config sanitizer,
#     candidate resolution and its warnings, the effort predicate — against
#     fabricated registries and fabricated profile tables;
#   · structural invariants of the shipped table in extension/model-profiles.ts
#     (shape and internal consistency only, never a research number).
# Prints one
#   CHECK <id> <PASS|FAIL|NOT RUN> — <detail>
# line per check (a FAIL adds an `observed:` line), then a `roster` check that
# every expected check reported, then a summary. See verification/README.md.
#
# Usage:
#   bash verification/run-resolver-checks.sh --repo .
#   bash verification/run-resolver-checks.sh            # --repo defaults to .
#   bash verification/run-resolver-checks.sh --strict    # CI: NOT RUN is fatal
#
#   --repo <dir>   slate checkout under test (default: ".")
#   --strict       any NOT RUN check fails the run (automation should pass this)
#
# Exit status: 0 all checks passed · 1 a check failed, a check went missing, or
# --strict was given and a check reported NOT RUN · 2 refused to start (a missing
# tool, a bad --repo, or jiti could not be located).
#
# Everything runs against fabricated in-memory inputs — no network, no real pi
# session. The only writes land in a throwaway temp dir this script creates and
# removes on exit; it never touches real pi state or the repository. The TS is
# loaded through the jiti bundled with pi (node's strip-only TypeScript mode
# cannot load the modules), so `pi` and `node` must both be on PATH. Unlike the
# ladder this script uses only POSIX shell plus node — no GNU coreutils — so it
# runs on non-GNU platforms too (symlink canonicalisation is done by node's
# realpathSync, not the GNU-only `readlink -f`).
#:HELP_END
# =============================================================================
set -uo pipefail

exec 8>&2
die() { echo "verification: $*" >&8; exit 2; }

# --help prints the block between the markers above, so editing the header can
# never silently truncate the help text (WH1: a hard-coded line range did).
usage() { sed -n '/^#:HELP_START/,/^#:HELP_END/p' "$0" | sed '1d;$d;s/^# \{0,1\}//'; }

REPO="."
STRICT=""
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || die "option '--repo' requires a value"; REPO="$2"; shift 2 ;;
		--strict) STRICT="strict"; shift ;;
		-h|--help) usage; exit 0 ;;
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
# INT/TERM exit explicitly after cleanup, the way run-ladder.sh does (WH2):
# without it an interrupted run leaves the shell's own signal disposition to
# decide the exit status.
trap 'rm -rf "$WORK"' EXIT
trap 'rm -rf "$WORK"; exit 130' INT
trap 'rm -rf "$WORK"; exit 143' TERM

node --no-warnings "$(dirname "$0")/resolver-checks.mjs" "$REPO" "$JITI" "$WORK" "$STRICT"
