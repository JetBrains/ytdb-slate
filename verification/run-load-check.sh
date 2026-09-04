#!/usr/bin/env bash
# =============================================================================
# slate — extension-load check (CI)
# =============================================================================
# Proves that pi's runtime loader can LOAD the extension in the checkout under
# test, that its session_start hook runs, and that the dispatch tools and the
# /slate command really got registered — from THIS checkout, not from an
# installed copy. Prints one
#   CHECK <id> <PASS|FAIL> — <detail>
# line per check plus a summary. See verification/README.md.
#
# Usage:
#   bash verification/run-load-check.sh --repo .
#   bash verification/run-load-check.sh                  # --repo defaults to .
#   bash verification/run-load-check.sh --repo . --only L4,L6
#   bash verification/run-load-check.sh --list-checks
#
#   --repo <dir>        slate checkout under test (default: ".")
#   --only <id,id,...>  run a subset of checks; an unknown id is a hard error
#   --list-checks       print the check ids and exit
#
# What it does NOT prove: that anything WORKS. Nothing here executes a tool,
# spawns a worker session, or exercises failover or handoff — it is a load and
# registration check plus one command round-trip. It is not a typecheck either
# (`npm run typecheck` is that): jiti transpiles per module and erases types, so
# a type error loads perfectly well.
#
# Two pi runs, both fully offline: an empty throwaway PI_CODING_AGENT_DIR per run
# (mktemp'd, and carrying no models.json and no auth.json), PI_OFFLINE=1, and
# non-model rpc requests fed from a file so stdin closes at EOF. No provider is
# ever contacted, so no API key is needed.
# THE ENVIRONMENT SCRUB IS A VARIABLE-NAME PATTERN LIST AND NOT AN ALLOWLIST, so
# "no credentials of any kind" is NOT what these runs deliver. It removes every
# pi session variable and every name matching one of the patterns below, and a
# credential under any other name reaches the child: AWS_ACCESS_KEY_ID was
# measured doing exactly that. What holds instead is that the runs have nothing
# to spend a credential on — PI_OFFLINE=1, no models.json, no auth.json, no
# provider request. An allowlist of permitted variables is the stronger design
# and is deliberately deferred.
#   RUN 1  untrusted explicit load path (--no-extensions -e): the loader,
#          session_start, the registrations, and a /slate on round-trip through
#          the command handler
#   RUN 2  trusted explicit load path (--no-extensions -e -a): trust is what
#          makes slate read the checkout's own .pi/slate.json, so this run puts
#          the tracked project config through slate's config sanitizers
# Plus two checks that launch nothing at all. T4 requires the project config to
# be parseable JSON and a JSON object. RUN 2 cannot cover that — slate's config
# loader try/catches a malformed file and falls back to defaults in silence, so
# the sanitizers it feeds are never reached and pi emits nothing. Without T4 a
# checkout whose .pi/slate.json is `{{{` looks perfectly healthy here while every
# setting in it, workflow.draftPRs included, is being dropped. T5 requires the
# tracked .pi/settings.json to carry exactly one local package entry, spelled
# ../../main, and no registry entry for slate.
#
# T5 models pi's package resolution, and it does so with ONE program that borrows
# pi's own isLocalPath and parseGitUrl out of the pi build under test (see
# PKG_MODEL). A hand-written copy of those rules drifted from pi in both
# directions and produced both a false pass and a false failure, so the rules are
# imported and never guessed. When they cannot be imported, T5 FAILS.
#
# THREE CHECKS WERE DELETED HERE, AND THIS HARNESS NO LONGER PROVES THE SIBLING
# ARRANGEMENT. T6 classified the layout of the checkout. T7 loaded a scratch
# sibling package layout through the tracked spelling. T8 counted the copies of
# slate an ordinary session loaded. All three needed the sibling worktree of this
# repository to be present. A plain clone has no sibling, and a CI checkout has no
# sibling, so the three checks established nothing there. On a developer machine
# every pi session in this checkout already proves the same property by running,
# because a session with no slate extension has no /slate command and no dispatch
# tool. The user applied one test: a check earns its place only if it can fail
# somewhere the property is not already proven by use. T6, T7 and T8 failed that
# test, and the user approved removing the goal that the arrangement is proven
# automatically. T5 passes the test, because it reads a tracked file and therefore
# runs in CI and in a plain clone.
#
# WHAT ESTABLISHES THE ARRANGEMENT NOW. Every session in this checkout proves it
# by running. The manual isolated-load smoke test, `pi --no-extensions -e .`,
# proves it on demand. T5 protects the tracked settings entry itself in CI.
# Nothing automatic proves the sibling arrangement any more.
# PI_OFFLINE=1 is MANDATORY on BOTH runs, and on the trusted one above
# all: -a makes pi read .pi/settings.json, and without PI_OFFLINE it
# npm-installs every package listed there — observed hanging for 60 s and
# writing a .pi/npm directory INTO the checkout under test.
#
# The pi CLI is node_modules/.bin/pi from the checkout under test, and its
# --version must equal the @earendil-works/pi-coding-agent pin in package.json's
# devDependencies. There is deliberately NO fallback to a globally installed pi:
# this check must exercise the same pinned SDK the typecheck does. PI_BIN
# overrides the CLI path and says so loudly in the output.
#
# pi itself takes a lock on the checkout's .pi/settings.json while it reads it —
# a transient .pi/settings.json.lock DIRECTORY, created and removed around every
# access, on every run below. No count is stated on purpose: it moves with the
# runs, and a stated count went stale. That is pi's own behaviour, not this
# script's (a bare `pi --no-extensions --mode rpc` with no extension at all does
# it too), so it cannot be avoided without moving off the checkout, which is the
# one thing this check may not do. Instead: cleanup removes the lock if it was
# absent when the script started, and .gitignore covers .pi/*.lock so even a
# killed run cannot leave state a contributor could commit.
#
# When a check fails, the rpc stdout and stderr of each pi run that happened are
# printed after the summary, one delimited section per stream, capped so a
# pathological run cannot flood the log (the cap and the real size are stated
# whenever a section is cut). THOSE SECTIONS ARE BYTE-FAITHFUL: a credential that
# a settings file, a path or a manifest carried reaches the log unredacted there.
# The CHECK and NOTE lines redact every value that came out of a settings file, a
# manifest, a specifier or one of pi's own diagnostics. They do NOT redact
# everything. T4 prints the top-level key names of .pi/slate.json as they stand,
# and the paths this harness was GIVEN or CREATED are printed as they stand too —
# the --repo path, the scratch path and the working
# directory the canary reports. Only a failing run prints the streams, so a green
# CI log holds no stream at all. That inlining is what makes a CI failure
# diagnosable at all: the scratch directory holding the streams dies with the
# job, so the `artifacts:` path it also prints is only ever useful locally. A
# green run prints none of it.
#
# The last result line is a ROSTER AUDIT. It compares the checks that reported
# with the checks that were selected to run, so a deleted, duplicated or crashed
# check block fails the run instead of shrinking the count in silence. The audit
# is itself a result line and is deliberately NOT a selectable check id, so a
# clean full run prints one more line than there are ids in --list-checks.
#
# Exit status: 0 all checks passed · 1 a check failed · 2 refused to start (a
# missing tool — node or mktemp — a bad --repo, no resolvable pi CLI, or a
# CLI/pin version mismatch — that is an out-of-sync environment, not a defect:
# run `npm ci --ignore-scripts`). git is NOT required any more: T6 was the one
# check that needed git evidence, and its deletion took that requirement with it.
# The context header still asks git for the short commit of the checkout, and it
# prints "not a git checkout" when git cannot answer.
# EVERY exit-2 message says "refused to start" in exactly those words, so that
# phrase is greppable in a CI log.
# =============================================================================
set -uo pipefail

exec 8>&2
# One vocabulary for every abort: exit 2 is documented as "refused to start", so
# the message says so too rather than leaving the reader to infer it from the
# status (WC2). Callers pass the reason only.
die() { echo "verification: refused to start — $*" >&8; exit 2; }

ALL_CHECKS="L1 L2 L3 L4 L5 L6 L7 L8 T1 T2 T3 T4 T5"

