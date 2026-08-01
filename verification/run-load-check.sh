#!/usr/bin/env bash
# =============================================================================
# slate — extension-load check (tier-1 CI)
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
# Exit status: 0 all checks passed · 1 a check failed · 2 refused to start (a
# missing tool, a bad --repo, no resolvable pi CLI, or a CLI/pin version
# mismatch — that is an out-of-sync environment, not a defect: run `npm ci`).
# =============================================================================
set -uo pipefail

exec 8>&2
die() { echo "verification: $*" >&8; exit 2; }

ALL_CHECKS="L1 L2 L3 L4 L5 L6 L7 L8 T1 T2 T3"

REPO="."
ONLY=""
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || die "option '--repo' requires a value"; REPO="$2"; shift 2 ;;
		--only) [ "$#" -ge 2 ] || die "option '--only' requires a value"; ONLY="$2"; shift 2 ;;
		--list-checks) printf '%s\n' $ALL_CHECKS; exit 0 ;;
		-h|--help) sed -n '2,53p' "$0"; exit 0 ;;
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
       falls back to a globally installed one. Remedy: run 'npm ci' in $REPO
       (or set PI_BIN=<path to pi> if you know what you are doing)."
fi
[ -x "$PI" ] || die "the pi CLI '$PI' is not executable"

PIVER="$("$PI" --version 2>/dev/null | tr -d '[:space:]')" || die "'$PI --version' failed"
[ -n "$PIVER" ] || die "'$PI --version' printed nothing, so the CLI version could not be checked"
[ "$PIVER" = "$PIN" ] || die "refused to start — pi CLI/pin version mismatch:
         $PI reports $PIVER
         package.json pins  $PIN
       This is an out-of-sync environment, not a defect: the rpc output shapes
       asserted below are pinned to one pi version. Remedy: run 'npm ci' in
       $REPO (after a deliberate pin bump, that is all this needs)."

# ------------------------------------------------------------- scratch state --
# Artifacts live under the work dir. It is removed on a clean run and KEPT when a
# check failed, so CI has the raw rpc streams to look at.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/slate-loadcheck.XXXXXX")" || die "could not create a scratch directory"
case "$WORK" in
	/*) ;;
	*) die "the scratch directory '$WORK' is not an absolute path" ;;
esac
case "$WORK" in
	"$REPO"|"$REPO"/*) die "refusing to run: the scratch directory '$WORK' is inside the checkout under test
       (TMPDIR points into $REPO) — pi must write nothing there." ;;
esac
KEEP=0
cleanup() { [ "$KEEP" = 1 ] || rm -rf "$WORK"; }
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
pirun() { # $1 label, $2 requests file, rest = extra pi args
	local label="$1" reqs="$2"; shift 2
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
const lines = text.split("\n");
const objs = [];
for (const l of lines) { if (l.charAt(0) !== "{") continue; try { objs.push(JSON.parse(l)); } catch {} }
const ui = objs.filter((o) => o && o.type === "extension_ui_request");
const canary = [];
for (const l of lines) {
  if (l.indexOf("CI-CANARY ") !== 0) continue;
  try { canary.push(JSON.parse(l.slice("CI-CANARY ".length))); } catch { canary.push(null); }
}
const last = canary.length ? canary[canary.length - 1] : null;
const commands = () => {
  for (const o of objs) if (o && o.type === "response" && o.command === "get_commands" && o.data && Array.isArray(o.data.commands)) return o.data.commands;
  return [];
};
const warnings = ui.filter((o) => o.method === "notify" && o.notifyType === "warning");
const say = (v) => process.stdout.write(String(v));
if (q === "canary-count") say(canary.length);
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

# .pi/npm inside the checkout is npm-install debris from a run that was not
# offline. It may legitimately pre-exist (a dogfooding session creates it), so
# what is asserted is that a run did not CREATE or CHANGE it.
npmdir_state() {
	if [ -d "$REPO/.pi/npm" ]; then
		printf 'present with %s entries' "$(ls -A "$REPO/.pi/npm" 2>/dev/null | wc -l | tr -d '[:space:]')"
	else printf 'absent'; fi
}

# ---------------------------------------------------------------- bookkeeping
PASS=0; FAIL=0; RAN=0
check() { # $1 id, $2 condition (0 = pass), $3 detail
	if [ "$2" = 0 ]; then PASS=$((PASS+1)); printf 'CHECK %-16s %-4s — %s\n' "$1" "PASS" "$3"
	else FAIL=$((FAIL+1)); printf 'CHECK %-16s %-4s — %s\n' "$1" "FAIL" "$3"; fi
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
first_stderr_line() { grep -v '^CI-CANARY ' "$1" 2>/dev/null | grep . | head -1; }

echo "repo  = $REPO ($(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo 'not a git checkout'))"
echo "pi    = $PI ($PIVER, pinned $PIN)"
echo "work  = $WORK"
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
		# BOTH patterns. "Failed to load extension" is the reported-load-failure
		# channel; "Extension error (" is the hook channel, which the first is blind
		# to — and a session_start throw only ever uses the second.
		M=""
		grep -Fq 'Failed to load extension' "$WORK/run1.err" && M="$M 'Failed to load extension'"
		grep -Fq 'Extension error (' "$WORK/run1.err" && M="$M 'Extension error ('"
		if [ -z "$M" ]; then check L2 0 "stderr carries neither 'Failed to load extension' nor 'Extension error (' ($(grep -cv '^CI-CANARY ' "$WORK/run1.err" | tr -d '[:space:]') other stderr line(s))"
		else check L2 1 "stderr carries load-failure marker(s):$M — $(first_stderr_line "$WORK/run1.err")"; fi
	}

	want L3 && {
		N="$(rpcq ext-errors "$WORK/run1.out")"
		if [ "$N" = 0 ]; then check L3 0 "no extension_error event on stdout (a hook that throws exits 0, so this is the only signal)"
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
		if [ "$NPM_BEFORE" = "$NPM_AFTER" ]; then check L8 0 ".pi/npm in the checkout unchanged by this run ($NPM_AFTER) — the run stayed offline"
		else check L8 1 ".pi/npm in the checkout changed: $NPM_BEFORE -> $NPM_AFTER — pi npm-installed into the working tree, so the run was not offline"; fi
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

	want T2 && {
		N="$(rpcq warnings "$WORK/run2.out")"
		if [ "$N" = 0 ]; then check T2 0 "slate's config sanitizers accepted the checkout's own .pi/slate.json with no warning notification"
		else check T2 1 "$N warning notification(s) from slate's config sanitizers on .pi/slate.json: $(rpcq warning-detail "$WORK/run2.out")"; fi
	}

	want T3 && {
		if [ "$NPM_BEFORE2" = "$NPM_AFTER2" ]; then check T3 0 ".pi/npm in the checkout unchanged by the trusted run ($NPM_AFTER2) — PI_OFFLINE held"
		else check T3 1 ".pi/npm in the checkout changed: $NPM_BEFORE2 -> $NPM_AFTER2 — the trusted run npm-installed into the working tree"; fi
	}
fi

echo
if [ "$RAN" -eq 0 ]; then
	echo "verification: NO CHECK RAN. --only='$ONLY' matched nothing, so this run proves nothing." >&8
	FAIL=$((FAIL+1))
fi
echo "== summary: $PASS pass, $FAIL fail =="
if [ "$FAIL" -ne 0 ]; then
	KEEP=1
	echo "artifacts kept (raw rpc streams): $WORK"
fi
[ "$FAIL" -eq 0 ]
