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
# Two pi runs, both fully offline and both without credentials of any kind: a
# throwaway PI_CODING_AGENT_DIR (mktemp'd and EMPTY — no models.json, no
# auth.json), PI_OFFLINE=1, --no-extensions, and non-model rpc requests fed from
# a file so stdin closes at EOF. No provider is ever contacted, so no API key is
# needed — and none is passed: inherited credentials and pi session variables are
# scrubbed out of the child environment.
#   RUN 1  untrusted load path: the loader, session_start, the registrations, and
#          a /slate on round-trip through the command handler
#   RUN 2  trusted (-a) path: trust is what makes slate read the checkout's own
#          .pi/slate.json, so this run puts the tracked project config through
#          slate's config sanitizers
# Plus one check that launches nothing at all (T4): the project config file must
# be parseable JSON and a JSON object. RUN 2 cannot cover that — slate's config
# loader try/catches a malformed file and falls back to defaults in silence, so
# the sanitizers it feeds are never reached and pi emits nothing. Without T4 a
# checkout whose .pi/slate.json is `{{{` looks perfectly healthy here while every
# setting in it, workflow.draftPRs included, is being dropped.
# PI_OFFLINE=1 is MANDATORY on BOTH runs, and on RUN 2 above all: -a makes pi
# read .pi/settings.json, and without PI_OFFLINE it npm-installs every package
# listed there — observed hanging for 60 s and writing a .pi/npm directory INTO
# the checkout under test.
#
# The pi CLI is node_modules/.bin/pi from the checkout under test, and its
# --version must equal the @earendil-works/pi-coding-agent pin in package.json's
# devDependencies. There is deliberately NO fallback to a globally installed pi:
# this check must exercise the same pinned SDK the typecheck does. PI_BIN
# overrides the CLI path and says so loudly in the output.
#
# pi itself takes a lock on the checkout's .pi/settings.json while it reads it —
# a transient .pi/settings.json.lock DIRECTORY, created and removed around every
# access, four times over the two runs. That is pi's own behaviour, not this
# script's (a bare `pi --no-extensions --mode rpc` with no extension at all does
# it too), so it cannot be avoided without moving off the checkout, which is the
# one thing this check may not do. Instead: cleanup removes the lock if it was
# absent when the script started, and .gitignore covers .pi/*.lock so even a
# killed run cannot leave state a contributor could commit.
#
# When a check fails, the rpc stdout and stderr of each pi run that happened are
# printed after the summary, one delimited section per stream, capped so a
# pathological run cannot flood the log (the cap and the real size are stated
# whenever a section is cut). That inlining is what makes a CI failure
# diagnosable at all: the scratch directory holding the streams dies with the
# job, so the `artifacts:` path it also prints is only ever useful locally. A
# green run prints none of it.
#
# Exit status: 0 all checks passed · 1 a check failed · 2 refused to start (a
# missing tool, a bad --repo, no resolvable pi CLI, or a CLI/pin version
# mismatch — that is an out-of-sync environment, not a defect: run
# `npm ci --ignore-scripts`).
# EVERY exit-2 message says "refused to start" in exactly those words, so that
# phrase is greppable in a CI log.
# =============================================================================
set -uo pipefail

exec 8>&2
# One vocabulary for every abort: exit 2 is documented as "refused to start", so
# the message says so too rather than leaving the reader to infer it from the
# status (WC2). Callers pass the reason only.
die() { echo "verification: refused to start — $*" >&8; exit 2; }

ALL_CHECKS="L1 L2 L3 L4 L5 L6 L7 L8 T1 T2 T3 T4"

REPO="."
ONLY=""
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || die "option '--repo' requires a value"; REPO="$2"; shift 2 ;;
		--only) [ "$#" -ge 2 ] || die "option '--only' requires a value"; ONLY="$2"; shift 2 ;;
		--list-checks) printf '%s\n' $ALL_CHECKS; exit 0 ;;
		-h|--help) sed -n '2,79p' "$0"; exit 0 ;;
		*) die "unknown argument '$1' (try --help)" ;;
	esac