REPO="."
ONLY=""
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || die "option '--repo' requires a value"; REPO="$2"; shift 2 ;;
		--only) [ "$#" -ge 2 ] || die "option '--only' requires a value"; ONLY="$2"; shift 2 ;;
		--list-checks) printf '%s\n' $ALL_CHECKS; exit 0 ;;
		# The header block is read to its end rather than by a line range: a range
		# went stale every time the header grew.
		-h|--help) awk 'NR > 1 { if (substr($0, 1, 1) != "#") exit; print }' "$0"; exit 0 ;;
		*) die "unknown argument '$1' (try --help)" ;;
	esac
done

# node and mktemp are the required tools. git was required while T6 existed,
# because T6 classified the checkout and compared repositories, and git alone
# answered both questions. No surviving check reads git evidence, so a missing
# git now costs the short commit in the context header and nothing else.
for t in node mktemp; do
	command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"
done

# Validate --only against the known ids: a typo must not select nothing and then
# exit 0 (the same false green run-ladder.sh guards against).
if [ -n "$ONLY" ]; then
	OLD_IFS="$IFS"; IFS=','; set -f
	# shellcheck disable=SC2086
	set -- $ONLY
	IFS="$OLD_IFS"; set +f
	BAD=""
	for id in "$@"; do
		[ -n "$id" ] || continue
		found=0
		for known in $ALL_CHECKS; do [ "$id" = "$known" ] && { found=1; break; }; done
		[ "$found" = 1 ] || BAD="$BAD $id"
	done
	[ -n "$BAD" ] && die "unknown check id(s):$BAD
       known ids: $ALL_CHECKS
       (use --list-checks)"
fi

REPO="$(cd "$REPO" 2>/dev/null && pwd -P)" || die "bad --repo: not a directory"
[ -f "$REPO/extension/index.ts" ] || die "the extension entry point is missing: $REPO/extension/index.ts
       If this IS a slate checkout, that is the defect, not a usage error: pi
       filters a nonexistent entry out of package.json's pi.extensions without
       a word and starts up perfectly happily with no extension loaded."
CANARY="$REPO/verification/ci-canary.ts"
[ -f "$CANARY" ] || die "the positive control is missing: $CANARY
       Without it nothing can observe the registered tool set, so the check
       would silently lose the one assertion that catches removed registrations."
[ -f "$REPO/package.json" ] || die "not a slate checkout: $REPO/package.json is missing"

# --------------------------------------------------------------- the pi CLI --
# node_modules/.bin/pi from the checkout, never a global one: the load check has
# to exercise the very pi the typecheck's devDependency pins. PI_BIN is an escape
# hatch for people who know what they are doing, so it is honoured — and reported
# loudly, because a silently substituted CLI would make every result below mean
# something else. It is NOT a security boundary and is not treated as one:
# anyone who can set it can edit this script.
PIN="$(node -e '
const fs = require("node:fs");
try {
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const v = (m.devDependencies || {})["@earendil-works/pi-coding-agent"];
  if (typeof v === "string") process.stdout.write(v);
} catch {}' "$REPO/package.json")" || die "cannot read $REPO/package.json"
[ -n "$PIN" ] || die "package.json has no @earendil-works/pi-coding-agent devDependency pin,
       so the pi CLI this check runs could not be tied to any declared version."

if [ -n "${PI_BIN:-}" ]; then
	PI="$PI_BIN"
	echo "NOTE   PI_BIN override in use: $PI"
	echo "NOTE   the checkout's own node_modules/.bin/pi was NOT used. This is an escape"
	echo "NOTE   hatch, not a security boundary — every result below describes that CLI."
else
	PI="$REPO/node_modules/.bin/pi"
	[ -x "$PI" ] || die "no pi CLI at $PI
       This check runs the pi pinned by the checkout's devDependencies and never
       falls back to a globally installed one. Remedy: run 'npm ci --ignore-scripts'
       in $REPO (or set PI_BIN=<path to pi> if you know what you are doing)."
fi
[ -x "$PI" ] || die "the pi CLI '$PI' is not executable"

PIVER="$("$PI" --version 2>/dev/null | tr -d '[:space:]')" || die "'$PI --version' failed"
[ -n "$PIVER" ] || die "'$PI --version' printed nothing, so the CLI version could not be checked"
[ "$PIVER" = "$PIN" ] || die "pi CLI/pin version mismatch:
         $PI reports $PIVER
         package.json pins  $PIN
       This is an out-of-sync environment, not a defect: the rpc output shapes
       asserted below are pinned to one pi version. Remedy: run
       'npm ci --ignore-scripts' in $REPO (after a deliberate pin bump, that is
       all this needs)."

