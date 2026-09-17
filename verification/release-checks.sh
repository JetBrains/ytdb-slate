#!/usr/bin/env bash
# Run the complete executable release roster against one exact release commit.
set -euo pipefail
fail() { printf 'release-checks: %s\n' "$*" >&2; exit 2; }
repo= base= request= evidence=
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo=$2; shift 2;; --base) base=$2; shift 2;; --request) request=$2; shift 2;; --evidence) evidence=$2; shift 2;;
    -h|--help) echo 'usage: release-checks.sh --repo <dir> --base <sha> --request <json> --evidence <outside-dir>'; exit 0;;
    *) fail "unknown argument $1";;
  esac
done
[ -n "$repo" ] && [ -n "$base" ] && [ -n "$request" ] && [ -n "$evidence" ] || fail 'all arguments are required'
repo=$(cd "$repo" && pwd -P); request=$(cd "$(dirname "$request")" && pwd -P)/$(basename "$request")
case "$evidence" in "$repo"|"$repo"/*) fail 'evidence directory must be outside the checkout';; esac
mkdir -p "$evidence"; : >"$evidence/commands.tsv"
[ "$(git -C "$repo" rev-parse HEAD)" != "$base" ] || fail 'base equals release commit'
git -C "$repo" diff --quiet && git -C "$repo" diff --cached --quiet || fail 'checkout is not clean'
run() { local name=$1; shift; printf '%s\t' "$name" >>"$evidence/commands.tsv"; printf '%q ' "$@" >>"$evidence/commands.tsv"; printf '\n' >>"$evidence/commands.tsv"; printf 'ROSTER %s START\n' "$name"; set +e; "$@" 2>&1 | tee "$evidence/$name.log"; local s=${PIPESTATUS[0]}; set -e; [ "$s" -eq 0 ] || { printf 'ROSTER %s FAIL status=%s\n' "$name" "$s"; exit "$s"; }; printf 'ROSTER %s PASS\n' "$name"; }
cd "$repo"
run typecheck npm run typecheck
run packaging bash verification/run-packaging-checks.sh --repo .
run packaging-self bash verification/run-packaging-checks.sh --repo . --self-test
run load bash verification/run-load-check.sh --repo .
run resolver bash verification/run-resolver-checks.sh --repo . --strict
run tests npm test -- --base "$base"
grep -Eq '^RUN VERDICT: (PASS|WARN) —' "$evidence/tests.log" || fail 'test roster has no final coverage verdict'
if grep -q '^RUN VERDICT: WARN —' "$evidence/tests.log"; then
  changed=$(git diff --name-only "$base..HEAD" | sort)
  expected=$(node -e 'const r=require(process.argv[1]);for(const p of r.coverageDisposition.allowedPaths)console.log(p)' "$request" | sort)
  [ "$changed" = "$expected" ] || fail 'coverage WARN paths differ from the reviewed request'
  printf 'WARN exact-parent=%s exact-head=%s request-identity=%s\n' "$base" "$(git rev-parse HEAD)" "$(node -p 'require(process.argv[1]).identity' "$request")" >"$evidence/coverage-disposition.txt"
fi
ladder_home=$(mktemp -d "${TMPDIR:-/tmp}/slate-release-ladder-home.XXXXXX"); load_home=
trap 'rm -rf "$ladder_home" ${load_home:+"$load_home"}' EXIT
mkdir -p "$ladder_home/.pi/agent"; printf '{}' >"$ladder_home/.pi/agent/settings.json"
run ladder env -u PI_CODING_AGENT_DIR -u SLATE_LADDER_REAL_AGENT_DIR HOME="$ladder_home" PATH="$repo/node_modules/.bin:$PATH" bash verification/run-ladder.sh --repo . --strict
run package-content node verification/package-content-check.mjs --repo .
run package-content-self node verification/package-content-check.mjs --repo . --self-test
run writing node verification/writing-check-tests.mjs
run writing-scaling node verification/writing-check-scaling.mjs
run writing-reminder bash verification/run-writing-reminder-check.sh --repo .
run worker-reminder bash verification/run-worker-reminder-check.sh --repo .
load_home=$(mktemp -d "${TMPDIR:-/tmp}/slate-release-load-home.XXXXXX"); printf '%s\n' '{"id":"1","type":"get_commands"}' >"$load_home/request.jsonl"
run isolated-load bash -c 'env HOME="$1" PI_CODING_AGENT_DIR="$1/agent" PI_OFFLINE=1 "$2" --no-extensions -e "$3" --mode rpc -a <"$1/request.jsonl"' _ "$load_home" "$repo/node_modules/.bin/pi" "$repo"
grep -Eq 'Failed to load extension|Cannot find module|SyntaxError|Extension error|extension_error' "$evidence/isolated-load.log" && fail 'isolated load emitted a failure marker'
node -e 'const fs=require("fs"),x=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(v=>v.startsWith("{")).map(JSON.parse),r=x.find(v=>v.type==="response"&&v.command==="get_commands"),s=r?.data?.commands?.filter(c=>c.name==="slate");if(s?.length!==1)throw Error("isolated load did not register one /slate command")' "$evidence/isolated-load.log"
expected_roster='typecheck packaging packaging-self load resolver tests ladder package-content package-content-self writing writing-scaling writing-reminder worker-reminder isolated-load'
actual_roster=$(cut -f1 "$evidence/commands.tsv" | tr '\n' ' ' | sed 's/ $//')
[ "$actual_roster" = "$expected_roster" ] || fail 'release roster was skipped, duplicated, or reordered'
printf 'ROSTER COMPLETE head=%s base=%s request=%s\n' "$(git rev-parse HEAD)" "$base" "$(node -p 'require(process.argv[1]).identity' "$request")" | tee "$evidence/roster.txt"