done

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
# The id column is 32 wide across all three check harnesses in verification/: the
# longest id in any of them is 30 characters (route-stored-effort-vocabulary, in
# the resolver checks; 24 in the packaging guards, 2 here), plus two. So their
# output lines up with each other and the verdict column never shifts (CQ1).
check() { # $1 id, $2 condition (0 = pass), $3 detail
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
# The canary line is not a diagnostic, so it is filtered out of both of these.
# Leading whitespace is tolerated for the same reason rpcq trims (BG1): a shifted
# line is still that line.
CANARY_RX='^[[:space:]]*CI-CANARY '
first_stderr_line() { grep -v "$CANARY_RX" "$1" 2>/dev/null | grep . | head -1; }
other_stderr_lines() { grep -cv "$CANARY_RX" "$1" 2>/dev/null | tr -d '[:space:]'; }

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
	# reaches a provider, which is why no credentials are needed.
	printf '%s\n' '{"id":"1","type":"get_commands"}' '{"id":"2","type":"prompt","message":"/slate on"}' \
		> "$WORK/run1.in" || die "cannot write the rpc request file"
	NPM_BEFORE="$(npmdir_state)"
	pirun run1 "$WORK/run1.in"
	RC1=$RC
	NPM_AFTER="$(npmdir_state)"

	want L1 && {
		if [ "$RC1" = 0 ]; then check L1 0 "pi exited 0 loading the checkout (rpc, offline, empty agent dir, no credentials)"
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
		else check L3 1 "$N extension_error event(s) on stdout: $(rpcq ext-error-detail "$WORK/run1.out")"; fi
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
		if [ -z "$P" ]; then check L6 1 "no /slate command in the rpc command listing (got: $(rpcq cmd-names "$WORK/run1.out")) — slate registered nothing"
		else
			case "$P" in
				"$REPO"/*) check L6 0 "/slate is registered and attributed to $P — inside the checkout under test, so this run exercised the working tree and not an installed release" ;;
				*) check L6 1 "/slate is attributed to $P, which is OUTSIDE the checkout under test ($REPO) — the check exercised some other copy of slate" ;;
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

	# TQ2: this asserts ONE thing — that slate's sanitizers emitted no warning — and
	# the wording says so. Only three keys have sanitizers that warn (modelFailover,
	# contextBudget, workerExtensions); everything else in the file, and the file's
	# syntax and shape, is outside what a warning can ever report. T4 covers the
	# syntax and shape; nothing here covers unknown keys or wrong-typed values for
	# the unsanitized ones.
	want T2 && {
		N="$(rpcq warnings "$WORK/run2.out")"
		U="$(rpcq unparseable "$WORK/run2.out")"
		if [ "$U" != 0 ]; then check T2 1 "$U line(s) of stdout look like JSON but do not parse, so a warning notification could have been missed rather than absent"
		elif [ "$N" = 0 ]; then check T2 0 "slate's config sanitizers emitted no warning for the checkout's own .pi/slate.json (they cover the shape of modelFailover, contextBudget and workerExtensions only — not the file's syntax, which is T4, nor any other key)"
		else check T2 1 "$N warning notification(s) from slate's config sanitizers on .pi/slate.json: $(rpcq warning-detail "$WORK/run2.out")"; fi
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

echo
if [ "$RAN" -eq 0 ]; then
	echo "verification: NO CHECK RAN. --only='$ONLY' matched nothing, so this run proves nothing." >&8
	FAIL=$((FAIL+1))
fi
echo "== summary: $PASS pass, $FAIL fail =="

# Only when something failed, and only when a pi run actually produced streams:
# T4 needs no pi, so a T4-only failure has nothing to show and must not print
# empty sections (nor keep an empty directory).
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