# ------------------------------------------------------------- scratch state --
# Artifacts live under the work dir. It is removed on a clean run and KEPT when a
# check failed, so CI has the raw rpc streams to look at.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/slate-loadcheck.XXXXXX")" || die "could not create a scratch directory"
case "$WORK" in
	/*) ;;
	*) die "the scratch directory '$WORK' is not an absolute path" ;;
esac
case "$WORK" in
	"$REPO"|"$REPO"/*) die "the scratch directory '$WORK' is inside the checkout under test
       (TMPDIR points into $REPO) — pi must write nothing there." ;;
esac
# WH1: pi locks the checkout's own project settings file while reading it, and
# the lock is a DIRECTORY inside the working tree. It is pi's, not ours — even a
# bare `pi --no-extensions --mode rpc` with no extension loaded creates it — so
# the only thing this script can do is not leave one behind. It is removed on the
# way out ONLY when it was absent at startup: a lock that was already there
# belongs to somebody else's live session and removing it would corrupt their
# write. .gitignore covers .pi/*.lock for the case where the script is killed
# outright and this trap never runs.
SETTINGS_LOCK="$REPO/.pi/settings.json.lock"
LOCK_PREEXISTING=0
if [ -e "$SETTINGS_LOCK" ]; then
	LOCK_PREEXISTING=1
	echo "NOTE   $SETTINGS_LOCK already exists — another pi session may be writing the"
	echo "NOTE   project settings. Leaving it alone; results below may be affected."
fi
KEEP=0
cleanup() {
	if [ "$LOCK_PREEXISTING" = 0 ] && [ ! -L "$SETTINGS_LOCK" ] && [ -e "$SETTINGS_LOCK" ]; then
		rm -rf "$SETTINGS_LOCK" 2>/dev/null
	fi
	[ "$KEEP" = 1 ] || rm -rf "$WORK"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

# Scrub every inherited provider credential and every pi session variable out of
# the child environment: these runs must not be able to reach a provider even by
# accident, and must not adopt the caller's session. The seed entry keeps the
# array non-empty so "${SCRUB[@]}" is always a valid expansion.
SCRUB=(-u SLATE_LOADCHECK_UNUSED)
while IFS= read -r name; do
	case "$name" in
		*API_KEY*|*_TOKEN|*TOKEN_*|*_SECRET|*_SECRET_*|*CREDENTIALS*|\
		PI_CODING_AGENT|PI_CODING_AGENT_DIR|PI_SESSION_FILE|PI_SESSION_ID|\
		PI_PROVIDER|PI_MODEL|PI_REASONING_LEVEL|PI_KEY|PI_HOST)
			SCRUB+=(-u "$name") ;;
	esac
done < <(compgen -e)

# A hung pi would hang CI. `timeout` is GNU coreutils, so it is used when present
# rather than required — the runs take about a second. Expanded through the
# ${a[@]+...} guard below, which is what makes an EMPTY array legal under `set -u`
# on older bash.
TMO=()
command -v timeout >/dev/null 2>&1 && TMO=(timeout 120)

# ---------------------------------------------------------------- rpc runner --
# One pi launch. A FRESH empty agent dir per run (no models.json and no
# auth.json, so no provider exists to call), requests from a file so stdin is at
# EOF immediately, cwd = the checkout so .pi/ is the project config pi sees.
RC=0
PI_RAN=0
PI_RUNS=()
pirun() { # $1 label, $2 requests file, rest = extra pi args
	local label="$1" reqs="$2"; shift 2
	PI_RAN=1
	PI_RUNS+=("$label")
	local agent="$WORK/agent-$label"
	mkdir -p "$agent" || die "cannot create the throwaway agent dir '$agent'"
	( cd "$REPO" && env "${SCRUB[@]}" PI_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 \
		${TMO[@]+"${TMO[@]}"} "$PI" --no-extensions -e "$REPO" -e "$CANARY" --mode rpc "$@" \
		< "$reqs" ) > "$WORK/$label.out" 2> "$WORK/$label.err"
	RC=$?
}

# Reads one fact out of a captured rpc stream. Every shape this script depends on
# (get_commands responses, extension_ui_request events, extension_error events,
# the canary line) is parsed here and nowhere else. Paths go in as ARGV, never
# interpolated into the program text.
rpcq() { # $1 query, $2 artifact file -> prints the answer, empty when absent
	node -e '
const fs = require("node:fs");
const q = process.argv[1];
let text = "";
try { text = fs.readFileSync(process.argv[2], "utf8"); } catch { process.exit(0); }
// Lines are TRIMMED before they are classified: a JSON line that arrives with
// leading whitespace is still a JSON line, and dropping it would make the
// count-zero queries (ext-errors, warnings) answer "none" out of blindness
// rather than out of evidence (BG1). Every line that looks like JSON and fails
// to parse is counted, so a caller can refuse to trust a stream it cannot read.
const lines = text.split("\n").map((l) => l.trim());
const objs = [];
let unparseable = 0;
for (const l of lines) {
  if (!l.startsWith("{")) continue;
  try { objs.push(JSON.parse(l)); } catch { unparseable++; }
}
const ui = objs.filter((o) => o && o.type === "extension_ui_request");
const canary = [];
for (const l of lines) {
  if (!l.startsWith("CI-CANARY ")) continue;
  try { canary.push(JSON.parse(l.slice("CI-CANARY ".length))); } catch { canary.push(null); }
}
const last = canary.length ? canary[canary.length - 1] : null;
const commands = () => {
  for (const o of objs) if (o && o.type === "response" && o.command === "get_commands" && o.data && Array.isArray(o.data.commands)) return o.data.commands;
  return [];
};
const warnings = ui.filter((o) => o.method === "notify" && o.notifyType === "warning");
const say = (v) => process.stdout.write(String(v));
if (q === "unparseable") say(unparseable);
else if (q === "canary-count") say(canary.length);
else if (q === "canary-tools") say(last && Array.isArray(last.tools) ? last.tools.join(" ") : "");
else if (q === "canary-where") say(last ? [last.cwd, "trusted=" + last.trusted].join(" ") : "");
else if (q === "canary-trusted") say(last ? String(last.trusted) : "");
else if (q === "cmd-path") { const c = commands().find((x) => x && x.name === "slate"); say(c && c.sourceInfo ? String(c.sourceInfo.path) : ""); }
else if (q === "cmd-names") say(commands().map((c) => c && c.name).join(","));
else if (q === "ext-errors") say(objs.filter((o) => o && o.type === "extension_error").length);
else if (q === "ext-error-detail") say(objs.filter((o) => o && o.type === "extension_error").map((o) => [o.extensionPath, o.event, o.error].join(" @ ")).join(" | "));
else if (q === "warnings") say(warnings.length);
else if (q === "warning-detail") say(warnings.map((o) => o.message).join(" | "));
else if (q === "state-entries") say(objs.filter((o) => o && o.type === "entry_appended" && o.entry && o.entry.customType === "slate-state").length);
else if (q === "widget-lines") { let n = 0; for (const o of ui) if (o.method === "setWidget" && o.widgetKey === "slate" && Array.isArray(o.widgetLines)) n = Math.max(n, o.widgetLines.length); say(n); }
else if (q === "prompt-ok") say(objs.some((o) => o && o.type === "response" && o.command === "prompt" && o.success === true) ? "yes" : "no");
else { process.stderr.write("rpcq: unknown query " + q + "\n"); process.exit(3); }
' "$1" "$2"
}

# Every value a check prints that came from a settings file, a manifest, a path
# or a specifier goes through the SAME three credential passes, including the
# ones this script reads back out of pi's own diagnostics. The passes live in the
# shared program (see PKG_MODEL), so there is one implementation and not two.
# Only the inlined rpc streams stay byte-faithful, which the header states.
# PKG_MODEL is assigned further down and this is a function, so the assignment
# is in place long before any check calls it.
redacted() { # $1 raw value -> the value with every credential shape removed
	node -e "$PKG_MODEL" redact "$PI" "$1"
}

# One delimited section of a retained rpc stream, for the CI log. BOUNDED: a
# stream is cut at STREAM_CAP bytes (on a line boundary where one is close
# enough), and a cut section states both the real size and the cap, so nobody
# reads a truncated stream as a whole one. C0 control characters other than tab
# and newline — escape sequences above all — are neutralised on the way out: this
# goes straight into a log, and the harness promises no ANSI anywhere. The bytes
# on disk are untouched, so the artifacts copy stays faithful.
STREAM_CAP=20000
dump_stream() { # $1 section title, $2 stream file
	node -e '
const fs = require("node:fs");
const title = process.argv[1];
const cap = Number(process.argv[3]);
let buf;
try { buf = fs.readFileSync(process.argv[2]); } catch (e) {
  process.stdout.write("---- " + title + " — unavailable: " + (e && e.message ? e.message : String(e)) + " ----\n");
  process.exit(0);
}
if (buf.length === 0) {
  process.stdout.write("---- " + title + " — 0 bytes (empty) ----\n");
  process.exit(0);
}
let body = buf.subarray(0, Math.min(buf.length, cap)).toString("utf8");
let note = "";
if (buf.length > cap) {
  const nl = body.lastIndexOf("\n");
  if (nl > cap / 2) body = body.slice(0, nl);
  note = ", TRUNCATED to the first " + Buffer.byteLength(body) + " (cap " + cap +
         " bytes per stream; the whole stream is in the artifacts directory)";
}
body = body.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
if (!body.endsWith("\n")) body += "\n";
process.stdout.write("---- " + title + " — " + buf.length + " bytes" + note + " ----\n" +
  body + "---- end " + title + " ----\n");
' "$1" "$2" "$STREAM_CAP"
}

# .pi/npm inside the checkout is npm-install debris from a run that was not
# offline. It may legitimately pre-exist (a dogfooding session creates it), so
# what is asserted is that a run did not CREATE or CHANGE it.
#
# BG2: a listing that FAILS must not read as "present with 0 entries". An
# unreadable directory is exactly the state that would hide a difference between
# the before and after samples, so it gets its own answer and the checks that
# compare the samples refuse to pass on it.
npmdir_state() {
	local entries
	if [ ! -d "$REPO/.pi/npm" ]; then printf 'absent'; return 0; fi
	if entries="$(ls -A "$REPO/.pi/npm" 2>/dev/null)"; then
		printf 'present with %s entries' "$(printf '%s\n' "$entries" | grep -c .)"
	else
		printf 'present but UNREADABLE (listing it failed)'
	fi
}

# ---------------------------------------------------------------- bookkeeping
PASS=0; FAIL=0; RAN=0
# Every id that reported, in order, for the roster audit at the end.
REPORTED=""
# The id column is 32 wide across all three check harnesses in verification/: the
# longest id in any of them is 30 characters (route-stored-effort-vocabulary, in
# the resolver checks; 24 in the packaging guards, 6 here), plus two. So their
# output lines up with each other and the verdict column never shifts (CQ1).
check() { # $1 id, $2 condition (0 = pass), $3 detail
	REPORTED="$REPORTED $1"
	if [ "$2" = 0 ]; then PASS=$((PASS+1)); printf 'CHECK %-32s %-4s — %s\n' "$1" "PASS" "$3"
	else FAIL=$((FAIL+1)); printf 'CHECK %-32s %-4s — %s\n' "$1" "FAIL" "$3"; fi
}
want() { # selected by --only?
	if [ -n "$ONLY" ]; then
		case ",$ONLY," in *",$1,"*) ;; *) return 1 ;; esac
	fi
	RAN=$((RAN+1)); return 0
}
run_wanted() { # any of these ids selected?
	local id
	[ -n "$ONLY" ] || return 0
	for id in "$@"; do case ",$ONLY," in *",$id,"*) return 0 ;; esac; done
	return 1
}
# Some disk-only classifiers have an observation to report as well as a verdict.
# They print the single OK/BAD verdict line FIRST and zero or more NOTE lines
# after it. This splits the two apart: NOTE lines go straight to the log in the
# harness NOTE format the classifier already emits, and VERDICT keeps the line
# the caller classifies. A NOTE never moves a verdict.
#
# THE VERDICT IS THE FIRST LINE AND NOTHING ELSE. A settings file, a manifest or
# a directory name can carry a newline, and the earlier reader took the LAST
# non-NOTE line, so a crafted path appended its own "OK ..." line and chose the
# verdict. Anchoring to line one with a strict prefix takes that away: injected
# text can only ever land below the verdict, where it is printed as a note or
# dropped. The classifier sanitizes each field as well, so the two nets overlap.
VERDICT=""
split_verdict() { # $1 classifier output
	local line first=1
	VERDICT=""
	while IFS= read -r line; do
		if [ "$first" = 1 ]; then
			first=0
			case "$line" in
				"OK "*|"BAD "*) VERDICT="$line" ;;
				*) VERDICT="" ;;
			esac
			continue
		fi
		case "$line" in
			NOTE*) printf '%s\n' "$line" ;;
			*) ;;
		esac
	done < <(printf '%s\n' "$1")
}
# The canary line is not a diagnostic, so it is filtered out of both of these.
# Leading whitespace is tolerated for the same reason rpcq trims (BG1): a shifted
# line is still that line.
CANARY_RX='^[[:space:]]*CI-CANARY '
# The line is REDACTED here rather than at each caller: pi prints the paths and
# specifiers it read out of a settings file, so a diagnostic can carry whatever a
# source string carried. Every caller of this helper prints its result.
first_stderr_line() { redacted "$(grep -v "$CANARY_RX" "$1" 2>/dev/null | grep . | head -1)"; }
other_stderr_lines() { grep -cv "$CANARY_RX" "$1" 2>/dev/null | tr -d '[:space:]'; }

# ================================ the package-resolution model (T5) ==========
# ONE program for every check that reads a settings file. The three earlier
# copies of the classifier drifted
# from pi and from each other, so there is now a single program with a mode
# argument, and the classification rules are pi's OWN: it imports isLocalPath
# and parseGitUrl out of the pi build under test.
# That matters because the differences are not
# academic. pi treats `github:x/y`, `git@host:x/y`, `git+https://...`,
# `HTTPS://...` and `file://...` as LOCAL paths, expands `~`, trims a source,
# and only then falls back to a git identity. A hand-written copy of that got
# three of those wrong in one direction and two in the other.
#
# Modes, all called as: node -e "$PKG_MODEL" <mode> <pi CLI> <args...>
#   settings-shape   T5 — the tracked project entry, by exact spelling
#   scratch-guard    the driver — refuse a scratch directory inside the real
#                         agent directory, which this harness may only read
#   redact           any check — put a line pi printed through the same three
#                         credential passes as every field below
# Every mode prints the verdict on line one and NOTE lines after it, and every
# field it prints is redacted and stripped first. The whole output is ASCII
# printable by construction, so nothing read off disk can inject a line. The
# redact mode is the one exception to the verdict shape: it prints the redacted
# value alone, because its caller wants the value and not a verdict.
PKG_MODEL='
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");

const notes = [];
function note(text) { notes.push(String(text)); }
// Each line is stripped of every C0 control byte and DEL on the way out, the
// line break included: a value carrying one would otherwise open a second line
// that the caller could read as a verdict or a note. Printable text above ASCII
// survives, so the em dash of the harness output format does. Field values are
// held to printable ASCII separately by clean().
// The write is a BLOCKING one on the file descriptor, not process.stdout.write:
// stdout is a pipe under a command substitution, and process.exit right after
// an asynchronous write can drop the verdict on the floor.
function emit(verdict) {
  const lines = [String(verdict)].concat(notes.map((n) => "NOTE   " + n));
  const buffer = Buffer.from(lines.map((line) => line.replace(/[\x00-\x1f\x7f]/g, "?")).join("\n") + "\n", "utf8");
  let written = 0;
  while (written < buffer.length) {
    try { written += fs.writeSync(1, buffer, written, buffer.length - written); }
    catch (error) { if (error && error.code === "EAGAIN") continue; throw error; }
  }
}
function ok(detail) { emit("OK " + detail); process.exit(0); }
function bad(detail) { emit("BAD " + detail); process.exit(0); }
function why(error) { return error && error.message ? error.message : String(error); }

// Everything printed below comes from a settings file, a manifest, a path name
// or a specifier, and it all lands in a CI log. FOUR passes remove a
// credential, and every emitted field goes through them:
//   0. every npm: token is rewritten in the SHAPE of a specifier, because the
//      three general passes below read the name@range shape of a specifier as a
//      userinfo: they redact the name, which never holds a secret, and print
//      the range, which is the half a planted token hides in (RG1). The token
//      is then withheld from those passes, so the package name stays readable
//      and the range is redacted unless it really looks like a version range;
//   1. a scheme URL loses its WHOLE userinfo, colon or not, because a bare
//      access token needs no password separator to be a secret. The scheme
//      pattern is case-insensitive by construction and accepts git+https and
//      every other compound scheme;
//   2. any remaining userinfo carrying a colon loses it too. That covers the
//      scp-like form, and it covers a path that a resolver already mangled
//      into base/git+https:/user:token@host/...
//   3. any remaining NON-EMPTY userinfo before an at sign loses it as well.
//      That is the shape the earlier two passes let through (GT4): a bare token
//      with no colon and no scheme, as in ghp_TOKEN@example.com:owner/repo.
// Passes 1 and 2 are greedy up to the next slash, so the LAST at sign of a
// userinfo wins and a password containing an at sign leaves no tail behind.
// Pass 3 requires at least one character before the at sign, so a path segment
// that STARTS with one, /node_modules/@scope/pkg above all, is left intact. The
// three passes together are idempotent: <redacted>@host maps to itself.
//
// Pass 3 also strips the userinfo of a plain git@host source. That is deliberate
// — a user name is never the evidence a reader of this log needs, and the shape
// cannot be told apart from a token without guessing.
function redactGeneric(value) {
  return String(value)
    .replace(/([A-Za-z][A-Za-z0-9+.\-]*:\/\/)[^\s\/]*@/g, "$1<redacted>@")
    .replace(/(^|[\s\/])[^\s\/]*:[^\s\/]*@/g, "$1<redacted>@")
    .replace(/(^|[\s\/])[^\s\/@]+@/g, "$1<redacted>@");
}
// An npm specifier is name@range. A range that looks like a version range is
// kept, and every other range is redacted, because that is where a planted
// token sits.
//
// A DOT-FREE RANGE HAS A LENGTH BOUND, and that bound is the whole of the
// narrowing. Every dot-free range npm accepts is a bare major with an optional
// operator or a leading v, so it is short: 1, 18, ^1, v1, >=18, >=100. A hex
// string and a UUID carry a digit and match the character set, so they printed
// in the clear (G2-5), and they are far longer than any of those. The bound is
// deliberately the ONLY new test: a broader cleaner destroyed a scoped package
// name once and cut a password at the wrong place once, and both defects came
// from a rule that tried to recognise a secret instead of recognising a range.
const NPM_DOTLESS_RANGE_MAX = 5;
function safeNpmRange(range) {
  if (/^(latest|next|beta|alpha|canary)$/.test(range)) return true;
  if (!/[0-9]/.test(range)) return false;
  if (!/^[A-Za-z0-9.+^~><=*\-]*$/.test(range)) return false;
  return range.indexOf(".") >= 0 || range.length <= NPM_DOTLESS_RANGE_MAX;
}
// The NAME half has one test, and it is a test of the npm name shape and not of
// the content: an optional @scope that ALWAYS carries a /name, then a name.
// npm has no specifier whose name is a bare scope, so a token planted in the
// scope position (npm:@ghp_TOKEN@host) fails the shape and is redacted, while
// every legitimate scoped name keeps every character of its name. Both defects
// named above came from redacting a name that HAD the legitimate shape, so this
// test never fires on one.
function safeNpmName(name) { return /^(@[^@\/\s]+\/)?[^@\/\s]+$/.test(name); }
// One npm: token. A scope is honoured, so npm:@scope/name@1.0.0 splits at the
// SECOND at sign and keeps the scope with the name.
function redactNpmToken(token) {
  const body = token.slice(4);
  const cut = body.indexOf("@", 1);
  const name = cut < 0 ? body : body.slice(0, cut);
  const shown = safeNpmName(name) ? name : "<redacted>";
  if (cut < 0) return "npm:" + shown;
  const range = body.slice(cut + 1);
  return "npm:" + shown + "@" + (safeNpmRange(range) ? range : "<redacted>");
}
// A value can EMBED a specifier — a settings entry, a manifest field, and a pi
// diagnostic that names the package it could not load. So the two treatments
// may not overlap: the value is SPLIT on every npm: token, the specifier shape
// governs each token, and the general passes govern the text between the
// tokens. A split can only make the general passes MORE eager, because every
// part starts where they already anchor, so this can never redact less than the
// general passes alone. The four passes together are idempotent.
function redact(value) {
  const text = String(value);
  const token = /npm:[^\s"`,;)\]}]+/g;
  let out = "";
  let last = 0;
  let match;
  while ((match = token.exec(text)) !== null) {
    out += redactGeneric(text.slice(last, match.index)) + redactNpmToken(match[0]);
    last = match.index + match[0].length;
  }
  return out + redactGeneric(text.slice(last));
}
function clean(value) { return redact(value).replace(/[^\x20-\x7e]/g, "?").slice(0, 200); }
// The same passes with a wider window, for a whole diagnostic line that pi
// printed. It is a separate function on purpose: clean() must stay single-
// argument, because it is used as a map callback and a second parameter would
// silently receive the array index.
function cleanLong(value) { return redact(value).replace(/[^\x20-\x7e]/g, "?").slice(0, 400); }
// There is deliberately no separate specifier cleaner any more. One existed
// because the general passes destroyed a package name, and it skipped
// redaction for the range and leaked a token planted there (RG1). Pass 0 of
// redact() now carries the specifier shape, so clean() is safe for a bare
// specifier AND for a diagnostic line that embeds one, and a second
// implementation could only be the weaker of the two.

// The pi build under test owns the classification rules, so they are borrowed
// from it rather than reimplemented. The package root is found by walking up
// from the real path of the CLI, which works for the checkout-local bin symlink
// and for a PI_BIN override alike.
async function loadPi(piBin) {
  let real = String(piBin);
  try { real = fs.realpathSync(real); }
  catch (error) { throw new Error("cannot resolve the pi CLI path " + clean(real) + ": " + why(error)); }
  let dir = path.dirname(real);
  let root = "";
  for (let depth = 0; depth < 16; depth++) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      let name = "";
      try { name = String(JSON.parse(fs.readFileSync(manifest, "utf8")).name || ""); } catch (error) { name = ""; }
      if (name === "@earendil-works/pi-coding-agent") { root = dir; break; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!root) throw new Error("found no @earendil-works/pi-coding-agent package around the pi CLI at " + clean(real));
  const paths = await import(pathToFileURL(path.join(root, "dist", "utils", "paths.js")).href);
  const git = await import(pathToFileURL(path.join(root, "dist", "utils", "git.js")).href);
  const pi = { isLocalPath: paths.isLocalPath, parseGitUrl: git.parseGitUrl, root: root };
  for (const name of ["isLocalPath", "parseGitUrl"]) {
    if (typeof pi[name] !== "function") throw new Error("the pi installation at " + clean(root) + " exports no " + name + " helper");
  }
  return pi;
}

// pi own getAgentDir() (dist/config.js): PI_CODING_AGENT_DIR when that variable
// carries a value, passed through normalizePath() with pi default options, and
// <os.homedir()>/.pi/agent otherwise. normalizePath() with those options
// expands a leading tilde against os.homedir(), turns a file:// URL into a
// path, and changes nothing else.
//
// THE RULE IS REPRODUCED HERE AND NOT BORROWED FROM THE PACKAGE. The
// scratch-directory guard below asks this question on EVERY invocation, and it
// runs before the classification helpers are loaded. Reading the rule out of
// the package made a PI_BIN that names a plain pi binary, with no resolvable
// @earendil-works/pi-coding-agent package around it, refuse every invocation
// with exit 2 (G3-2). The agent-directory rule needs no package.
function agentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  const home = os.homedir();
  if (configured === "~") return home;
  if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) return path.join(home, configured.slice(2));
  if (/^file:\/\//.test(configured)) return fileURLToPath(configured);
  return configured;
}
// os.homedir() and a malformed file:// URL can each throw, so the one caller
// that must never turn a derivation failure into a refusal asks through this.
function safeAgentDir() {
  try { return { path: agentDir() }; }
  catch (error) { return { error: why(error) }; }
}
function sourceOf(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.source === "string") return entry.source;
  return "";
}
function npmName(spec) {
  const match = String(spec).match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  return match && match[1] ? match[1] : String(spec);
}
// pi parseSource, in pi order: an npm prefix on the RAW string, then
// isLocalPath, then a git URL, and a local path as the fallback.
function parseSource(pi, source) {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4).trim();
    return { type: "npm", spec: spec, name: npmName(spec) };
  }
  if (pi.isLocalPath(source)) return { type: "local", path: source };
  const parsed = pi.parseGitUrl(source);
  if (parsed && parsed.host) return { type: "git", host: parsed.host, path: parsed.path || "" };
  return { type: "local", path: source };
}
function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { return { error: "cannot read " + clean(file) + ": " + why(error), code: error && error.code ? error.code : "" }; }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { return { error: clean(file) + " is not parseable JSON (" + why(error) + ")" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : "a " + typeof parsed;
    return { error: clean(file) + " parses, but its top-level value is " + kind + ", not a JSON object" };
  }
  return { parsed: parsed };
}
function realOf(target) { try { return fs.realpathSync(target); } catch (error) { return target; } }

function modeSettingsShape(pi, args) {
  const settings = args[0];
  const expected = args[1];
  const slateName = args[2];
  const read = readSettings(settings);
  if (read.error) bad(read.error + " — this checkout requires a tracked local slate package entry, and pi drops a settings file it cannot read together with every package entry in it, with no diagnostic anywhere");
  const parsed = read.parsed;
  if (!Array.isArray(parsed.packages)) bad(clean(settings) + " has no packages array, so it configures no slate package at all");
  const entries = parsed.packages.map((entry, index) => ({ index: index, entry: entry, source: sourceOf(entry) }));
  const shapeless = entries.filter((item) => !item.source);
  if (shapeless.length) bad(clean(settings) + " has " + shapeless.length + " packages entry/entries that are neither a string nor an object with a string source field, at index/indices " + shapeless.map((item) => item.index).join(", "));
  for (const item of entries) item.parsed = parseSource(pi, item.source);
  const registry = entries.filter((item) => item.parsed.type === "npm" && item.parsed.name === slateName);
  if (registry.length) bad(clean(settings) + " still carries a registry entry for " + slateName + ": " + registry.map((item) => clean(item.source)).join(", ") + " — pi gives a registry entry and a local entry different identities, so it loads both copies and the session exits 1 with a tool conflict");
  const locals = entries.filter((item) => item.parsed.type === "local");
  if (locals.length !== 1) bad("expected exactly one local package entry in " + clean(settings) + ", found " + locals.length + ": " + JSON.stringify(locals.map((item) => clean(item.source))) + " — the classification is pi own isLocalPath, so every source that is not an npm specifier and not a parseable git URL counts here");
  const only = locals[0];
  if (only.source !== expected) bad("the local package entry in " + clean(settings) + " is " + JSON.stringify(clean(only.source)) + ", expected exactly " + JSON.stringify(expected) + " — pi resolves a project local path against the .pi directory, so only that spelling reaches the sibling checkout");
  if (only.entry && typeof only.entry === "object") {
    if (only.entry.autoload === false) bad("the local package entry in " + clean(settings) + " carries autoload: false — pi keeps such an entry as a delta over a user-scope entry and loads no extension from it, so a session here registers no slate tool and says nothing about it");
    const extra = Object.keys(only.entry).filter((key) => key !== "source");
    if (extra.length) bad("the local package entry in " + clean(settings) + " carries the extra key(s) " + extra.map(clean).join(", ") + " — those keys filter what pi loads out of the package, so the tracked entry must be the bare source and nothing else");
  }
  ok(clean(settings) + " carries exactly one local package entry, spelled " + JSON.stringify(clean(only.source)) + ", and no registry entry for " + slateName + " (" + entries.length + " package entry/entries in total)");
}

// THE SCRATCH DIRECTORY MAY NOT SIT INSIDE THE REAL AGENT DIRECTORY EITHER.
// The driver already refuses a scratch directory inside the checkout under
// test. The real agent directory carries the same rule and had no guard, so
// TMPDIR=<agent dir>/scratch wrote every throwaway agent directory, every rpc
// stream and every fixture inside the one directory this harness may only read,
// and a failing run kept them there (G2-3). This mode applies the agent-directory
// rules of the shared program. It compares the real paths as well as the
// spellings.
//
// A DERIVATION FAILURE IS A LOUD PASS, and neither a refusal nor a silent one.
// The caller turns a BAD verdict into exit 2, so a refusal here would stop
// every invocation over a question this harness only asks to protect a
// directory it does not need. A silent pass would hide the missing comparison
// instead. The run therefore continues and states in a NOTE that the
// comparison was not made.
function modeScratchGuard(args) {
  const work = args[0];
  const derived = safeAgentDir();
  if (derived.error) {
    note("the real agent directory could not be derived (" + derived.error + "), so this run did NOT compare the scratch directory with it. Every other guard still applies");
    ok("the scratch directory could not be compared with the real agent directory, and the reason is in the note above");
  }
  const realAgent = derived.path;
  const inside = (child, parent) => child === parent || child.indexOf(parent + path.sep) === 0;
  if (inside(work, realAgent) || inside(realOf(work), realOf(realAgent))) {
    bad("the scratch directory " + clean(work) + " sits inside the real agent directory " + clean(realAgent) + " (TMPDIR points there), and this harness may only READ that directory");
  }
  ok("the scratch directory sits outside the real agent directory " + clean(realAgent));
}

async function main() {
  const mode = process.argv[1];
  const piBin = process.argv[2];
  const args = process.argv.slice(3);
  // The redaction mode is answered BEFORE pi is loaded, on purpose: its caller
  // is usually already reporting a failure, and a value must not stay in
  // cleartext because the helper import happened to break.
  if (mode === "redact") { emit(cleanLong(args.length ? args[0] : "")); return; }
  // The scratch-directory guard is answered before pi is loaded too. It needs
  // the agent-directory rule alone, that rule needs no package, and its caller
  // runs on every invocation: loading the helpers first turned a PI_BIN that
  // names a plain pi binary into a refusal of every run (G3-2).
  if (mode === "scratch-guard") return modeScratchGuard(args);
  let pi;
  try { pi = await loadPi(piBin); }
  catch (error) { bad("the classification helpers of the pi build under test could not be loaded (" + why(error) + ") — this check applies pi own rules and refuses to guess them"); }
  if (mode === "settings-shape") return modeSettingsShape(pi, args);
  bad("unknown package-model mode " + clean(mode));
}
main().catch((error) => { bad("the package model crashed: " + why(error)); });
'

# The two constants the checks above and below share. They lived in three places
# each, so a one-sided edit was invisible (RI5).
SLATE_NAME="ytdb-slate"
PKG_EXPECTED="../../main"

# The scratch directory is guarded against the checkout up where it is created,
# and against the real agent directory here, because this question needs the
# agent-directory rules of the shared program above. It is a REFUSAL and not a
# relocation: TMPDIR comes from the caller, so this is a bad invocation and not a
# defect in the checkout, the checkout guard beside it already refuses, and a
# silent move would hide the misconfiguration while pretending the run was the
# one that was asked for. Nothing but mktemp has written under the scratch
# directory at this point, and the exit trap removes it.
WORKGUARD="$(node -e "$PKG_MODEL" scratch-guard "$PI" "$WORK")"
split_verdict "$WORKGUARD"
case "$VERDICT" in
	"OK "*) ;;
	"BAD "*) die "${VERDICT#BAD }" ;;
	*) die "the scratch directory '$WORK' could not be compared with the real agent directory: the guard printed no verdict line on the first line of its output" ;;
esac

# Context block in run-ladder.sh's format: one `<key> = <value>` line per piece of
# run context, keys padded so the values line up, then a blank line before the
# verdicts (CQ2). "lab" is the ladder's word for the scratch root, used here for
# the same thing.
echo "repo  = $REPO ($(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo 'not a git checkout'))"
echo "pi    = $PI ($PIVER, pinned $PIN)"
echo "lab   = $WORK"
echo

# =============================================================================
# RUN 1 — untrusted load path
# =============================================================================
if run_wanted L1 L2 L3 L4 L5 L6 L7 L8; then
	# Two non-model requests: list the commands (proves WHERE the extension was
	# loaded from) and drive /slate on (proves the command handler runs). Neither
	# reaches a provider, which is why no API key is needed.
	printf '%s\n' '{"id":"1","type":"get_commands"}' '{"id":"2","type":"prompt","message":"/slate on"}' \
		> "$WORK/run1.in" || die "cannot write the rpc request file"
	NPM_BEFORE="$(npmdir_state)"
	pirun run1 "$WORK/run1.in"
	RC1=$RC
	NPM_AFTER="$(npmdir_state)"

	want L1 && {
		if [ "$RC1" = 0 ]; then check L1 0 "pi exited 0 loading the checkout (rpc, offline, empty agent dir, no models.json and no auth.json, environment scrubbed by name pattern)"
		else check L1 1 "pi exited $RC1 — first diagnostic: $(first_stderr_line "$WORK/run1.err")"; fi
	}

	want L2 && {
		# BOTH patterns. The loader marker ('Failed to load extension') is the
		# reported-load-failure channel; the hook marker ('Extension error (') is the
		# one the first is blind to — a session_start throw only ever uses the second.
		# CQ3: the verdict text below names the markers WITHOUT reproducing them, so
		# grepping a CI log for either literal cannot hit a green run.
		M=""
		grep -Fq 'Failed to load extension' "$WORK/run1.err" && M="$M loader-marker"
		grep -Fq 'Extension error (' "$WORK/run1.err" && M="$M hook-marker"
		if [ -z "$M" ]; then check L2 0 "stderr carries neither of pi's two load-failure markers, the loader's and the hook's ($(other_stderr_lines "$WORK/run1.err") other stderr line(s))"
		else check L2 1 "stderr carries load-failure marker(s):$M — $(first_stderr_line "$WORK/run1.err")"; fi
	}

	want L3 && {
		N="$(rpcq ext-errors "$WORK/run1.out")"
		# A stream with lines this script cannot parse is not evidence of absence, so
		# the count-zero verdict is refused rather than granted (BG1).
		U="$(rpcq unparseable "$WORK/run1.out")"
		if [ "$U" != 0 ]; then check L3 1 "$U line(s) of stdout look like JSON but do not parse, so the absence of an extension_error event proves nothing — pi's rpc output is not the shape this script reads"
		elif [ "$N" = 0 ]; then check L3 0 "no extension_error event on stdout (a hook that throws exits 0, so this is the only signal)"
		else check L3 1 "$N extension_error event(s) on stdout: $(redacted "$(rpcq ext-error-detail "$WORK/run1.out")")"; fi
	}

	# The canary writes to stderr, which rpc mode keeps separate from its stdout
	# protocol stream — so the tool set is read from the stderr artifact.
	TOOLS="$(rpcq canary-tools "$WORK/run1.err")"
	want L4 && {
		MISSING=""
		for t in thread threads episode; do
			case " $TOOLS " in *" $t "*) ;; *) MISSING="$MISSING $t" ;; esac
		done
		if [ -z "$MISSING" ]; then check L4 0 "the canary observed all three dispatch tools registered: thread, threads, episode"
		else check L4 1 "dispatch tool(s) NOT registered:$MISSING — the canary observed [$TOOLS]. Nothing else detects this: pi exits 0 with an empty stderr and a working /slate command."; fi
	}

	want L5 && {
		C="$(rpcq canary-count "$WORK/run1.err")"
		if [ "$C" = 0 ]; then check L5 1 "the canary printed no CI-CANARY line at all — it did not load, so every tool-set assertion above is void"
		elif [ -z "$TOOLS" ]; then check L5 1 "the canary reported an EMPTY tool list ($(rpcq canary-where "$WORK/run1.err")) — either nothing registered, or session_start now runs before registration"
		else check L5 0 "the canary reported $(printf '%s' "$TOOLS" | wc -w | tr -d '[:space:]') registered tool(s) from $(rpcq canary-where "$WORK/run1.err")"; fi
	}

	want L6 && {
		P="$(rpcq cmd-path "$WORK/run1.out")"
		# The raw value decides, the redacted one is printed.
		if [ -z "$P" ]; then check L6 1 "no /slate command in the rpc command listing (got: $(redacted "$(rpcq cmd-names "$WORK/run1.out")")) — slate registered nothing"
		else
			PSAFE="$(redacted "$P")"
			case "$P" in
				"$REPO"/*) check L6 0 "/slate is registered and attributed to $PSAFE — inside the checkout under test, so this run exercised the working tree and not an installed release" ;;
				*) check L6 1 "/slate is attributed to $PSAFE, which is OUTSIDE the checkout under test ($REPO) — the check exercised some other copy of slate" ;;
			esac
		fi
	}

	want L7 && {
		OK="$(rpcq prompt-ok "$WORK/run1.out")"
		E="$(rpcq state-entries "$WORK/run1.out")"
		W="$(rpcq widget-lines "$WORK/run1.out")"
		if [ "$OK" != yes ]; then check L7 1 "the /slate on request did not complete successfully (prompt response missing or success=false)"
		elif [ "$E" = 0 ]; then check L7 1 "/slate on appended no slate-state entry — the command handler did not reach the state store"
		elif [ "$W" = 0 ]; then check L7 1 "/slate on left the slate widget empty (no setWidget carrying widgetLines)"
		else check L7 0 "/slate on ran offline through the command handler: $E slate-state entry/entries appended, widget populated with $W line(s)"; fi
	}

	want L8 && {
		case "$NPM_BEFORE$NPM_AFTER" in
			*UNREADABLE*) check L8 1 ".pi/npm in the checkout could not be listed ($NPM_BEFORE -> $NPM_AFTER) — while it is unreadable this check cannot tell whether the run wrote there, so it must not report success" ;;
			*) if [ "$NPM_BEFORE" = "$NPM_AFTER" ]; then check L8 0 ".pi/npm in the checkout unchanged by this run ($NPM_AFTER) — the run stayed offline"
			   else check L8 1 ".pi/npm in the checkout changed: $NPM_BEFORE -> $NPM_AFTER — pi npm-installed into the working tree, so the run was not offline"; fi ;;
		esac
	}
fi

# =============================================================================
# RUN 2 — trusted config-sanitizer path
# =============================================================================
# -a is what makes ctx.isProjectTrusted() true, and slate only reads
# .pi/slate.json for a trusted project — so this is the run that puts the
# checkout's own tracked project config through slate's sanitizers. Still
# PI_OFFLINE=1: -a also makes pi read .pi/settings.json and it would otherwise
# npm-install every package listed there, into the checkout.
if run_wanted T1 T2 T3; then
	printf '%s\n' '{"id":"1","type":"get_commands"}' > "$WORK/run2.in" || die "cannot write the rpc request file"
	NPM_BEFORE2="$(npmdir_state)"
	pirun run2 "$WORK/run2.in" -a
	RC2=$RC
	NPM_AFTER2="$(npmdir_state)"

	want T1 && {
		# Also the vacuity guard for T2: if -a did not actually grant trust, slate
		# never read .pi/slate.json and a clean T2 would mean nothing.
		TR="$(rpcq canary-trusted "$WORK/run2.err")"
		if [ "$RC2" != 0 ]; then check T1 1 "pi exited $RC2 on the trusted (-a) run — first diagnostic: $(first_stderr_line "$WORK/run2.err")"
		elif [ "$TR" != true ]; then check T1 1 "pi exited 0 but the canary reports trusted=${TR:-<no canary line>} — -a did not grant project trust, so slate never read .pi/slate.json and T2 below proves nothing"
		else check T1 0 "pi exited 0 on the trusted (-a) run, still offline, project trusted ($(rpcq canary-where "$WORK/run2.err"))"; fi
	}

	# TQ2 pins the one intentional warning from this checkout's retained ignored
	# writing keys. Any missing, additional, or different warning still fails, so a
	# malformed modelFailover, contextBudget, workerExtensions, or writing value
	# cannot hide behind the expected notice. T4 separately covers JSON shape.
	want T2 && {
		N="$(rpcq warnings "$WORK/run2.out")"
		U="$(rpcq unparseable "$WORK/run2.out")"
		DETAIL="$(rpcq warning-detail "$WORK/run2.out")"
		EXPECTED='slate: writing.check and writing.remind are ignored writing keys. Remove them from slate.json. Slate controls writing checks and reminders automatically for trusted projects in orchestrator mode.'
		if [ "$U" != 0 ]; then check T2 1 "$U line(s) of stdout look like JSON but do not parse, so a warning notification could have been missed rather than absent"
		elif [ "$N" = 1 ] && [ "$DETAIL" = "$EXPECTED" ]; then check T2 0 "the trusted config emitted exactly the expected ignored writing keys notice and no sanitizer fault"
		else check T2 1 "$N warning notification(s) did not equal the one expected ignored writing keys notice: $(redacted "$DETAIL")"; fi
	}

	want T3 && {
		case "$NPM_BEFORE2$NPM_AFTER2" in
			*UNREADABLE*) check T3 1 ".pi/npm in the checkout could not be listed ($NPM_BEFORE2 -> $NPM_AFTER2) — while it is unreadable this check cannot tell whether the trusted run wrote there" ;;
			*) if [ "$NPM_BEFORE2" = "$NPM_AFTER2" ]; then check T3 0 ".pi/npm in the checkout unchanged by the trusted run ($NPM_AFTER2) — PI_OFFLINE held"
			   else check T3 1 ".pi/npm in the checkout changed: $NPM_BEFORE2 -> $NPM_AFTER2 — the trusted run npm-installed into the working tree"; fi ;;
		esac
	}
fi

# =============================================================================
# PROJECT CONFIG — read straight off disk, no pi involved
# =============================================================================
# The gap T2 cannot close (TQ2). slate's loadConfig() wraps the read and the
# JSON.parse in a try/catch and requires a non-null, non-array object; anything
# else returns {} and the session continues on defaults with NOTHING emitted — no
# warning, no error, no event. So a checkout can dogfood with its whole project
# config dropped and every check that watches pi's output stays green. This reads
# the file itself instead, which needs no pi, no session and no trust.
#
# It asserts exactly two things: the file parses as JSON, and its top-level value
# is an object. It deliberately does NOT judge the contents — unknown keys and
# wrong-typed values are a separate concern, and the three keys that do have
# sanitizers are T2's business.
if run_wanted T4; then
	want T4 && {
		CFG="$REPO/.pi/slate.json"
		if [ ! -e "$CFG" ]; then
			# Optional for a consumer: no project config is a valid state, not a defect.
			check T4 0 "no $CFG — a project config is optional, so there is nothing to parse"
		else
			CFGV="$(node -e '
const fs = require("node:fs");
const f = process.argv[1];
const say = (v) => process.stdout.write(v);
let text;
try { text = fs.readFileSync(f, "utf8"); } catch (e) {
  say("BAD cannot read " + f + ": " + (e && e.message ? e.message : String(e)));
  process.exit(0);
}
let parsed;
try { parsed = JSON.parse(text); } catch (e) {
  say("BAD " + f + " is not parseable JSON (" + (e && e.message ? e.message : String(e)) +
      ") — the slate config loader catches exactly this and falls back to defaults in silence, so every setting in the file is being ignored with no diagnostic anywhere");
  process.exit(0);
}
const kind = parsed === null ? "null"
  : Array.isArray(parsed) ? "an array"
  : typeof parsed === "object" ? "an object"
  : "a " + typeof parsed + " (" + JSON.stringify(parsed).slice(0, 40) + ")";
if (kind !== "an object") {
  say("BAD " + f + " parses, but its top-level value is " + kind + ", not a JSON object — slate requires a plain object and silently falls back to defaults for anything else");
  process.exit(0);
}
const keys = Object.keys(parsed).map((k) => k.replace(/[^\x20-\x7e]/g, "?").slice(0, 40));
say("OK " + f + " parses as a JSON object, " + keys.length + " top-level key(s): " +
    (keys.slice(0, 8).join(", ") || "none") + (keys.length > 8 ? ", …" : ""));
' "$CFG")"
			case "$CFGV" in
				"OK "*) check T4 0 "${CFGV#OK }" ;;
				"BAD "*) check T4 1 "${CFGV#BAD }" ;;
				*) check T4 1 "could not classify $CFG — the reader printed ${CFGV:-<nothing>}" ;;
			esac
		fi
	}
fi

# =============================================================================
# PROJECT PACKAGE SETTINGS, SHAPE — read straight off disk, no pi session
# =============================================================================
# pi drops an unparseable settings file in silence, and it drops a package entry
# that resolves nowhere in silence too, so no pi run can report either. T5 reads
# the tracked file itself instead. It asserts the committed dogfood spelling,
# because that literal string is what this checkout depends on: the entry must
# be the single local path ../../main, and no registry entry for slate may sit
# beside it. pi gives an npm entry and a local entry different identities, so a
# leftover registry pin does not replace the local entry — it joins it, and both
# copies load.
#
# T5 is the ONE check that owns the literal spelling, and it is now the only
# check that reads that file at all. T6 and T7 read the value out of the file
# beside it, and both were deleted with the sibling-worktree goal (see the
# header).
#
# The entry must also be the bare source. pi treats an entry carrying
# autoload: false as a delta over a user-scope entry and loads nothing from it,
# and the other filter keys narrow what it loads, so either shape gives a
# session with no slate in it and no diagnostic (RI4).
#
# A missing or unparseable file is a FAIL and never a refusal: this repository
# requires the entry, so its absence is the defect the check exists to report.
if run_wanted T5; then
	want T5 && {
		PKG_SETTINGS="$REPO/.pi/settings.json"
		T5OUT="$(node -e "$PKG_MODEL" settings-shape "$PI" "$PKG_SETTINGS" "$PKG_EXPECTED" "$SLATE_NAME")"
		split_verdict "$T5OUT"
		case "$VERDICT" in
			"OK "*) check T5 0 "${VERDICT#OK }" ;;
			"BAD "*) check T5 1 "${VERDICT#BAD }" ;;
			*) check T5 1 "could not classify $PKG_SETTINGS — the reader printed no verdict line on the first line of its output" ;;
		esac
	}
fi

echo
# GT5: the failure for this state belongs to the ROSTER LINE and to nothing else.
# An added count with no result line behind it made the summary report a failure
# that no printed line matched. The roster audit below owns the verdict, so the
# printed lines and the arithmetic agree and the exit code still says 1.
if [ "$RAN" -eq 0 ]; then
	echo "verification: NO CHECK RAN. --only='$ONLY' matched nothing, so this run proves nothing." >&8
fi

# ---------------------------------------------------------- the roster audit --
# The last result line, and the only one that watches the other lines. Deleting
# a whole check block from this script used to shrink the count and exit 0, so a
# lost check read as a clean run. The audit compares the ids that REPORTED with
# the ids that were SELECTED, and a missing, duplicated or unexpected id fails
# the run. It follows the pattern of the two sibling harnesses in verification/.
#
# The audit reports itself, so a clean full run prints one more line than there
# are ids in --list-checks, and the summary states that identity rather than
# leaving an unexplained difference in the one mechanism whose job is counting.
EXPECTED_IDS=""
for id in $ALL_CHECKS; do
	if [ -n "$ONLY" ]; then
		case ",$ONLY," in *",$id,"*) ;; *) continue ;; esac
	fi
	EXPECTED_IDS="$EXPECTED_IDS $id"
done
EXPECTED_COUNT=0
MISSING_IDS=""
DUPLICATE_IDS=""
UNEXPECTED_IDS=""
for id in $EXPECTED_IDS; do
	EXPECTED_COUNT=$((EXPECTED_COUNT+1))
	seen=0
	for reported in $REPORTED; do [ "$reported" = "$id" ] && seen=$((seen+1)); done
	[ "$seen" -eq 0 ] && MISSING_IDS="$MISSING_IDS $id"
	[ "$seen" -gt 1 ] && DUPLICATE_IDS="$DUPLICATE_IDS $id"
done
for reported in $REPORTED; do
	known=0
	for id in $EXPECTED_IDS; do [ "$reported" = "$id" ] && known=1; done
	[ "$known" = 0 ] && UNEXPECTED_IDS="$UNEXPECTED_IDS $reported"
done
# Read BEFORE the audit reports itself, so both sides exclude it.
COUNTED=$((PASS+FAIL))
ROSTER_FAULT=""
# A subset that selects NO check is a defect and not an empty success: the audit
# would otherwise report that all zero selected checks reported exactly once, and
# the run would exit 0 having proved nothing (GT5).
[ "$EXPECTED_COUNT" -eq 0 ] && ROSTER_FAULT="$ROSTER_FAULT no check was selected at all, so nothing was measured."
[ -n "$MISSING_IDS" ] && ROSTER_FAULT="$ROSTER_FAULT never reported:$MISSING_IDS."
[ -n "$DUPLICATE_IDS" ] && ROSTER_FAULT="$ROSTER_FAULT reported more than once:$DUPLICATE_IDS."
[ -n "$UNEXPECTED_IDS" ] && ROSTER_FAULT="$ROSTER_FAULT reported without being selected:$UNEXPECTED_IDS."
if [ -n "$ROSTER_FAULT" ]; then
	check roster 1 "the selected checks and the reported checks disagree —$ROSTER_FAULT A deleted, duplicated or crashed check block cannot pass silently, so this run proves nothing about the ids named here"
else
	check roster 0 "all $EXPECTED_COUNT selected check(s) reported exactly once ($COUNTED result line(s) before this audit)"
fi

RESULT_LINES=$((PASS+FAIL))
UNACCOUNTED=$((RESULT_LINES-EXPECTED_COUNT-1))
RECONCILE="$RESULT_LINES result lines = $EXPECTED_COUNT selected checks + this roster audit"
[ "$UNACCOUNTED" -ne 0 ] && RECONCILE="$RECONCILE, $UNACCOUNTED unaccounted — see the roster line"
echo "== summary: $PASS pass, $FAIL fail ($RECONCILE) =="

# Only when something failed, and only when a pi run actually produced streams:
# T4, T5 and the roster start no pi run, so a static-only failure has nothing to
# show and must not print empty sections (nor keep an empty directory).
if [ "$FAIL" -ne 0 ] && [ "$PI_RAN" = 1 ]; then
	KEEP=1
	echo
	echo "rpc streams below, inlined because a CI scratch directory does not outlive the"
	echo "job — the artifacts path at the end is only reachable on the machine that ran."
	for label in ${PI_RUNS[@]+"${PI_RUNS[@]}"}; do
		case "$label" in
			run1) title="run1 (the untrusted load run)" ;;
			run2) title="run2 (the trusted config run, -a)" ;;
			*) title="$label" ;;
		esac
		# stderr first: pi puts its own diagnostics and the canary line there.
		dump_stream "$title stderr" "$WORK/$label.err"
		dump_stream "$title stdout" "$WORK/$label.out"
	done
	echo "artifacts: $WORK (raw rpc streams, kept because a check failed)"
fi
[ "$FAIL" -eq 0 ]
