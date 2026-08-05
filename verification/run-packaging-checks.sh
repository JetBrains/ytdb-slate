#!/usr/bin/env bash
# =============================================================================
# slate — packaging guards
# =============================================================================
# Makes AGENTS.md § "Packaging rules" executable: asserts the package.json
# manifest shape (the exact `files` whitelist, the docs/ entry the shipped
# doctrine depends on, the pi-package keyword, every pi-bundled SDK package
# peer-only at "*", no install-time lifecycle scripts) AND the real
# `npm pack --dry-run` output (only allowed file kinds, no junk/secrets, every
# doctrine doc the extension references actually shipped). Prints one
#   CHECK <id> <PASS|FAIL> — <detail>
# line per check plus a summary. See verification/README.md.
#
# Usage:
#   bash verification/run-packaging-checks.sh --repo .
#   bash verification/run-packaging-checks.sh --repo . --self-test
#   bash verification/run-packaging-checks.sh            # --repo defaults to .
#
#   --repo <dir>   slate checkout under test (default: ".")
#   --self-test    validate the guards themselves instead: re-run each guard
#                  against the REAL input carrying one violating mutation and
#                  require it to fail
#
# Exit status: 0 all checks passed · 1 a check failed · 2 refused to start
# (a missing tool or a bad --repo).
#
# Needs NO pi and NO network — unlike run-ladder.sh and run-resolver-checks.sh
# this one loads no extension module and starts no session, so `node` and `npm`
# are the whole dependency list. It writes nothing anywhere: the pack is a dry
# run, and one of the guards asserts no tarball was left behind.
# =============================================================================
set -uo pipefail

exec 8>&2
# One vocabulary for every abort, shared with the other CI harnesses: exit 2
# is documented as "refused to start", so the message says so too rather than
# leaving the reader to infer it from the status (WC2). Callers pass the reason.
die() { echo "verification: refused to start — $*" >&8; exit 2; }

REPO="."
ARGS=()
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || die "option '--repo' requires a value"; REPO="$2"; shift 2 ;;
		--self-test) ARGS+=("--self-test"); shift ;;
		-h|--help) sed -n '2,31p' "$0"; exit 0 ;;
		*) die "unknown argument '$1' (try --help)" ;;
	esac
done

for t in node npm; do
	command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"
done

REPO="$(cd "$REPO" 2>/dev/null && pwd -P)" || die "bad --repo: not a directory"
[ -f "$REPO/package.json" ] || die "not a slate checkout: $REPO/package.json is missing"
[ -f "$REPO/verification/packaging-checks.mjs" ] || die "not a slate checkout: $REPO/verification/packaging-checks.mjs is missing"

node --no-warnings "$(dirname "$0")/packaging-checks.mjs" "$REPO" ${ARGS+"${ARGS[@]}"}
