#!/usr/bin/env bash
# Run slate's node:test suite with LCOV and enforce patch coverage.
# Node 24 still marks --experimental-test-coverage as experimental; native LCOV
# has no stable replacement, so this unavoidable flag is confined to this file.
set -euo pipefail

fail() { printf 'run-tests: %s\n' "$*" >&2; exit 2; }
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
base=""
gate=1
line_threshold=85
branch_threshold=85
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || fail "--base requires a ref"; base="$2"; shift 2 ;;
    --no-gate) gate=0; shift ;;
    --threshold-lines) [ $# -ge 2 ] || fail "--threshold-lines requires a number"; line_threshold="$2"; shift 2 ;;
    --threshold-branches) [ $# -ge 2 ] || fail "--threshold-branches requires a number"; branch_threshold="$2"; shift 2 ;;
    -h|--help)
      echo "usage: bash verification/run-tests.sh [--base <ref>] [--no-gate] [--threshold-lines N] [--threshold-branches N]"
      exit 0 ;;
    *) fail "unknown argument '$1'" ;;
  esac
done

# These settings can redirect repository discovery, writes, configuration, or
# executable helpers before this runner can establish its real checkout.
unsafe_git_names=()
for name in \
  GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_CEILING_DIRECTORIES \
  GIT_DISCOVERY_ACROSS_FILESYSTEM GIT_EXEC_PATH GIT_TEMPLATE_DIR \
  GIT_CONFIG GIT_CONFIG_PARAMETERS
 do
  [[ -v "$name" ]] && unsafe_git_names+=("$name")
done
[[ -v GIT_CONFIG_GLOBAL && "$GIT_CONFIG_GLOBAL" != /dev/null ]] && unsafe_git_names+=(GIT_CONFIG_GLOBAL)
[[ -v GIT_CONFIG_SYSTEM && "$GIT_CONFIG_SYSTEM" != /dev/null ]] && unsafe_git_names+=(GIT_CONFIG_SYSTEM)
[[ -v GIT_CONFIG_NOSYSTEM && "$GIT_CONFIG_NOSYSTEM" != 1 ]] && unsafe_git_names+=(GIT_CONFIG_NOSYSTEM)
[[ -v GIT_CONFIG_COUNT && "$GIT_CONFIG_COUNT" != 0 ]] && unsafe_git_names+=(GIT_CONFIG_COUNT)
while IFS= read -r name; do
  [ -n "$name" ] && unsafe_git_names+=("$name")
done < <(compgen -A variable GIT_CONFIG_KEY_ || true)
while IFS= read -r name; do
  [ -n "$name" ] && unsafe_git_names+=("$name")
done < <(compgen -A variable GIT_CONFIG_VALUE_ || true)
# Trace1 and Trace2 target variables can append to an arbitrary pathname. Scan
# the families so a newly added Git trace target cannot bypass this preflight.
while IFS= read -r name; do
  [ -n "$name" ] && unsafe_git_names+=("$name")
done < <(compgen -A variable GIT_TRACE || true)
if [ "${#unsafe_git_names[@]}" -gt 0 ]; then
  joined="$(IFS=', '; echo "${unsafe_git_names[*]}")"
  fail "unsafe inherited Git settings detected before repository inspection: $joined. Unset these settings before running the suite, for example with 'env -u GIT_DIR npm test -- --base <ref>'."
fi

# Preserve the caller's ordinary process environment, but replace every Git
# system, global, and command-line configuration source before Git or a
# descendant can inspect the checkout.
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_COUNT=0

command -v node >/dev/null 2>&1 || fail "node is required"
command -v git >/dev/null 2>&1 || fail "git is required"

# Resolve the caller-selected temporary root before mktemp can create anything.
# A spelling outside the checkout can still be a symbolic-link alias into it.
tmp_root="${TMPDIR:-/tmp}"
physical_tmp_root="$(cd -- "$tmp_root" 2>/dev/null && pwd -P)" || fail "temporary root is not an accessible directory: $tmp_root"
case "$physical_tmp_root" in
  "$repo"|"$repo"/*) fail "temporary root must be outside physical checkout: $physical_tmp_root" ;;
esac

if [ -z "$base" ]; then
  if git -C "$repo" show-ref --verify --quiet refs/heads/main; then main_ref=main
  elif git -C "$repo" show-ref --verify --quiet refs/remotes/origin/main; then main_ref=origin/main
  else fail "cannot find main or origin/main; pass --base <ref>"
  fi
  base="$(git -C "$repo" merge-base "$main_ref" HEAD)" || fail "cannot find merge-base with $main_ref"
fi

bash "$repo/verification/link-peers.sh"
work="$(mktemp -d "$physical_tmp_root/slate-node-test.XXXXXX")" || fail "cannot create temporary directory"
cleanup() {
  status=$?
  if [ "$status" -eq 0 ]; then
    rm -rf "$work"
  else
    printf 'run-tests: retained failure artifacts at %s\n' "$work" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
lcov="$work/lcov.info"

shopt -s globstar nullglob
test_files=("$repo"/test/**/*.test.ts)
[ "${#test_files[@]}" -gt 0 ] || fail "no test/**/*.test.ts files found"
printf 'run-tests: node --test test/ (%s file(s); LCOV: %s)\n' "${#test_files[@]}" "$lcov"
set +e
(
  # Suppress only Node's package-type inference warning. Adding `type: module`
  # would alter the shipped package, while renaming the required .ts test would
  # complicate discovery and typecheck coverage for no runtime benefit.
  cd "$repo" && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
    --test --experimental-test-coverage \
    --test-coverage-include='extension/**/*.ts' \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=lcov --test-reporter-destination="$lcov" \
    "${test_files[@]}"
)
test_status=$?
set -e
if [ "$test_status" -ne 0 ]; then
  printf 'TEST VERDICT: FAIL — node:test exited %s; coverage gate not run\n' "$test_status"
  exit "$test_status"
fi
[ -s "$lcov" ] || fail "node:test passed but did not produce LCOV at $lcov"
printf 'TEST VERDICT: PASS — node:test exited 0 and emitted %s bytes of LCOV\n' "$(wc -c < "$lcov" | tr -d ' ')"
if [ "$gate" -eq 0 ]; then
  echo "COVERAGE VERDICT: SKIPPED — --no-gate"
  exit 0
fi

printf 'run-tests: coverage gate base=%s head=HEAD lines=%s branches=%s\n' "$base" "$line_threshold" "$branch_threshold"
gate_output="$work/gate.out"
set +e
node "$repo/verification/coverage-gate.mjs" --repo "$repo" --base "$base" --head HEAD \
  --lcov "$lcov" --threshold-lines "$line_threshold" --threshold-branches "$branch_threshold" \
  | tee "$gate_output"
gate_status=${PIPESTATUS[0]}
set -e
if [ "$gate_status" -eq 1 ]; then
  echo "RUN VERDICT: FAIL — tests passed but coverage gate rejected the patch"
  exit 1
fi
if [ "$gate_status" -ne 0 ]; then
  echo "RUN VERDICT: ERROR — coverage infrastructure failed (exit $gate_status)"
  exit "$gate_status"
fi
if grep -q '^VERDICT: WARN —' "$gate_output"; then
  # WARN remains exit 0 because the minimum-denominator policy says "warn
  # instead of fail". It is nevertheless a distinct final outcome that must be
  # reviewed by hand; never collapse it into PASS.
  echo "RUN VERDICT: WARN — tests passed; coverage requires manual review"
  exit 0
fi
if grep -q '^VERDICT: PASS —' "$gate_output"; then
  echo "RUN VERDICT: PASS — tests passed and coverage gate accepted the patch"
  exit 0
fi
echo "RUN VERDICT: FAIL — coverage gate exited 0 without a PASS or WARN verdict"
exit 2
