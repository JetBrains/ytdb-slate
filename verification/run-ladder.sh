#!/usr/bin/env bash
# =============================================================================
# slate — verification ladder for the global model-default restore
# =============================================================================
# Exercises extension/model-default.ts and its two switch sites
# (extension/failover.ts, extension/handoff.ts). Prints one
#   RUNG <id> <PASS|FAIL|NOT RUN> — <detail>
# line per rung, plus a summary. See verification/README.md.
#
# Usage:
#   bash verification/run-ladder.sh --repo .
#   bash verification/run-ladder.sh --repo . --only G1,P5a
#   bash verification/run-ladder.sh --repo . --lab /tmp/mylab
#   bash verification/run-ladder.sh --repo . --strict         # CI: NOT RUN is fatal
#   bash verification/run-ladder.sh --repo . --setup-only     # guards + fixtures, no rungs
#   bash verification/run-ladder.sh --repo . --self-test      # hermetic launcher regression tests
#   bash verification/run-ladder.sh --list-rungs
#
#   --repo <dir>        slate checkout under test (required; use "." from the root)
#   --lab <dir>         scratch dir for agent/, work/, out/, weak/ (default: fresh mktemp)
#   --only <id,id,...>  run a subset of rungs; an unknown id is a hard error
#   --old-module <file> pre-fix model-default.ts for the P5a/P5b teeth proof
#                       (default: derived from the current module at run time)
#   --setup-only        run every guard and build every fixture, then stop
#   --self-test         run deterministic hermetic-launcher regression tests
#   --strict            treat any NOT RUN as fatal (use this in automation)
#   --list-rungs        print the rung ids and exit
#
# Exit status: 0 all good · 1 a rung failed, no rung ran, sandbox or repository
# safety evidence failed, or --strict was given and a check reported NOT RUN ·
# 2 refused to start (a safety guard or usage error) · 3 the scratch
# directory disappeared mid-run, so the results are void.
#
# Requirements (all checked up front): pi, node, python3, and GNU coreutils
# (sha256sum, stat -c, timeout, cmp, mkfifo, awk, sed, grep). strace is optional
# — the one rung that needs it reports NOT RUN. No network: every fake provider
# points at a dead local port. Do NOT run as root: the failure injections are
# permission-based and root defeats them silently, so the script refuses.
#
# SAFETY: see § safety guards. Each guard ABORTS the run; none degrades to a
# pass. What they cover, and what they do not, is spelled out in the README.
# =============================================================================
set -uo pipefail

REPO=""; LAB=""; ONLY=""; OLDMOD_ARG=""; SETUP_ONLY=0; SELF_TEST=0; STRICT=0
ORIG_ARGS="$*"

# fd 8 is a duplicate of the ORIGINAL stderr, taken before any rung redirects
# stderr into an artifact file. Guard messages must reach the operator even when
# they fire from inside a redirected pi invocation, or an abort looks silent.
exec 8>&2
die() { echo "verification: $*" >&8; exit 2; }

# Every rung id the script knows. --only is validated against this, so a typo
# cannot silently run nothing (WH7).
ALL_RUNGS="R1 R2 R3a R3b R4a R4b R5a R5b R5c R6 R7 R8 G1 G2 G4a G4b P5a P5b P6 P7 P8 P9a P9b P10 P11 WK1 LAT"

# WH6: an option whose value is missing used to leave `shift 2` failing, which
# does not shift at all — an infinite busy loop. Now it is a hard error.
need_val() { [ "$1" -ge 2 ] || die "option '$2' requires a value"; }
while [ $# -gt 0 ]; do
	case "$1" in
		--repo)       need_val $# "$1"; REPO="$2"; shift 2 ;;
		--lab)        need_val $# "$1"; LAB="$2"; shift 2 ;;
		--only)       need_val $# "$1"; ONLY="$2"; shift 2 ;;
		--old-module) need_val $# "$1"; OLDMOD_ARG="$2"; shift 2 ;;
		--setup-only) SETUP_ONLY=1; shift ;;
		--self-test)  SELF_TEST=1; shift ;;
		--strict)     STRICT=1; shift ;;
		--list-rungs) printf '%s\n' $ALL_RUNGS; exit 0 ;;
		-h|--help)    sed -n '2,40p' "$0"; exit 0 ;;
		*) die "unknown argument '$1' (try --help)" ;;
	esac
done

# WH7: validate --only against the known ids. A typo used to select nothing and
# exit 0 — a false green on a harness that is the project's only regression net.
if [ -n "$ONLY" ]; then
	# Split the comma list FIRST, then validate with IFS back to normal: leaving
	# IFS=',' in force makes `for known in $ALL_RUNGS` split on commas instead of
	# whitespace, so every id looks unknown.
	OLD_IFS="$IFS"; IFS=','; set -f
	# shellcheck disable=SC2086
	set -- $ONLY
	IFS="$OLD_IFS"; set +f
	BAD=""
	for id in "$@"; do
		[ -n "$id" ] || continue
		found=0
		for known in $ALL_RUNGS; do [ "$id" = "$known" ] && { found=1; break; }; done
		[ "$found" = 1 ] || BAD="$BAD $id"
	done
	[ -n "$BAD" ] && die "unknown rung id(s):$BAD
       known ids: $ALL_RUNGS
       (use --list-rungs, or --setup-only to exercise the guards without rungs)"
fi

# ============================================================ safety guards ==

# Guard 0a: refuse root. Every failure injection in this ladder is a chmod, and
# root ignores those, so rungs would report on behaviour that never happened.
CALLER_UID=$(id -u)
[ "$CALLER_UID" = 0 ] && die "refusing to run as root: the failure injections are permission-based
       (chmod 444 on the settings file) and root writes straight through them, so
       R7, G2, P6 and P11 would measure nothing. Re-run as a normal user."

# Guard 0b: every tool the script depends on, checked BEFORE anything is created.
# A safety check that cannot run must abort, never silently pass (WH3), and a
# missing GNU flag halfway through a run is just a confusing failure.
MISSING=""
for t in pi node python3 sha256sum stat timeout cmp mkfifo awk sed grep chmod \
         cat cp cut date dirname find head ls rm rmdir sort tail wc mktemp readlink; do
	command -v "$t" >/dev/null 2>&1 || MISSING="$MISSING $t"
done
[ -n "$MISSING" ] && die "missing required tool(s):$MISSING"
sha256sum --version >/dev/null 2>&1 || die "sha256sum is not the GNU one; the real-settings fingerprint (guard 4) could not run"
stat -c '%s' "$0" >/dev/null 2>&1 || die "stat does not support -c (GNU coreutils required); the real-settings fingerprint (guard 4) could not run"
rm --help 2>/dev/null | grep -q -- '--one-file-system' || die "rm does not support --one-file-system; safe scratch-state clearing is unavailable"
tool_abs() { local p; p=$(command -v "$1") || die "cannot resolve tool '$1'"; p=$(readlink -f "$p") || die "cannot canonicalise tool '$1'"; [ -x "$p" ] || die "resolved tool '$1' is not executable: $p"; printf '%s' "$p"; }
PI_BIN=$(tool_abs pi); NODE_BIN=$(tool_abs node); TIMEOUT_BIN=$(tool_abs timeout)
PI_COMMAND=$(command -v pi); case "$PI_COMMAND" in /*) ;; *) die "pi command path is not absolute: $PI_COMMAND" ;; esac
PI_COMMAND_DIR=${PI_COMMAND%/*}; [ -d "$PI_COMMAND_DIR" ] && [ ! -L "$PI_COMMAND_DIR" ] || die "pi command directory is not a real directory: $PI_COMMAND_DIR"
# The real pi command directory is deliberately absent. Children resolve `pi`
# only through the guarded shim created inside the validated lab.
CONTROLLED_PATH=""
for t in node python3 sha256sum stat timeout cmp mkfifo awk sed grep chmod cat cp cut date dirname find head ls rm rmdir sort tail wc mktemp readlink env; do
	p=$(tool_abs "$t"); d=${p%/*}; case ":$CONTROLLED_PATH:" in *":$d:"*) ;; *) CONTROLLED_PATH="${CONTROLLED_PATH:+$CONTROLLED_PATH:}$d" ;; esac
done
[ -n "$CONTROLLED_PATH" ] || die "controlled child PATH is empty"

# Guard 1: refuse an inherited PI_CODING_AGENT_DIR. The whole harness rests on
# that variable pointing at a directory THIS script created; silently inheriting
# someone else's value would aim every pi invocation at real state.
# WH5: the advice has to stay correct for someone whose pi lives in a CUSTOM
# agent dir. Clearing the variable would leave guards 2-4 watching
# <home>/.pi/agent — not their state — so the advice hands their value back
# through SLATE_LADDER_REAL_AGENT_DIR, which is what the guards then protect.
if [ "${PI_CODING_AGENT_DIR+set}" = set ]; then
	die "PI_CODING_AGENT_DIR is already set in the environment ('$PI_CODING_AGENT_DIR').
       This harness must own that variable — it points every pi invocation at a
       throwaway agent directory. Refusing to inherit it. Re-run with:

           SLATE_LADDER_REAL_AGENT_DIR='$PI_CODING_AGENT_DIR' \\
             env -u PI_CODING_AGENT_DIR bash $0 $ORIG_ARGS

       (that keeps the guards and the before/after fingerprint pointed at the
       agent directory you actually use; plain 'env -u' alone would point them
       at the default one instead.)"
fi

[ -n "$REPO" ] || die "--repo is required (use --repo . from the repository root)"
[ -d "$REPO" ] || die "--repo '$REPO' is not a directory"
REPO=$(cd "$REPO" && pwd -P) || die "cannot resolve --repo"
[ -n "$REPO" ] || die "--repo resolved to an empty path"
[ -f "$REPO/extension/model-default.ts" ] || die "no extension/model-default.ts under $REPO — is --repo a slate checkout?"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P) || die "cannot resolve the script directory"
PROBE="$SCRIPT_DIR/probe.ts"
[ -f "$PROBE" ] || die "probe extension not found next to this script ($PROBE)"

canon() { cd "$1" 2>/dev/null && pwd -P; }
# Resolve a path that may not exist yet, WITHOUT creating it: the forbidden-tree
# checks must run before anything is written, or a rejected path still leaves a
# stray directory behind (WH17). Paths go in as argv, never interpolated.
resolve() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

# WH4: resolve the real agent directory the way PI does, not from $HOME. pi calls
# os.homedir(), which falls back to the passwd database when HOME is unset — so
# asking node is the only answer that cannot disagree with pi. An explicit
# override wins (see guard 1's advice), and an undeterminable home aborts.
if [ -n "${SLATE_LADDER_REAL_AGENT_DIR:-}" ]; then
	REAL_AGENT_DIR=$(resolve "$SLATE_LADDER_REAL_AGENT_DIR") || die "cannot resolve SLATE_LADDER_REAL_AGENT_DIR"
	# With an explicit agent dir, protect exactly that subtree. Guessing its parent
	# would either miss state or, for something like /opt/pi-agent, declare all of
	# /opt off limits.
	PI_HOME_DIR="$REAL_AGENT_DIR"
else
	PI_HOMEDIR=$(node -e 'const os=require("os");const h=os.homedir();if(!h)process.exit(1);process.stdout.write(h)' 2>/dev/null) \
		|| die "cannot determine the home directory the way pi does (node os.homedir() failed);
       re-run with SLATE_LADDER_REAL_AGENT_DIR=<your pi agent dir> so the guards
       and the before/after fingerprint have something real to protect."
	[ -n "$PI_HOMEDIR" ] || die "node os.homedir() returned an empty path; re-run with SLATE_LADDER_REAL_AGENT_DIR=<your pi agent dir>"
	PI_HOME_DIR="$PI_HOMEDIR/.pi"
	REAL_AGENT_DIR="$PI_HOME_DIR/agent"
fi
REAL_SETTINGS="$REAL_AGENT_DIR/settings.json"
REAL_CORPUS="$REAL_AGENT_DIR/ytdb-slate/projects"
PI_HOME_CANON=$(resolve "$PI_HOME_DIR")
REAL_AGENT_CANON=$(resolve "$REAL_AGENT_DIR")
[ -n "$PI_HOME_CANON" ] || die "could not resolve the pi home directory"
[ -n "$REAL_AGENT_CANON" ] || die "could not resolve the real agent directory"

under() { # $1 child, $2 parent — true when child == parent or is inside it
	[ -n "$2" ] || return 1
	case "$1" in "$2") return 0 ;; "$2"/*) return 0 ;; *) return 1 ;; esac
}
assert_private_owned_dir() { # $1 path, $2 label
	local path="$1" label="$2" owner mode permissions
	[ ! -L "$path" ] || die "refusing to use $label '$path': it is a symlink. Replace it with a private directory."
	[ -d "$path" ] || die "refusing to use $label '$path': it is not a directory. Create a private directory there."
	owner=$(stat -c '%u' "$path") || die "cannot read the owner of $label '$path'"
	[ "$owner" = "$CALLER_UID" ] || die "refusing to use $label '$path': uid $owner owns it, not caller uid $CALLER_UID. Choose a caller-owned path."
	mode=$(stat -c '%a' "$path") || die "cannot read the mode of $label '$path'"
	permissions=$((8#$mode))
	[ $((permissions & 0022)) -eq 0 ] || die "refusing to use $label '$path': mode $mode permits group or other writes. Run chmod go-w '$path' and retry."
}
check_free_of_real_state() { # $1 path, $2 label
	[ -n "$1" ] || die "refusing to run: $2 resolved to an empty path"
	case "$1" in /*) ;; *) die "refusing to run: $2 '$1' is not absolute" ;; esac
	under "$1" "$PI_HOME_CANON" && \
		die "refusing to run: $2 '$1' is inside the pi home directory '$PI_HOME_CANON'"
	under "$1" "$REAL_AGENT_CANON" && \
		die "refusing to run: $2 '$1' is inside the real agent directory '$REAL_AGENT_CANON'"
	under "$1" "$REPO" && \
		die "refusing to run: $2 '$1' is inside the repository working tree '$REPO' — the harness must write nothing there"
	return 0
}

# Guard 2: pick and validate the scratch root. VALIDATE FIRST, CREATE SECOND —
# including for the default, whose location follows TMPDIR and can therefore be
# aimed into a forbidden tree just as easily as --lab can (WH17).
if [ -n "$LAB" ]; then
	LAB=$(resolve "$LAB") || die "cannot resolve --lab"
	check_free_of_real_state "$LAB" "--lab"
	mkdir -p "$LAB" || die "cannot create --lab '$LAB'"
else
	TMPROOT=$(resolve "${TMPDIR:-/tmp}") || die "cannot resolve TMPDIR"
	[ -d "$TMPROOT" ] || die "TMPDIR '$TMPROOT' is not a directory"
	check_free_of_real_state "$TMPROOT" "the temporary directory (TMPDIR)"
	LAB=$(mktemp -d "$TMPROOT/slate-ladder.XXXXXX") || die "mktemp failed under '$TMPROOT'"
	LAB=$(resolve "$LAB") || die "cannot resolve the scratch dir"
	check_free_of_real_state "$LAB" "scratch dir"
fi
LAB_CANON="$LAB"
assert_private_owned_dir "$LAB" "the scratch root"

# One atomic lab lock spans setup, every rung, and final safety reporting. A
# crash may leave it behind deliberately: the next run refuses rather than
# guessing whether another process still owns this lab.
LAB_LOCK="$LAB/.slate-ladder.lock"
LAB_LOCK_HELD=0
LAB_LOCK_RELEASE_REPORTED=0
release_lab_lock() {
	[ "$LAB_LOCK_HELD" = 1 ] || return 0
	if rmdir "$LAB_LOCK" 2>/dev/null; then
		LAB_LOCK_HELD=0
		return 0
	fi
	if [ "$LAB_LOCK_RELEASE_REPORTED" = 0 ]; then
		LAB_LOCK_RELEASE_REPORTED=1
		echo "verification: could not release lab lock '$LAB_LOCK'. The lock still exists. Remove its contents, then remove the lock after confirming no ladder uses this lab." >&8
	fi
	return 1
}
early_finish() {
	local status="$1"
	trap - EXIT
	if ! release_lab_lock; then [ "$status" -ne 0 ] || status=1; fi
	exit "$status"
}
early_signal() { trap - EXIT; release_lab_lock || true; exit 130; }
trap 'early_finish $?' EXIT
trap early_signal INT TERM
if ! mkdir "$LAB_LOCK" 2>/dev/null; then
	die "refusing to use lab '$LAB': lock '$LAB_LOCK' already exists. Confirm no ladder uses this lab, then remove the stale lock and retry."
fi
LAB_LOCK_HELD=1

# WH1 + WH2: every directory the harness writes to is created with a CHECKED
# mkdir, canonicalised, required to be non-empty and absolute, required to sit
# inside the scratch root (so a symlinked component cannot walk out), and put
# through the forbidden-tree check. An unchecked mkdir was the blocker: it left
# the agent path empty, and an EMPTY PI_CODING_AGENT_DIR makes pi fall back to
# the user's REAL agent directory.
# Result goes into LD_OUT rather than stdout ON PURPOSE: called in a command
# substitution, every `die` in here would only kill the SUBSHELL, the caller
# would carry on with an empty path, and an empty PI_CODING_AGENT_DIR is exactly
# the blocker this is meant to close. Run in the current shell, `die` aborts.
LD_OUT=""
labdir() { # $1 relative name, $2 label -> sets LD_OUT
	local want="$LAB/$1" got
	mkdir -p "$want" || die "cannot create $2 '$want'"
	got=$(canon "$want") || die "cannot resolve $2 '$want' after creating it"
	[ -n "$got" ] || die "$2 resolved to an empty path"
	[ -d "$got" ] || die "$2 '$got' is not a directory after creation"
	under "$got" "$LAB_CANON" || \
		die "refusing to run: $2 resolves to '$got', outside the scratch root '$LAB_CANON' — a symlinked component would put harness writes somewhere else"
	check_free_of_real_state "$got" "$2"
	LD_OUT="$got"
}
labdir agent "the throwaway agent dir";     AGENT="$LD_OUT"
labdir home "the throwaway home dir";        CHILD_HOME="$LD_OUT"
labdir tmp "the throwaway temporary dir";    CHILD_TMP="$LD_OUT"
labdir work "the project work dir";         WORK="$LD_OUT"
labdir out "the artifact dir";              OUT="$LD_OUT"
labdir weak "the generated-module dir";     WEAK="$LD_OUT"
labdir "work/.pi" "the project pi-config dir"
for v in AGENT CHILD_HOME CHILD_TMP WORK OUT WEAK; do
	eval "val=\${$v}"
	[ -n "$val" ] || die "internal: $v is empty after validation — refusing to continue"
done
SETTINGS="$AGENT/settings.json"
PI_LEDGER="$OUT/pi-agent-ledger"
PI_SHIM_DIR="$LAB/pi-shim"
mkdir -p "$PI_SHIM_DIR" || die "cannot create guarded pi shim directory"
PI_SHIM_DIR=$(canon "$PI_SHIM_DIR") || die "cannot resolve guarded pi shim directory"
under "$PI_SHIM_DIR" "$LAB_CANON" || die "guarded pi shim escaped the lab"
PI_LAUNCH_TOKEN=$(printf '%s:%s:%s' "$LAB" "$$" "$(date +%s%N)" | sha256sum | cut -d' ' -f1)
[ -n "$PI_LAUNCH_TOKEN" ] || die "cannot derive guarded pi launch token"
cat > "$PI_SHIM_DIR/pi" <<EOF || die "cannot write guarded pi shim"
#!/usr/bin/env bash
set -u
[ "\${SLATE_PI_LAUNCH_TOKEN:-}" = "$PI_LAUNCH_TOKEN" ] || { echo "verification: guarded pi shim refused an unlaunched invocation" >&2; exit 96; }
[ -n "\${SLATE_PI_LEDGER:-}" ] || { echo "verification: guarded pi shim has no ledger" >&2; exit 96; }
printf '%s\n' "\${PI_CODING_AGENT_DIR:-}" >> "\$SLATE_PI_LEDGER" || exit 96
exec "$PI_BIN" "\$@"
EOF
chmod 700 "$PI_SHIM_DIR/pi" || die "cannot make guarded pi shim executable"
CONTROLLED_PATH="$PI_SHIM_DIR${CONTROLLED_PATH:+:$CONTROLLED_PATH}"
rm -f "$PI_LEDGER" || die "cannot clear guarded pi ledger"

# Guard 3: belt and braces on the redirect target itself.
[ "$AGENT" = "$REAL_AGENT_CANON" ] && \
	die "refusing to run: the throwaway agent dir resolves to the REAL agent dir '$AGENT'"
assert_private_owned_dir "$AGENT" "the throwaway agent directory"

# D217-D219: the real settings content hash is diagnostic only. Isolation verdicts
# come from hermetic child environments, throwaway HOME fallback evidence, selected-
# agent evidence, and a fatal repository fingerprint.
real_content_hash() {
	if [ -f "$REAL_SETTINGS" ]; then sha256sum "$REAL_SETTINGS" | cut -d' ' -f1
	elif [ -e "$REAL_SETTINGS" ]; then printf 'non-regular'
	else printf 'absent'; fi
}
tree_fingerprint() { # $1 root
	local root="$1"
	(
		if [ ! -e "$root" ]; then printf 'tree:absent:%s\n' "$root"; exit 0; fi
		while IFS= read -r -d '' path; do
			stat -c '%n:%F:%a:%u:%g:%s:%y' "$path" || exit 1
			if [ -f "$path" ]; then sha256sum "$path" || exit 1; fi
		done < <(find "$root" -xdev -print0 | sort -z)
	) | sha256sum | cut -d' ' -f1
}
repo_fingerprint() {
	python3 - "$REPO" <<'PY'
import hashlib, os, stat, subprocess, sys
repo=os.path.realpath(sys.argv[1]); h=hashlib.sha256()
def add(x): h.update(x if isinstance(x,bytes) else x.encode()); h.update(b"\0")
add(subprocess.check_output(["git","-C",repo,"rev-parse","HEAD"]))
# Read index entries directly. `git write-tree` is forbidden here because it can
# rewrite the index and create loose objects while taking the "before" digest.
add(subprocess.check_output(["git","-C",repo,"ls-files","--stage","-z"]))
paths=subprocess.check_output(["git","-C",repo,"ls-files","-co","--exclude-standard","-z"]).split(b"\0")
for raw in sorted(p for p in paths if p):
    rel=os.fsdecode(raw); path=os.path.join(repo,rel); add(raw)
    try: s=os.lstat(path)
    except FileNotFoundError: add(b"missing"); continue
    add(f"{stat.S_IFMT(s.st_mode)}:{stat.S_IMODE(s.st_mode)}:{s.st_size}:{s.st_mtime_ns}")
    if stat.S_ISLNK(s.st_mode): add(os.readlink(path))
    elif stat.S_ISREG(s.st_mode):
        with open(path,"rb") as f:
            for chunk in iter(lambda:f.read(1024*1024),b""): h.update(chunk)
print(h.hexdigest())
PY
}
FALLBACK_AGENT="$CHILD_HOME/.pi/agent"
REAL_BEFORE=$(real_content_hash)
FALLBACK_BEFORE=$(tree_fingerprint "$FALLBACK_AGENT") || die "cannot fingerprint throwaway HOME fallback agent"
REPO_BEFORE=$(repo_fingerprint) || die "cannot fingerprint repository before the run"
[ -n "$REPO_BEFORE" ] || die "repository fingerprint came back empty"

# Cleanup on interrupt as well as on exit: leave the artifacts (they are the
# evidence) but never leave a settings file read-only, a lock directory held, or
# a background helper running.
# An ARRAY, not a space-separated string: word splitting made the whole cleanup
# silently no-op for any lab path containing a space.
CLEAN_DIRS=("$AGENT")
cleanup() {
	local d
	for d in "${CLEAN_DIRS[@]}"; do
		[ -n "$d" ] || continue
		# Best effort and SILENT here: the trap must never die or prompt. It still
		# refuses to touch anything that is not a real directory inside the lab, so
		# a swapped symlink cannot turn cleanup into a write somewhere else.
		[ -L "$d" ] && continue
		[ -d "$d" ] || continue
		case "$(canon "$d" 2>/dev/null)" in "$LAB_CANON"|"$LAB_CANON"/*) ;; *) continue ;; esac
		chmod 644 "$d/settings.json" 2>/dev/null
		rm -rf "$d/settings.json.lock" 2>/dev/null
	done
	jobs -p 2>/dev/null | while read -r j; do kill "$j" 2>/dev/null; done
	release_lab_lock
}
finish_cleanup() {
	local status="$1"
	trap - EXIT
	if ! cleanup; then [ "$status" -ne 0 ] || status=1; fi
	exit "$status"
}
on_signal() {
	trap - EXIT
	cleanup || true
	echo >&8
	echo "verification: interrupted — artifacts kept in $OUT" >&8
	exit 130
}
trap 'finish_cleanup $?' EXIT
trap on_signal INT TERM

# ---------------------------------------------------------------- bookkeeping
PASS=0; FAIL=0; SKIP=0
declare -a LINES=()
pass()   { PASS=$((PASS+1)); LINES+=("RUNG $1 PASS — $2"); printf 'RUNG %-6s PASS    — %s\n' "$1" "$2"; }
fail()   { FAIL=$((FAIL+1)); LINES+=("RUNG $1 FAIL — $2"); printf 'RUNG %-6s FAIL    — %s\n' "$1" "$2"; }
skip()   { SKIP=$((SKIP+1)); LINES+=("RUNG $1 NOT RUN — $2"); printf 'RUNG %-6s NOT RUN — %s\n' "$1" "$2"; }
# Every rung asks want() first, so this is also where a vanished scratch
# directory is caught. Without it, an outside process removing <lab> mid-run
# (a stray `rm -rf /tmp/<something>*` from a neighbouring job, say) produces a
# cascade of misleading FAILs and UNPARSEABLE settings instead of one clear
# diagnosis, and the results would be void either way.
scratch_gone() { [ ! -d "$OUT" ] || [ ! -d "$AGENT" ]; }
RAN=0
want() {
	if scratch_gone; then
		echo >&2
		echo "verification: ABORTING - the scratch directory disappeared mid-run ($LAB)." >&2
		echo "       Nothing was written there by this script after setup, so an outside" >&2
		echo "       process removed it. Every result already printed is VOID. Re-run with" >&2
		echo "       an explicit --lab under a path nothing else touches." >&2
		exit 3
	fi
	if [ -n "$ONLY" ]; then
		case ",$ONLY," in *",$1,"*) ;; *) return 1 ;; esac
	fi
	RAN=$((RAN+1)); return 0
}

# --------------------------------------------------------------- pi execution
# Strips the inherited pi session env so a nested run cannot pick up the
# caller's session, and redirects the agent dir.
#
# WH1, export site: an EMPTY PI_CODING_AGENT_DIR is exactly the condition that
# makes pi fall back to the user's REAL agent directory, so the redirect target
# is re-verified on EVERY launch — non-empty, absolute, an existing directory,
# and inside the scratch root. Cheap next to spawning a pi process, and it means
# no future edit can reintroduce the blocker by unsetting the variable upstream.
# ONE check, used before every pi launch AND before every write into a lab agent
# directory. A launch-time-only guard is not enough: a same-user racer can
# replace <lab>/agent with a symlink between setup and the next fixture write,
# and the write then lands in the symlink's target while only the LAUNCH is
# refused (observed on the previous revision). So this runs immediately before
# each write too — it costs a `cd`+`pwd -P` subshell, a few hundred microseconds,
# a few dozen times per run.
#
# `-L` is the addition that matters for writes: a symlink whose target happens to
# sit inside the lab would satisfy every other clause, yet it is still not the
# directory this harness created, so it is refused outright.
assert_agent_dir() { # $1 dir, $2 what we were about to do
	local ag="${1:-}" verb="${2:-use the agent dir}" got
	[ -n "$ag" ] || die "internal: refusing to $verb — EMPTY agent directory; pi would fall back to the real one '$REAL_AGENT_CANON'"
	case "$ag" in /*) ;; *) die "internal: refusing to $verb — relative agent directory ('$ag')" ;; esac
	[ -L "$ag" ] && die "internal: refusing to $verb — the agent directory '$ag' is a SYMLINK, not the real directory this harness created; something replaced it mid-run"
	[ -d "$ag" ] || die "internal: refusing to $verb — the agent directory '$ag' is not a directory"
	got=$(canon "$ag") || die "internal: refusing to $verb — cannot resolve the agent directory '$ag'"
	[ -n "$got" ] || die "internal: refusing to $verb — the agent directory resolved to an empty path"
	[ "$got" = "$REAL_AGENT_CANON" ] && die "internal: refusing to $verb — that IS the real agent dir '$got'"
	under "$got" "$LAB_CANON" || die "internal: refusing to $verb — '$got' is outside the scratch root '$LAB_CANON'"
	return 0
}
assert_redirect_safe() { assert_agent_dir "${1:-}" "launch pi"; }
assert_launch_dir() { # $1 path, $2 label
	local path="${1:-}" label="$2" got
	[ -n "$path" ] || die "internal: refusing child launch — $label is absent or empty"
	case "$path" in /*) ;; *) die "internal: refusing child launch — $label is relative ('$path')" ;; esac
	[ ! -L "$path" ] || die "internal: refusing child launch — $label is a symlink ('$path')"
	[ -d "$path" ] || die "internal: refusing child launch — $label is not a real directory ('$path')"
	got=$(canon "$path") || die "internal: refusing child launch — cannot resolve $label '$path'"
	under "$got" "$LAB_CANON" || die "internal: refusing child launch — $label '$got' is outside lab '$LAB_CANON'"
}
# Reused --lab directories retain work/, out/ and weak/. Corpus evidence, pi
# session transcripts and the slate-child marker must belong to this run.
# CLEAR_TARGET is assigned in the current shell so a die cannot be hidden by a
# command-substitution subshell.
CLEAR_TARGET=""
validate_clear_target() { # $1 target, $2 label, $3 optional fixed ancestor
	local target="$1" label="$2" ancestor="${3:-}" resolved agent_device target_device
	CLEAR_TARGET=""
	assert_private_owned_dir "$LAB" "the scratch root"
	assert_agent_dir "$AGENT" "validate scratch state before clearing"
	assert_private_owned_dir "$AGENT" "the throwaway agent directory"
	if [ -n "$ancestor" ] && { [ -e "$ancestor" ] || [ -L "$ancestor" ]; }; then
		assert_agent_dir "$ancestor" "validate the $label parent before clearing"
		assert_private_owned_dir "$ancestor" "the $label parent"
	fi
	[ ! -L "$target" ] || die "refusing to clear $label '$target': it is a symlink. Replace it with a private directory."
	[ -e "$target" ] || return 0
	assert_agent_dir "$target" "clear $label"
	assert_private_owned_dir "$target" "$label"
	resolved=$(canon "$target") || die "cannot resolve $label '$target'"
	under "$resolved" "$AGENT" || die "refusing to clear $label '$resolved': it is outside the validated agent directory '$AGENT'."
	agent_device=$(stat -c '%d' "$AGENT") || die "cannot read the device of the validated agent directory '$AGENT'"
	target_device=$(stat -c '%d' "$resolved") || die "cannot read the device of $label '$resolved'"
	[ "$target_device" = "$agent_device" ] || die "refusing to clear $label '$resolved': device $target_device differs from agent device $agent_device. Remove the mount and retry."
	CLEAR_TARGET="$resolved"
}
clear_scratch_tree() { # $1 target, $2 label, $3 optional fixed ancestor, $4 note tag
	local target="$1" label="$2" ancestor="${3:-}" tag="$4" first
	validate_clear_target "$target" "$label" "$ancestor"
	first="$CLEAR_TARGET"
	[ -n "$first" ] || return 0
	# Repeat every ownership, mode, containment and device check immediately before
	# removal. The resolved path avoids re-walking the caller-facing path string.
	validate_clear_target "$target" "$label" "$ancestor"
	[ "$CLEAR_TARGET" = "$first" ] || die "refusing to clear $label '$target': its resolved path changed during validation. Retry in a private lab."
	rm -rf --one-file-system -- "$CLEAR_TARGET" || die "could not clear $label '$CLEAR_TARGET'"
	echo "NOTE   $tag         — cleared $label before this run: $CLEAR_TARGET"
}
reset_scratch_state() {
	local slate_root="$AGENT/ytdb-slate"
	clear_scratch_tree "$slate_root/projects" "the prior scratch corpus" "$slate_root" "CORPUS"
	clear_scratch_tree "$AGENT/sessions" "prior pi session transcripts" "" "SESSIONS"
	assert_private_owned_dir "$OUT" "the artifact directory"
	[ ! -d "$OUT/slate-child-ran" ] || die "refusing a scratch artifact marker that is a directory: $OUT/slate-child-ran"
	rm -f "$OUT/slate-child-ran" || die "cannot clear the prior-run slate child marker"
}
reset_scratch_state
CHILD_GUARD="$LAB/child-env-guard.mjs"
cat > "$CHILD_GUARD" <<'NODE' || die "cannot write child environment guard"
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const expected=(process.env.SLATE_CHILD_EXPECTED_KEYS??"").split(",").filter(Boolean).sort();
const actual=Object.keys(process.env).sort();
if (JSON.stringify(actual)!==JSON.stringify(expected)) {
  console.error(`ladder child environment mismatch: expected=${expected.join("|")} actual=${actual.join("|")}`);
  process.exit(97);
}
const [command,...args]=process.argv.slice(2);
if (!command) process.exit(98);
const child=spawn(command,args,{stdio:"inherit",env:process.env});
child.once("spawn",()=>writeFileSync(process.env.SLATE_CHILD_MARKER,"started\n"));
child.once("error",(error)=>{ console.error(`ladder child failed to start: ${error.message}`); process.exit(99); });
child.once("exit",(code,signal)=>process.exit(code??(signal?128:1)));
NODE
hermetic_exec() { # $1 selected agent, then NAME=VALUE canaries, then command
	local ag="$1" marker pair name expected rc; shift
	local -a extra=() command=()
	assert_agent_dir "$ag" "launch a hermetic child"
	assert_launch_dir "$CHILD_HOME" HOME
	assert_launch_dir "$CHILD_TMP" TMPDIR
	while [ $# -gt 0 ] && [[ "$1" == *=* ]]; do
		pair="$1"; name=${pair%%=*}
		[[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "invalid child canary name '$name'"
		case "$name" in HOME|TMPDIR|PATH|PI_CODING_AGENT_DIR|PI_OFFLINE|SLATE_CHILD_EXPECTED_KEYS|SLATE_CHILD_MARKER|SLATE_PI_LAUNCH_TOKEN|SLATE_PI_LEDGER) die "child canary attempts to replace reserved key $name" ;; esac
		extra+=("$pair"); shift
	done
	[ $# -gt 0 ] || die "hermetic launcher received no command"
	command=("$@")
	marker=$(mktemp "$OUT/child-start.XXXXXX") || die "cannot allocate child-start marker"
	rm -f "$marker" || die "cannot prepare child-start marker"
	expected="HOME,TMPDIR,PATH,PI_CODING_AGENT_DIR,PI_OFFLINE,SLATE_CHILD_EXPECTED_KEYS,SLATE_CHILD_MARKER,SLATE_PI_LAUNCH_TOKEN,SLATE_PI_LEDGER"
	for pair in "${extra[@]}"; do expected="$expected,${pair%%=*}"; done
	env -i HOME="$CHILD_HOME" TMPDIR="$CHILD_TMP" PATH="$CONTROLLED_PATH" \
		PI_CODING_AGENT_DIR="$ag" PI_OFFLINE=1 SLATE_CHILD_EXPECTED_KEYS="$expected" SLATE_CHILD_MARKER="$marker" \
		SLATE_PI_LAUNCH_TOKEN="$PI_LAUNCH_TOKEN" SLATE_PI_LEDGER="$PI_LEDGER" \
		"${extra[@]}" "$NODE_BIN" "$CHILD_GUARD" "${command[@]}"
	rc=$?
	[ -f "$marker" ] || die "hermetic child produced no positive start marker for '${command[0]}'"
	rm -f "$marker"
	return "$rc"
}
piexec() { hermetic_exec "$AGENT" "$@"; }
piexec_at() { local ag="$1"; shift; hermetic_exec "$ag" "$@"; }
audit_launcher_source() { # $1 shell source; structurally bind every pi command to the common launcher
	python3 - "$1" "$PI_BIN" <<'PY'
import os,re,shlex,sys
source,real_pi=sys.argv[1:3]
raw=open(source).read().splitlines(); lines=[]; heredoc=None
for number,line in enumerate(raw,1):
    if heredoc is not None:
        if line.strip()==heredoc: heredoc=None
        continue
    lines.append((number,line))
    match=re.search(r"<<-?['\"]?([A-Za-z0-9_]+)['\"]?",line)
    if match: heredoc=match.group(1)
logical=[]; pending=""; start=0
for number,line in lines:
    stripped=line.lstrip()
    if not pending and (not stripped or stripped.startswith("#")): continue
    if not pending: start=number
    pending += line.rstrip()[:-1] + " " if line.rstrip().endswith("\\") else line
    if line.rstrip().endswith("\\"): continue
    logical.append((start,pending)); pending=""
if pending: logical.append((start,pending))
def is_pi(token):
    plain=token.strip('"\'')
    return plain in {"pi","$PI_BIN","${PI_BIN}",real_pi} or plain.endswith("/pi")
for number,command in logical:
    try:
        lexer=shlex.shlex(command,posix=True,punctuation_chars=";&|")
        lexer.whitespace_split=True
        tokens=list(lexer)
    except ValueError: continue
    segment=[]
    for token in tokens+[";"]:
        if token and all(ch in ";&|" for ch in token):
            launchers=[i for i,item in enumerate(segment) if item in {"piexec","piexec_at"}]
            for index,item in enumerate(segment):
                if not is_pi(item): continue
                if index+1>=len(segment) or not segment[index+1].startswith("-"): continue
                if not any(launcher<index for launcher in launchers):
                    raise SystemExit(f"launcher bypass at logical command starting line {number}: {command.strip()}")
            segment=[]
        else: segment.append(token)
PY
}
run_launcher_self_tests() {
	local passed=0 alt="$LAB/selftest-alt-agent" fabricated="$LAB/fabricated-settings.json" outer="$LAB/outer-guard.err"
	local mutant="$LAB/launcher-mutant.sh" gitdir index before_index after_index before_objects after_objects before_repo after_repo shim_probe
	NODE_OPTIONS='--require=/definitely/poisoned' AWS_ACCESS_KEY_ID=poison HTTP_PROXY=http://poison \
		piexec node -e 'for(const k of ["NODE_OPTIONS","AWS_ACCESS_KEY_ID","HTTP_PROXY","PI_SESSION_ID","PI_CODING_AGENT_SESSION_DIR"])if(k in process.env)process.exit(1)' \
		|| die "SELFTEST poisoned parent variables crossed the hermetic launcher"; passed=$((passed+1))
	unset SLATE_SELFTEST_ABSENT
	( assert_launch_dir "${SLATE_SELFTEST_ABSENT-}" HOME ) >/dev/null 2>&1 && die "SELFTEST absent HOME was accepted"; passed=$((passed+1))
	( assert_launch_dir "" HOME ) >/dev/null 2>&1 && die "SELFTEST empty HOME was accepted"; passed=$((passed+1))
	( assert_launch_dir "${SLATE_SELFTEST_ABSENT-}" TMPDIR ) >/dev/null 2>&1 && die "SELFTEST absent TMPDIR was accepted"; passed=$((passed+1))
	( assert_launch_dir "" TMPDIR ) >/dev/null 2>&1 && die "SELFTEST empty TMPDIR was accepted"; passed=$((passed+1))
	( assert_agent_dir "${SLATE_SELFTEST_ABSENT-}" "self-test absent redirect" ) >/dev/null 2>&1 && die "SELFTEST absent agent redirect was accepted"; passed=$((passed+1))
	( assert_agent_dir "" "self-test empty redirect" ) >/dev/null 2>&1 && die "SELFTEST empty agent redirect was accepted"; passed=$((passed+1))
	if env -i HOME="$CHILD_HOME" TMPDIR="$CHILD_TMP" PATH="$CONTROLLED_PATH" PI_OFFLINE=1 \
		SLATE_CHILD_EXPECTED_KEYS='HOME,TMPDIR,PATH,PI_CODING_AGENT_DIR,PI_OFFLINE,SLATE_CHILD_EXPECTED_KEYS,SLATE_CHILD_MARKER,SLATE_PI_LAUNCH_TOKEN,SLATE_PI_LEDGER' \
		SLATE_CHILD_MARKER="$LAB/lost-marker" SLATE_PI_LAUNCH_TOKEN="$PI_LAUNCH_TOKEN" SLATE_PI_LEDGER="$PI_LEDGER" \
		"$NODE_BIN" "$CHILD_GUARD" true >/dev/null 2>&1; then
		die "SELFTEST redirect-loss teeth did not reject a missing PI_CODING_AGENT_DIR"
	fi
	passed=$((passed+1))
	piexec node -e 'const{spawnSync}=require("child_process");const r=spawnSync(process.execPath,["-e","process.stdout.write(Object.keys(process.env).sort().join(\",\"))"],{env:process.env,encoding:"utf8"});if(r.status||r.stdout!==Object.keys(process.env).sort().join(","))process.exit(1)' \
		|| die "SELFTEST nested child did not inherit the exact closed environment"; passed=$((passed+1))
	mkdir -p "$alt" || die "SELFTEST cannot create alternate agent"
	piexec_at "$alt" node -e 'if(process.env.PI_CODING_AGENT_DIR!==process.argv[1])process.exit(1)' "$alt" \
		|| die "SELFTEST P11 alternate-agent route bypassed the common launcher"; passed=$((passed+1))
	shim_probe="$PI_SHIM_DIR/$(printf 'p%s' i)"
	if "$shim_probe" --version >/dev/null 2>&1; then die "SELFTEST guarded pi shim accepted a parent-shell invocation"; fi
	passed=$((passed+1))
	rm -f "$PI_LEDGER"
	piexec_at "$alt" pi --version >/dev/null || die "SELFTEST guarded alternate-agent pi launch failed"
	grep -Fxq "$alt" "$PI_LEDGER" || die "SELFTEST actual guarded pi launch did not register alternate-agent evidence"
	passed=$((passed+1))
	if PI_CODING_AGENT_DIR="$LAB/poison-agent" bash "$0" --repo "$REPO" --setup-only > /dev/null 2> "$outer"; then
		die "SELFTEST outer inherited-agent guard accepted PI_CODING_AGENT_DIR"
	fi
	grep -q 'PI_CODING_AGENT_DIR is already set' "$outer" || die "SELFTEST outer inherited-agent guard failed for the wrong reason"; passed=$((passed+1))
	audit_launcher_source "$0" || die "SELFTEST launcher-bypass source audit rejected the real script"; passed=$((passed+1))
	local bypass_flag; bypass_flag=$(printf -- '--no-%s' extensions)
	for form in literal variable resolved absolute-multiline no-noextensions semicolon-decoy; do
		cp "$0" "$mutant" || die "SELFTEST cannot create launcher mutation"
		case "$form" in
			literal) printf '\npi %s -p x\n' "$bypass_flag" >> "$mutant" ;;
			variable) printf '\n"$PI_BIN" %s -p x\n' "$bypass_flag" >> "$mutant" ;;
			resolved) printf '\n%s %s -p x\n' "$PI_BIN" "$bypass_flag" >> "$mutant" ;;
			absolute-multiline) printf '\n/opt/fake/pi \\\n  %s -p x\n' "$bypass_flag" >> "$mutant" ;;
			no-noextensions) printf '\npi -p x\n' >> "$mutant" ;;
			semicolon-decoy) printf '\nprintf piexec >/dev/null; pi -p x\n' >> "$mutant" ;;
		esac
		if audit_launcher_source "$mutant" >/dev/null 2>&1; then die "SELFTEST launcher audit missed $form bypass"; fi
		passed=$((passed+1))
	done
	gitdir=$(git -C "$REPO" rev-parse --absolute-git-dir) || die "SELFTEST cannot resolve git directory"
	index="$gitdir/index"
	before_index=$(if [ -f "$index" ]; then sha256sum "$index"; stat -c '%s:%y:%a' "$index"; else echo absent; fi)
	before_objects=$(tree_fingerprint "$gitdir/objects") || die "SELFTEST cannot fingerprint git objects"
	before_repo=$(repo_fingerprint) || die "SELFTEST cannot fingerprint repository"
	after_repo=$(repo_fingerprint) || die "SELFTEST cannot repeat repository fingerprint"
	after_index=$(if [ -f "$index" ]; then sha256sum "$index"; stat -c '%s:%y:%a' "$index"; else echo absent; fi)
	after_objects=$(tree_fingerprint "$gitdir/objects") || die "SELFTEST cannot repeat git-object fingerprint"
	[ "$before_repo" = "$after_repo" ] && [ "$before_index" = "$after_index" ] && [ "$before_objects" = "$after_objects" ] \
		|| die "SELFTEST repository fingerprint mutated worktree, index, or git objects"
	passed=$((passed+1))
	printf 'start\n' > "$fabricated"
	( for i in 1 2 3 4 5; do printf 'concurrent-%s\n' "$i" > "$fabricated"; sleep 0.02; done ) & local writer=$!
	piexec node -e 'setTimeout(()=>process.exit(0),80)' || die "SELFTEST hermetic child failed during fabricated concurrent writes"
	wait "$writer" || die "SELFTEST fabricated concurrent writer failed"
	grep -q '^concurrent-' "$fabricated" || die "SELFTEST fabricated concurrent settings write did not occur"; passed=$((passed+1))
	printf 'SELFTEST PASS — %s deterministic launcher checks passed\n' "$passed"
}
mark_slate_child_ran() { : > "$OUT/slate-child-ran"; }
if [ "$SELF_TEST" = 1 ]; then
	run_launcher_self_tests
	exit 0
fi
scratch_corpus_has_session() {
	local ag="${1:-$AGENT}" corpus
	assert_agent_dir "$ag" "inspect scratch corpus evidence"
	corpus="$ag/ytdb-slate/projects"
	[ -d "$corpus" ] || return 1
	find "$corpus" -mindepth 3 -maxdepth 3 -type f -name session.json -print -quit | grep -q .
}
# Across several marked children, this proves at least one current-run child
# published a scratch corpus session. It does not prove that every child did.
PRED_TEETH_AGENT="$LAB/corpus-predicate-teeth-agent"
PRED_TEETH_CORPUS="$PRED_TEETH_AGENT/ytdb-slate/projects"
PRED_TEETH_SESSION="$PRED_TEETH_CORPUS/project/session"
rm -rf "$PRED_TEETH_AGENT"
mkdir -p "$PRED_TEETH_SESSION" || die "cannot create corpus predicate teeth fixture"
printf 'wrong name\n' > "$PRED_TEETH_SESSION/not-session.json"
if scratch_corpus_has_session "$PRED_TEETH_AGENT"; then
	die "corpus predicate teeth accepted a depth-three file not named session.json"
fi
rm -f "$PRED_TEETH_SESSION/not-session.json"
printf '{}\n' > "$PRED_TEETH_CORPUS/project/session.json"
if scratch_corpus_has_session "$PRED_TEETH_AGENT"; then
	die "corpus predicate teeth accepted a too-shallow session.json"
fi
rm -f "$PRED_TEETH_CORPUS/project/session.json"
mkdir -p "$PRED_TEETH_SESSION/extra" || die "cannot create the deep corpus predicate teeth fixture"
printf '{}\n' > "$PRED_TEETH_SESSION/extra/session.json"
if scratch_corpus_has_session "$PRED_TEETH_AGENT"; then
	die "corpus predicate teeth accepted a too-deep session.json"
fi
rm -rf "$PRED_TEETH_SESSION/extra"
printf '{}\n' > "$PRED_TEETH_SESSION/session.json"
scratch_corpus_has_session "$PRED_TEETH_AGENT" || die "corpus predicate teeth rejected a depth-three session.json"
rm -rf "$PRED_TEETH_AGENT"

seed() { assert_agent_dir "$AGENT" "write the settings fixture"; printf '%s' "$1" > "$SETTINGS"; }
# WH8: on failure the sentinel must be UNIQUE, or two failed reads compare equal
# and a rung passes by construction on a double failure.
snapshot() { cp -f "$SETTINGS" "$OUT/$1" 2>/dev/null ||
	printf '<snapshot of %s failed at %s>\n' "$SETTINGS" "$(date +%s%N)" > "$OUT/$1"; }
sha() { sha256sum "$1" 2>/dev/null | cut -c1-16 || echo "<none>"; }
# Paths go in as argv, never interpolated into the program text.
triple() { python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print("UNPARSEABLE"); sys.exit()
print("{}/{}:{}".format(d.get("defaultProvider"), d.get("defaultModel"), d.get("defaultThinkingLevel")))' "$SETTINGS"; }
newest_session() { ls -t "$AGENT/sessions"/*/*.jsonl 2>/dev/null | head -1; }
# Structural, and deliberately order-independent: asserts the three fields are
# on one model_change record without assuming pi's key serialisation order.
switch_seen() { local s; s=$(newest_session); [ -n "$s" ] || return 1
	grep '"type":"model_change"' "$s" | grep "\"provider\":\"$1\"" | grep -q "\"modelId\":\"$2\""; }
# Positive evidence for the thinking-ONLY paths, where no model_change exists
# because the equality guard skips the model setter (WH8).
thinking_change_seen() { local s; s=$(newest_session); [ -n "$s" ] || return 1
	grep '"type":"thinking_level_change"' "$s" | grep -q "\"thinkingLevel\":\"$1\""; }

# ------------------------------------------------- report-matching helpers --
# Every assertion that reads slate's own output goes through these. They match
# SEMANTIC INVARIANTS, never whole sentences: the distinguishing verb phrase,
# the presence of the diagnostic parts (settings path, cause class), and the
# structural fact that slate spoke at all. Report prose is expected to be
# reworded — and, since reports are truncated diagnostics-first, any advisory
# tail may be CUT ENTIRELY, so no assertion may require it.
slate_lines() { grep '^slate:' "$1" 2>/dev/null; }
said_something() { slate_lines "$1" | grep -q .; }              # slate spoke
said() { slate_lines "$1" | grep -Eq "$2"; }                    # ... matching a pattern
names_settings_file() { slate_lines "$1" | grep -Fq "$SETTINGS"; } # named the file it means
# Verb phrases that carry MEANING, not decoration: "stood down" vs "tried and
# could not restore" vs "could not even establish divergence".
RX_STOOD_DOWN='not restoring the global model defaults'
RX_TRIED_RESTORE='could not restore the global model defaults'
RX_ONLY_CHECKED='could not check the global model defaults'

CANON='{
  "defaultProvider": "probe-a",
  "defaultModel": "alpha-1",
  "defaultThinkingLevel": "medium",
  "retry": {
    "enabled": false
  }
}'
CANON_XHIGH='{
  "defaultProvider": "probe-a",
  "defaultModel": "alpha-1",
  "defaultThinkingLevel": "xhigh",
  "retry": {
    "enabled": false
  }
}'

slatecfg() { printf '%s' "$1" > "$WORK/.pi/slate.json"; }

# ------------------------------------------------------------------- fixtures
assert_agent_dir "$AGENT" "write the fake model catalogue"
cat > "$AGENT/models.json" <<'EOF' || die "cannot write the fake model catalogue"
{
  "providers": {
    "probe-a": {
      "baseUrl": "http://127.0.0.1:8731/v1", "apiKey": "sandbox-fake-key-a", "api": "openai-completions",
      "models": [
        { "id": "alpha-1", "name": "Alpha 1", "reasoning": true,
          "thinkingLevelMap": { "off": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "high" },
          "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000, "maxTokens": 4096 },
        { "id": "alpha-2", "name": "Alpha 2", "reasoning": true,
          "thinkingLevelMap": { "off": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "high" },
          "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000, "maxTokens": 4096 }
      ]
    },
    "probe-b": {
      "baseUrl": "http://127.0.0.1:8731/v1", "apiKey": "sandbox-fake-key-b", "api": "openai-completions",
      "models": [ { "id": "beta-1", "name": "Beta 1", "reasoning": false, "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 200000, "maxTokens": 4096 } ]
    },
    "probe-c": {
      "baseUrl": "http://127.0.0.1:8731/v1", "apiKey": "sandbox-fake-key-c", "api": "openai-completions",
      "models": [ { "id": "gamma-1", "name": "Gamma 1", "reasoning": true,
        "thinkingLevelMap": { "off": null, "low": "low", "medium": "medium", "high": "high" },
        "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 200000, "maxTokens": 4096 } ]
    }
  }
}
EOF
assert_agent_dir "$AGENT" "write the fake auth file"
echo '{}' > "$AGENT/auth.json" || die "cannot write the fake auth file"

# P11's assertion, generated here so the driver stays the single shipped file.
cat > "$LAB/p11-assert.py" <<'P11_EOF' || die "cannot write the P11 assertion helper"
"""P11: a truncated report must be a MARKED, WORD-BOUNDARY cut of the full
message that keeps every diagnostic and loses only the advisory tail.

The emitted line is compared against the ACTUAL full message, produced by the
same scenario through a copy of the module whose cap was removed - so no report
prose is hardcoded beyond the one verb phrase that carries the meaning. The very
same checks are then applied to the output of a copy whose word-boundary search
was removed: the rung only claims teeth when they REJECT that output.

argv: real.err full.err settings-path [noboundary.err]
"""
import sys

CAP = 500
real_f, full_f, settings, nb_f = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]


def slate_line(path):
    if not path:
        return ""
    try:
        for line in open(path, encoding="utf8", errors="replace"):
            if line.startswith("slate:"):
                return line.rstrip("\n")
    except OSError:
        pass
    return ""


def out(verdict, msg):
    print(verdict + " " + msg)
    raise SystemExit(0)


DIAG = [("headline", "could not restore the global model defaults"),
        ("affected keys", "keys:"),
        ("settings path", settings),
        ("cause", "EACCES")]


def check(line, full):
    """None when `line` is a well-formed truncation of `full`, else the reason."""
    if not line:
        return "no report at all"
    if len(line) > CAP:
        return "the report is %d chars, over the %d-char cap" % (len(line), CAP)
    k = 0
    while k < min(len(line), len(full)) and line[k] == full[k]:
        k += 1
    kept, marker, cut_away = line[:k], line[k:], full[k:]
    if not marker.strip():
        return ("cut with no explicit end marker - a truncated line is indistinguishable from a "
                "message that died mid-sentence")
    if marker in full:
        return "the supposed end marker %r also occurs in the message, so it marks nothing" % marker
    if not cut_away:
        return "nothing was cut, yet the line differs from the full message - it was rewritten"
    # A cut is mid-word only when alphanumerics sit on BOTH sides of it. The
    # padded path component is letters-only, so a cut inside the path is
    # unambiguously mid-word.
    before, after = kept[-1:] or " ", full[k:k + 1] or " "
    if before.isalnum() and after.isalnum():
        return "cut mid-word: ...%r then %r" % (kept[-30:], full[k:k + 12])
    missing = [n for n, t in DIAG if t not in line]
    if missing:
        return "truncation ate the evidence - missing from the surviving line: " + ", ".join(missing)
    leaked = [n for n, t in DIAG if t in cut_away]
    if leaked:
        return "diagnostics fell into the discarded region: " + ", ".join(leaked)
    return None


def shape(line, full):
    k = 0
    while k < min(len(line), len(full)) and line[k] == full[k]:
        k += 1
    return line[k:].strip(), len(full) - k


real, full, nb = slate_line(real_f), slate_line(full_f), slate_line(nb_f)
if not real:
    out("FAIL", "the module under test emitted no report at all")
if not full:
    out("SKIP", "the cap-removed copy emitted no report, so the full message is unknown")
if len(full) <= CAP:
    out("SKIP", "the fixture's full report is only %d chars, so the %d-char cap was never reached "
                "- the rung would pass vacuously" % (len(full), CAP))

why = check(real, full)
if why:
    out("FAIL", why)

if not nb:
    teeth = "a no-boundary-search copy was not built, so the teeth were not demonstrated"
else:
    nb_why = check(nb, full)
    teeth = ("PROVEN - the same checks reject a copy whose word-boundary search was removed (%s)"
             % nb_why) if nb_why else \
            ("not demonstrated at this alignment - a copy with no word-boundary search happens to "
             "cut acceptably here; the check above is still falsifiable, it reads the real cut "
             "position against the real message")

marker, cut_len = shape(real, full)
out("PASS", "full report %d chars -> emitted %d (cap %d); cut on a word boundary and marked %r; "
            "headline, keys, settings path and cause all survive while %d chars of advisory tail "
            "are dropped, with no diagnostic in the discarded region. Teeth: %s"
            % (len(full), len(real), CAP, marker, cut_len, teeth))
P11_EOF

# The model-default probe extension is a committed file (verification/probe.ts),
# loaded from $SCRIPT_DIR — never regenerated here, so there is one source of
# truth. WK1's worker probe is generated below instead, for the same reason the
# weakened module copies are: it must import a module path chosen per run.

# WK1's probe: opens a REAL worker session through the module under test, performs
# the per-dispatch model AND effort switch exactly as threads.ts's applyRoute
# does, and reports what the session ended up on. Two phases, one file:
#   switch — open a worker on WORKER_OPEN, switch it to WORKER_TARGET at
#            WORKER_EFFORT, record before/after model+level, dispose;
#   reopen — open a worker with NO model argument and record what it opens on.
# The reopen phase runs in a SEPARATE pi process with no model on the command
# line, so its session model is the GLOBAL DEFAULT: a worker-side switch that had
# leaked into settings.json would surface there as a sticky default.
#
# It imports NOTHING from the repo statically: the module under test arrives as a
# path in WORKER_MODULE, so the same probe drives the real extension/worker.ts and
# the deliberately weakened copy below.
cat > "$LAB/worker-probe.ts" <<'WKP_EOF' || die "cannot write the WK1 worker probe"
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const MODULE = process.env.WORKER_MODULE!;
const RESULT = process.env.WORKER_RESULT!;
const PHASE = process.env.WORKER_PHASE ?? "switch";
const OPEN = process.env.WORKER_OPEN ?? "probe-a/alpha-1";
const TARGET = process.env.WORKER_TARGET ?? "probe-c/gamma-1";
const EFFORT = process.env.WORKER_EFFORT ?? "high";
const log = (...a: unknown[]) => console.error("[WKPROBE]", ...a);
const spec = (m: { provider?: string; id?: string } | undefined | null) => (m?.provider ? `${m.provider}/${m.id}` : null);
const level = (s: { thinkingLevel?: unknown }) => {
  try { return typeof s.thinkingLevel === "string" ? s.thinkingLevel : null; } catch { return null; }
};
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => {
    const out: Record<string, unknown> = { module: MODULE, phase: PHASE, target: TARGET, effort: EFFORT,
      hostModel: spec(ctx.model as never), status: "failed" };
    try {
      const mod = (await import(MODULE)) as {
        openWorkerSession: (o: Record<string, unknown>) => Promise<Record<string, unknown> & { setModel: (m: unknown) => Promise<unknown>; setThinkingLevel: (l: unknown) => void; dispose?: () => void }>;
        resolveModel: (ctx: unknown, spec: string) => unknown;
      };
      if (PHASE === "reopen") {
        // NO model argument: the worker opens on whatever the host session
        // resolved, which in this phase IS the global default.
        const s = await mod.openWorkerSession({ ctx });
        out.reopenedModel = spec(s.model as never);
        out.reopenedEffort = level(s);
        log("reopened worker on", out.reopenedModel, "@", out.reopenedEffort);
        s.dispose?.();
      } else {
        const s = await mod.openWorkerSession({ ctx, model: OPEN });
        out.openedModel = spec(s.model as never);
        out.openedEffort = level(s);
        out.sessionFile = (s.sessionFile as string) ?? null;
        // Exactly what threads.ts's applyRoute does per dispatch: model first
        // (it re-derives the level internally), then the effort level.
        await s.setModel(mod.resolveModel(ctx, TARGET));
        s.setThinkingLevel(EFFORT);
        out.switchedModel = spec(s.model as never);
        out.switchedEffort = level(s);
        log("worker", out.openedModel, "@", out.openedEffort, "=>", out.switchedModel, "@", out.switchedEffort);
        s.dispose?.();
      }
      out.status = "ok";
    } catch (e) {
      out.error = String(e);
      log("FAILED", out.error);
    }
    writeFileSync(RESULT, JSON.stringify(out, null, 2));
  });
}
WKP_EOF

# Module copies used for teeth-proving. The weakened model-default one swaps the
# macrotask yield for a microtask one; the "old" one is the pre-fix revision, used
# to show the pair-unit rungs can actually fail; WK1's is a worker.ts whose worker
# sessions get a FILE-BACKED settings manager.
# Rewrites every relative "./x.ts" import to an absolute one so a copy can live
# outside the repo. Paths go in as ARGV, never interpolated into a sed program:
# a path containing | or & would otherwise corrupt the substitution.
mkcopy() { # $1 source content file, $2 dest
	python3 -c '
import re, sys
src, dst, repo = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src).read()
open(dst, "w").write(re.sub(r"\"\./([A-Za-z0-9_.-]+\.ts)\"", lambda m: "\"" + repo + "/extension/" + m.group(1) + "\"", s))' "$1" "$2" "$REPO"; }
mkcopy "$REPO/extension/model-default.ts" "$WEAK/control.ts"
python3 - "$WEAK/control.ts" "$WEAK/microtask.ts" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
old = '''function macrotaskDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}'''
new = '''function macrotaskDelay(ms: number): Promise<void> {
	// DELIBERATELY WEAKENED (teeth proof, not repository code): MICROtask yield.
	if (ms === 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}'''
if old not in s:
    sys.stderr.write("WARN: yield helper not found verbatim; weakened copy not produced\n"); sys.exit(1)
open(dst, "w").write(s.replace(old, new, 1))
PY
WEAK_OK=$?
python3 - "$WEAK/control.ts" "$WEAK/nopacing.ts" <<'PY2'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
old = "const RETRY_PACING_MS = 25;"
new = "const RETRY_PACING_MS = 0; // DELIBERATELY WEAKENED (teeth proof, not repository code)"
if old not in s:
    sys.stderr.write("WARN: pacing constant not found verbatim\n"); sys.exit(1)
open(dst, "w").write(s.replace(old, new, 1))
PY2
# Copies P11 needs: one with the report cap effectively removed (so the harness
# learns the FULL message and can check that the real one is only a CUT of it),
# and one with the word-boundary search disabled (an opportunistic teeth demo).
python3 - "$WEAK/control.ts" "$WEAK/untrunc.ts" "$WEAK/noboundary.ts" <<'PY3'
import sys
src, unb, nob = sys.argv[1:4]
s = open(src).read()
cap = "const REPORT_MAX_CHARS = 500;"
bnd = 'const lastSpace = cut.lastIndexOf(" ");'
if cap not in s:
    sys.stderr.write("WARN: report cap constant not found verbatim\n"); sys.exit(1)
open(unb, "w").write(s.replace(cap, "const REPORT_MAX_CHARS = 100000; // TEETH COPY: cap effectively removed", 1))
if bnd in s:
    open(nob, "w").write(s.replace(bnd, 'const lastSpace = -1; // DELIBERATELY WEAKENED: no word-boundary search', 1))
PY3

# WK1's teeth: a copy of extension/worker.ts whose worker sessions get a
# FILE-BACKED SettingsManager instead of the read-only snapshot one (AF8/AF9).
# That is the defect the real module exists to prevent: with it, a worker-side
# setModel/setThinkingLevel — which every per-dispatch route performs — persists
# into the user's GLOBAL settings. Derived from the module under test by one
# textual transformation, like every other weakened copy, so it cannot go stale.
mkcopy "$REPO/extension/worker.ts" "$WEAK/worker-control.ts"
python3 - "$WEAK/worker-control.ts" "$WEAK/worker-filebacked.ts" <<'PY5'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
m = re.search(r"^\tconst settingsManager = SettingsManager\.fromStorage\(.*?^\t\);\n", s, re.S | re.M)
if not m:
    sys.stderr.write("WARN: worker.ts's read-only SettingsManager not found in a recognisable shape\n"); sys.exit(1)
weak = ("\t// DELIBERATELY WEAKENED (teeth proof, NOT repository code): a FILE-BACKED\n"
        "\t// settings manager, so a worker-side setModel/setThinkingLevel persists into\n"
        "\t// the global settings — the pre-AF8/AF9 defect WK1 exists to catch.\n"
        "\tconst settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: trusted });\n")
open(dst, "w").write(s[:m.start()] + weak + s[m.end():])
PY5

# The pre-fix module for the P5a/P5b teeth proof, DERIVED FROM THE CURRENT
# MODULE at run time, exactly like the other weakened copies. It used to be
# recovered from git history (find the commit that introduced planPairRestore,
# take its parent) - which silently loses its teeth on a shallow clone and
# permanently once this branch squash-merges (WH9). Committing a snapshot of the
# old file would go stale instead. So the transformation reintroduces the defect
# itself: decide each half of the pair INDEPENDENTLY and re-state the other half
# at its current on-disk value, which is what the pre-fix revision did and what
# produces the mixed pair / provider-less model P5a and P5b exist to catch.
# --old-module still overrides. If the transformation cannot be applied, those
# rungs report NOT RUN - never a PASS whose teeth were not shown.
OLDMOD=""; OLDMOD_SRC=""
if [ -n "$OLDMOD_ARG" ]; then
	[ -f "$OLDMOD_ARG" ] || die "--old-module '$OLDMOD_ARG' not found"
	mkcopy "$OLDMOD_ARG" "$WEAK/perhalf.ts"; OLDMOD="$WEAK/perhalf.ts"; OLDMOD_SRC="--old-module $OLDMOD_ARG"
elif python3 - "$WEAK/control.ts" "$WEAK/perhalf.ts" <<'PY4'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
m = re.search(r"^function planPairRestore\(.*?^\}\n", s, re.S | re.M)
if not m:
    sys.stderr.write("planPairRestore not found in a recognisable shape\n"); sys.exit(1)
body = """function planPairRestore(
\tpre: GlobalDefaults,
\tpost: GlobalDefaults,
\texpected: ExpectedValues,
): { provider: string | undefined; model: string | undefined } | undefined {
\t// DELIBERATELY WEAKENED (teeth proof, NOT repository code): the pre-fix rule.
\t// Each half is decided on its own and the OTHER half is re-stated at its
\t// CURRENT on-disk value, so a third party's half can be welded onto slate's
\t// pre-switch half - a pair pi itself can never write.
\tconst restoreProvider = post.provider !== pre.provider && post.provider === expected.provider;
\tconst restoreModel = post.model !== pre.model && post.model === expected.model;
\tif (!restoreProvider && !restoreModel) return undefined;
\treturn {
\t\tprovider: restoreProvider ? pre.provider : post.provider,
\t\tmodel: restoreModel ? pre.model : post.model,
\t};
}
"""
open(dst, "w").write(s[:m.start()] + body + s[m.end():])
PY4
then
	OLDMOD="$WEAK/perhalf.ts"; OLDMOD_SRC="a per-half variant derived from the current module"
fi

# probe runner: $1 label, $2 module, $3 target, $4 queue, $5 inject, rest = extra pi args
runprobe() {
	local label="$1" module="$2" target="$3" queue="$4" inject="$5"; shift 5
	snapshot "$label-before.json"
	piexec PROBE_MODULE="$module" PROBE_TARGET="$target" PROBE_QUEUE="$queue" PROBE_INJECT="$inject" \
		PROBE_RESULT="$OUT/$label.json" timeout 180 pi --no-extensions -e "$PROBE" "$@" -p "x" \
		> "$OUT/$label.out" 2> "$OUT/$label.err"
	assert_agent_dir "$AGENT" "reset the settings fixture after a probe run"
	chmod 644 "$SETTINGS" 2>/dev/null; rm -rf "$SETTINGS.lock"
	snapshot "$label-after.json"
}
# probe runner against an ALTERNATE agent dir (P11 pins the settings-path length):
# $1 agent dir, $2 label, $3 module, $4 inject, rest = extra pi args
runprobe_at() {
	local ag="$1" label="$2" module="$3" inject="$4"; shift 4
	piexec_at "$ag" PROBE_MODULE="$module" PROBE_TARGET=probe-c/gamma-1 PROBE_QUEUE=0 PROBE_INJECT="$inject" \
		PROBE_RESULT="$OUT/$label.json" timeout 180 pi --no-extensions -e "$PROBE" "$@" -p "x" \
		> "$OUT/$label.out" 2> "$OUT/$label.err"
	assert_agent_dir "$ag" "reset the settings fixture after a probe run"
	chmod 644 "$ag/settings.json" 2>/dev/null; rm -rf "$ag/settings.json.lock"
}

# end-to-end failover runner: $1 label, rest = extra pi args
runfailover() {
	local label="$1"; shift
	snapshot "$label-before.json"
	piexec timeout 180 pi --no-extensions -e "$REPO" "$@" -p "say ok" > "$OUT/$label.out" 2> "$OUT/$label.err"
	mark_slate_child_ran
	snapshot "$label-after.json"
}

# ------------------------------------------------------- handoff-adoption prep
HANDOFF_NAME=""; HANDOFF_FILE=""
seed_handoff() { # $1 provider, $2 id, $3 thinkingLevel or "-"
	local result
	result=$(piexec node --input-type=module - "$REPO" "$WORK" "$1" "$2" "$3" <<'NODE'
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [repo, cwd, provider, id, thinking] = process.argv.slice(2);
const corpus = await import(pathToFileURL(`${repo}/extension/corpus.ts`).href);
const handoff = await import(pathToFileURL(`${repo}/extension/handoff-record.ts`).href);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const identity = `${stamp}-${randomBytes(8).toString("hex")}`;
const source = corpus.createCorpusSession({ cwd, identity, initialNameBytes: randomBytes(4) });
const record = {
  version: 1,
  author: { identity, name: source.name },
  authorSessionDirectory: source.directory,
  createdAt: Date.now(),
  worktreePath: realpathSync(cwd),
  branchLabel: corpus.currentBranchLabel(cwd),
  parentChain: [],
  brief: "ladder",
  model: { provider, id },
  ...(thinking === "-" ? {} : { thinkingLevel: thinking }),
  snapshot: {
    threads: [], episodes: [], threadSeq: 0,
    slateSessionId: identity, slateSessionName: source.name,
    ownerSessionDigest: "a".repeat(64),
    orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0,
  },
};
const file = handoff.writeCorpusHandoffRecord(source.project, record);
process.stdout.write(`${source.name}\t${file}`);
NODE
	) || die "could not seed a corpus handoff record"
	HANDOFF_NAME=${result%%$'\t'*}
	HANDOFF_FILE=${result#*$'\t'}
	[ -n "$HANDOFF_NAME" ] && [ -f "$HANDOFF_FILE" ] || die "corpus handoff seeder returned no usable record"
}
runadopt() { # $1 label, rest = extra pi args
	local label="$1" input="$LAB/$1-adopt.in" rc sid; shift
	sid=$(python3 -c 'import uuid;print(uuid.uuid4())') || die "cannot mint the adoption session id"
	[ -n "$HANDOFF_NAME" ] && [ -f "$HANDOFF_FILE" ] || die "runadopt has no seeded corpus handoff record"
	rm -f "$input"; mkfifo "$input" || die "cannot create the explicit-adoption rpc fifo"
	snapshot "$label-before.json"
	piexec timeout 180 pi --no-extensions -e "$REPO" --mode rpc --session-id "$sid" -a "$@" < "$input" \
		> "$OUT/$label.out" 2> "$OUT/$label.err" &
	local child=$!; exec 9>"$input"
	printf '{"id":"adopt","type":"prompt","message":"/slate adopt %s"}\n' "$HANDOFF_NAME" >&9
	for _ in $(seq 1 600); do grep -q '"id":"adopt".*"success":true' "$OUT/$label.out" 2>/dev/null && break; sleep 0.1; done
	# A slash command alone stays in pi's in-memory RPC session. Queue one ordinary
	# prompt so SessionManager flushes the model/thinking entries used as evidence.
	printf '{"id":"evidence","type":"prompt","message":"persist ladder session evidence"}\n' >&9
	for _ in $(seq 1 600); do grep -q '"id":"evidence"' "$OUT/$label.out" 2>/dev/null && break; sleep 0.1; done
	exec 9>&-; wait "$child"; rc=$?
	rm -f "$input"
	[ "$rc" -eq 0 ] || printf 'runadopt child exit=%s\n' "$rc" >> "$OUT/$label.err"
	mark_slate_child_ran
	snapshot "$label-after.json"
}

cd "$WORK" || die "cannot enter the project work dir '$WORK'"
echo "lab   = $LAB"
echo "repo  = $REPO ($(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo 'not a git checkout'))"
echo "agent = $AGENT"
echo "teeth = ${OLDMOD_SRC:-<pre-fix variant unavailable: P5a/P5b will report NOT RUN>}"
echo

# --setup-only: every guard has fired, every fixture and generated module copy is
# built. Stop here. This is the supported way to exercise the safety machinery
# without launching pi at all — previously people used an unknown --only id for
# that, which is now (correctly) a hard error.
if [ "$SETUP_ONLY" = 1 ]; then
	release_lab_lock || exit 1
	echo "SETUP OK — guards passed, fixtures and generated copies built; no rungs run by request (--setup-only)."
	echo "artifacts: $OUT"
	exit 0
fi

# =============================================================================
# Part 3 — core ladder
# =============================================================================

# R1 positive on-disk assertion, switch proven from the session record
if want R1; then
	slatecfg '{ "modelFailover": { "probe-a/alpha-1": "probe-b/beta-1" } }'
	seed "$CANON"; runfailover R1
	if ! switch_seen probe-b beta-1; then fail R1 "failover never fired — rung is vacuous"
	elif cmp -s "$OUT/R1-before.json" "$OUT/R1-after.json"; then
		pass R1 "failover probe-a/alpha-1⇒probe-b/beta-1 fired (model_change in session), settings byte-identical $(sha "$OUT/R1-after.json")"
	else fail R1 "settings changed: $(triple)"; fi
fi

# R2 negative control: knob off must leak
if want R2; then
	slatecfg '{ "modelFailover": { "probe-a/alpha-1": "probe-b/beta-1" }, "preserveGlobalModelDefault": false }'
	seed "$CANON"; runfailover R2
	if [ "$(triple)" = "probe-b/beta-1:medium" ]; then pass R2 "leak reappears with the knob off: $(triple)"
	else fail R2 "expected probe-b/beta-1:medium, got $(triple)"; fi
fi

# R3a thinking-level clamp leak (xhigh -> high) restored
if want R3a; then
	slatecfg '{ "modelFailover": { "probe-a/alpha-1": "probe-c/gamma-1" }, "preserveGlobalModelDefault": false }'
	seed "$CANON_XHIGH"; runfailover R3a-off
	OFF=$(triple)
	slatecfg '{ "modelFailover": { "probe-a/alpha-1": "probe-c/gamma-1" } }'
	seed "$CANON_XHIGH"; runfailover R3a
	if ! switch_seen probe-c gamma-1; then fail R3a "no model_change to probe-c/gamma-1 in the session record — the switch never fired, so the rung is vacuous"
	elif [ "$OFF" != "probe-c/gamma-1:high" ]; then fail R3a "control did not leak the clamped level (got $OFF)"
	elif cmp -s "$OUT/R3a-before.json" "$OUT/R3a-after.json"; then pass R3a "clamp leak $OFF restored to $(triple), byte-identical"
	else fail R3a "not restored: $(triple)"; fi
fi

# R3b thinking-level-ONLY divergence through the failover site
if want R3b; then
	PAIR_AT_TARGET='{
  "defaultProvider": "probe-c",
  "defaultModel": "gamma-1",
  "defaultThinkingLevel": "xhigh",
  "retry": {
    "enabled": false
  }
}'
	slatecfg '{ "modelFailover": { "probe-a/alpha-1": "probe-c/gamma-1" }, "preserveGlobalModelDefault": false }'
	seed "$PAIR_AT_TARGET"; runfailover R3b-off --provider probe-a --model alpha-1
	OFF=$(triple)
	slatecfg '{ "modelFailover": { "probe-a/alpha-1": "probe-c/gamma-1" } }'
	seed "$PAIR_AT_TARGET"; runfailover R3b --provider probe-a --model alpha-1
	if ! switch_seen probe-c gamma-1; then fail R3b "no model_change to probe-c/gamma-1 in the session record — the switch never fired, so the rung is vacuous"
	elif [ "$OFF" != "probe-c/gamma-1:high" ]; then fail R3b "control did not produce a thinking-only leak (got $OFF)"
	elif cmp -s "$OUT/R3b-before.json" "$OUT/R3b-after.json"; then pass R3b "thinking-only leak $OFF restored, pair untouched, byte-identical"
	else fail R3b "not restored: $(triple)"; fi
fi

# R4a explicit handoff adoption, thinking-level key written ALONE (equality guard skips setModel)
if want R4a; then
	slatecfg '{ "modelFailover": {}, "preserveGlobalModelDefault": false }'
	seed "$CANON"; seed_handoff probe-a alpha-1 low; R4A_OFF_RECORD="$HANDOFF_FILE"; runadopt R4a-off
	OFF=$(triple)
	slatecfg '{ "modelFailover": {} }'
	seed "$CANON"; seed_handoff probe-a alpha-1 low; R4A_RECORD="$HANDOFF_FILE"; runadopt R4a
	if ! said "$OUT/R4a-off.err" 'adopted successfully' || ! said "$OUT/R4a.err" 'adopted successfully'; then fail R4a "explicit /slate adopt emitted no positive success marker — silence cannot prove adoption"
	elif ! thinking_change_seen low; then fail R4a "no thinking_level_change to low in the session record — adoption never set the level, so the rung is vacuous"
	elif [ "$OFF" != "probe-a/alpha-1:low" ]; then fail R4a "control did not leak the thinking key alone (got $OFF)"
	elif [ ! -f "$R4A_OFF_RECORD" ] || [ ! -f "$R4A_RECORD" ]; then fail R4a "explicit adoption consumed a corpus handoff record"
	elif cmp -s "$OUT/R4a-before.json" "$OUT/R4a-after.json"; then pass R4a "named adoption succeeded without consuming its record; thinking-only leak $OFF restored byte-identically"
	else fail R4a "not restored: $(triple)"; fi
fi

# R4b explicit handoff adoption, model + thinking
if want R4b; then
	slatecfg '{ "modelFailover": {}, "preserveGlobalModelDefault": false }'
	seed "$CANON_XHIGH"; seed_handoff probe-c gamma-1 xhigh; R4B_OFF_RECORD="$HANDOFF_FILE"; runadopt R4b-off
	OFF=$(triple)
	slatecfg '{ "modelFailover": {} }'
	seed "$CANON_XHIGH"; seed_handoff probe-c gamma-1 xhigh; R4B_RECORD="$HANDOFF_FILE"; runadopt R4b
	if ! said "$OUT/R4b-off.err" 'adopted successfully' || ! said "$OUT/R4b.err" 'adopted successfully'; then fail R4b "explicit /slate adopt emitted no positive success marker — silence cannot prove adoption"
	elif ! switch_seen probe-c gamma-1; then fail R4b "no model_change to probe-c/gamma-1 in the session record — adoption never switched, so the rung is vacuous"
	elif ! thinking_change_seen high; then fail R4b "no thinking_level_change to high in the session record — adoption never set the level, so the rung is vacuous"
	elif [ "$OFF" != "probe-c/gamma-1:high" ]; then fail R4b "control did not leak (got $OFF)"
	elif [ ! -f "$R4B_OFF_RECORD" ] || [ ! -f "$R4B_RECORD" ]; then fail R4b "explicit adoption consumed a corpus handoff record"
	elif cmp -s "$OUT/R4b-before.json" "$OUT/R4b-after.json"; then pass R4b "named adoption succeeded without consuming its record; model+thinking leak $OFF restored byte-identically"
	else fail R4b "not restored: $(triple)"; fi
fi

# R5a/b/c untrustworthy reads: stand down, warn, never delete
seed_empty()   { assert_agent_dir "$AGENT" "truncate the settings fixture"; : > "$SETTINGS"; }
seed_corrupt() { assert_agent_dir "$AGENT" "write the corrupt settings fixture"
	printf '%s' '{ "defaultProvider": "probe-a", "defaultModel": ' > "$SETTINGS"; }
untrustworthy() { # $1 id, $2 seeder-fn, $3 cause-class regex (synonyms, not prose)
	local id="$1" seeder="$2" frag="$3"
	slatecfg '{ "modelFailover": {} }'
	$seeder; seed_handoff probe-c gamma-1 high; runadopt "$id" --provider probe-a --model alpha-1
	local on_after; on_after=$(sha "$SETTINGS")
	cp -f "$SETTINGS" "$OUT/$id-on-after.json"
	slatecfg '{ "modelFailover": {}, "preserveGlobalModelDefault": false }'
	$seeder; seed_handoff probe-c gamma-1 high; runadopt "$id-off" --provider probe-a --model alpha-1
	local off_after; off_after=$(sha "$SETTINGS")
	if [ ! -f "$SETTINGS" ]; then fail "$id" "BLOCKER: settings file deleted"
	elif ! said_something "$OUT/$id.err"; then fail "$id" "slate emitted no report at all"
	elif ! said "$OUT/$id.err" "$RX_STOOD_DOWN"; then fail "$id" "slate spoke but did not report standing down"
	elif ! names_settings_file "$OUT/$id.err"; then fail "$id" "the report does not name the settings file it means"
	elif ! said "$OUT/$id.err" "$frag"; then fail "$id" "the report does not name this cause class (/$frag/)"
	elif [ "$on_after" != "$off_after" ]; then fail "$id" "slate wrote something the knob-off run did not (on=$on_after off=$off_after)"
	else pass "$id" "stood down, named the settings file and the cause (/$frag/); file intact and identical to the knob-off run ($on_after)"; fi
}
# Cause classes as tolerant alternations: the point is that the report says WHY,
# not that it says it in today's words.
want R5a && untrustworthy R5a 'seed_empty' 'empty|zero.?byte|0 bytes'
want R5b && untrustworthy R5b 'seed_corrupt' 'cannot read|unreadable|not valid JSON|JSON|pars'
if want R5c; then
	cat > "$LAB/holdlock.mjs" <<'EOF' || die "cannot write the lock-holder helper"
import { mkdirSync, utimesSync, rmSync } from "node:fs";
const t = process.argv[2] + ".lock"; const hold = Number(process.argv[3] ?? 30000);
mkdirSync(t); const t0 = Date.now();
const iv = setInterval(() => { const n = new Date(); try { utimesSync(t, n, n); } catch {}
  if (Date.now() - t0 > hold) { clearInterval(iv); try { rmSync(t, { recursive: true, force: true }); } catch {} process.exit(0); } }, 500);
EOF
	runlocked() { # $1 label, $2 knobcfg
		slatecfg "$2"; seed "$CANON_XHIGH"; seed_handoff probe-c gamma-1 high
		assert_agent_dir "$AGENT" "hold the settings lock"
		rm -rf "$SETTINGS.lock"; node "$LAB/holdlock.mjs" "$SETTINGS" 40000 2>/dev/null & local lp=$!
		sleep 0.4; runadopt "$1" --provider probe-a --model alpha-1; kill $lp 2>/dev/null; wait $lp 2>/dev/null; rm -rf "$SETTINGS.lock"
	}
	runlocked R5c '{ "modelFailover": {} }'; ON=$(sha "$SETTINGS"); cp -f "$SETTINGS" "$OUT/R5c-on-after.json"
	runlocked R5c-off '{ "modelFailover": {}, "preserveGlobalModelDefault": false }'; OFFH=$(sha "$SETTINGS")
	# 'Lock file is already being held' is pi's (proper-lockfile's) wording, not
	# slate's, so it is matched as a tolerant cause class too.
	if ! said_something "$OUT/R5c.err"; then fail R5c "slate emitted no report at all"
	elif ! said "$OUT/R5c.err" "$RX_STOOD_DOWN"; then fail R5c "slate spoke but did not report standing down"
	elif ! said "$OUT/R5c.err" '[Ll]ock'; then fail R5c "the report does not name the lock as the cause"
	elif ! names_settings_file "$OUT/R5c.err"; then fail R5c "the report does not name the settings file it means"
	elif ! cmp -s "$OUT/R5c-before.json" "$OUT/R5c-on-after.json"; then fail R5c "settings modified under a held lock"
	elif [ "$ON" != "$OFFH" ]; then fail R5c "slate wrote something the knob-off run did not"
	else pass R5c "stood down under a held lock, naming the lock and the settings file; settings byte-identical ($ON)"; fi
fi

# R6 mid-session third-party change survives session end
if want R6; then
	slatecfg '{ "modelFailover": { "probe-a/alpha-1": "probe-c/gamma-1" } }'
	seed "$CANON_XHIGH"; snapshot "R6-before.json"
	rm -f "$LAB/r6.in"; mkfifo "$LAB/r6.in"
	piexec timeout 120 pi --no-extensions -e "$REPO" --mode rpc < "$LAB/r6.in" > "$OUT/R6.out" 2> "$OUT/R6.err" &
	R6PID=$!; exec 9>"$LAB/r6.in"; sleep 1
	echo '{"id":"1","type":"prompt","message":"say ok"}' >&9
	for _ in $(seq 1 100); do grep -q '"provider":"probe-c"' "$OUT/R6.out" 2>/dev/null && break; sleep 0.1; done
	sleep 1
	assert_agent_dir "$AGENT" "write the third-party settings change"
	printf '%s' '{
  "defaultProvider": "probe-b",
  "defaultModel": "beta-1",
  "defaultThinkingLevel": "low",
  "retry": {
    "enabled": false
  }
}' > "$SETTINGS"
	cp -f "$SETTINGS" "$OUT/R6-thirdparty.json"; sleep 1
	exec 9>&-; wait $R6PID; R6EXIT=$?
	mark_slate_child_ran
	snapshot "R6-after.json"
	# Assert the switch from the SESSION RECORD (same structural check as R1), not
	# from the RPC event stream — the stdout scan above is only a poll heuristic.
	if ! switch_seen probe-c gamma-1; then fail R6 "failover never fired in rpc mode — rung vacuous"
	elif cmp -s "$OUT/R6-thirdparty.json" "$OUT/R6-after.json"; then pass R6 "mid-session third-party change survived session end (pi exit=$R6EXIT)"
	else fail R6 "third-party change was altered: $(triple)"; fi
fi

# R7 write failure is reported, not swallowed
if want R7; then
	seed "$CANON_XHIGH"; runprobe R7 "$REPO/extension/model-default.ts" probe-c/gamma-1 0 chmod --provider probe-a --model alpha-1
	# Anchored on: slate spoke; it used the "tried and could not restore" verb
	# (as opposed to "could not check" — see P9b); it named the affected keys, the
	# settings file and the cause class. No advisory prose is required: reports are
	# truncated diagnostics-first, so the tail may legitimately be absent (P11).
	if ! said_something "$OUT/R7.err"; then fail R7 "no write-failure report on stderr"
	elif ! said "$OUT/R7.err" "$RX_TRIED_RESTORE"; then fail R7 "the report does not say the restore was attempted and failed"
	elif ! said "$OUT/R7.err" 'EACCES|permission denied'; then fail R7 "the report does not name the write failure as the cause"
	elif ! said "$OUT/R7.err" 'keys:'; then fail R7 "the report does not name the affected keys"
	elif ! names_settings_file "$OUT/R7.err"; then fail R7 "the report does not name the settings file it means"
	else pass R7 "write failure reported on stderr with the attempted-restore verb, the affected keys, the settings path and the cause (EACCES); wrapper returned normally"; fi
fi

# R8 wall-clock bound under a lock taken right after the switch
if want R8; then
	seed "$CANON_XHIGH"; runprobe R8 "$REPO/extension/model-default.ts" probe-c/gamma-1 0 lock --provider probe-a --model alpha-1
	EL=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["elapsedMs"])' "$OUT/R8.json" 2>/dev/null || echo -1)
	# Anchored on the semantic verb ("could not check" = divergence never
	# established) plus the settings path. NOT on the duration or the advisory
	# tail: the duration moved out of the headline into an advisory clause, and
	# reports are truncated diagnostics-first, so any advisory clause may be cut
	# entirely on a long settings path. The BOUND itself is asserted from the
	# measured elapsed time below, which is what actually proves it.
	if ! said_something "$OUT/R8.err"; then fail R8 "no bounded-abandon report on stderr"
	elif ! said "$OUT/R8.err" "$RX_ONLY_CHECKED"; then fail R8 "the report does not say divergence could not be established"
	elif ! names_settings_file "$OUT/R8.err"; then fail R8 "the report does not name the settings file it means"
	elif [ "$EL" -ge 400 ] && [ "$EL" -le 1700 ]; then pass R8 "abandoned after ${EL} ms (budget 500 ms, documented ceiling ~1.58 s); reported, did not hang"
	else fail R8 "elapsed ${EL} ms outside the expected band"; fi
fi

# =============================================================================
# Part 1 — gaps the review found in the previous ladder
# =============================================================================

# G1 the yield rung, WITH a teeth proof
if want G1; then
	QD=16
	seed "$CANON"; runprobe G1-real "$REPO/extension/model-default.ts" probe-c/gamma-1 $QD none --provider probe-a --model alpha-1
	REAL=$(triple); PEND=$(grep -o 'pending = [a-z]*' "$OUT/G1-real.err" | tail -1 | awk '{print $3}')
	# Captured HERE: the weakened runs below replace the newest session record.
	G1SW=no; switch_seen probe-c gamma-1 && G1SW=yes
	if [ ! -f "$WEAK/microtask.ts" ]; then skip G1 "weakened copy could not be produced (yield helper not found verbatim)"
	else
		seed "$CANON"; runprobe G1-weak "$WEAK/microtask.ts" probe-c/gamma-1 $QD none --provider probe-a --model alpha-1
		WEAKRES=$(triple)
		seed "$CANON"; runprobe G1-weak-q0 "$WEAK/microtask.ts" probe-c/gamma-1 0 none --provider probe-a --model alpha-1
		WEAK0=$(triple)
		if [ "$G1SW" != yes ]; then fail G1 "no model_change to probe-c/gamma-1 in the session record — the switch never fired, so the rung is vacuous"
		elif [ "$PEND" != "true" ]; then skip G1 "write queue was not deep enough at depth $QD (pi's write had already landed before the yield), so the rung has no teeth — raise QD; a pi upgrade can change the number of internal awaits in setModel"
		elif [ "$WEAKRES" != "probe-c/gamma-1:medium" ]; then fail G1 "weakened (microtask) module did NOT leak at depth $QD — rung has no teeth (got $WEAKRES)"
		elif [ "$REAL" != "probe-a/alpha-1:medium" ]; then fail G1 "real module leaked at depth $QD: $REAL"
		else pass G1 "at queue depth $QD pi's write is still pending after setModel; real module restores ($REAL) while the microtask-yield copy leaks ($WEAKRES); the same copy passes at depth 0 ($WEAK0) — teeth proven"; fi
	fi
fi

# G2 transient write failure: the retry must use the ORIGINAL pre-switch reference
if want G2; then
	seed "$CANON_XHIGH"
	runprobe G2 "$REPO/extension/model-default.ts" probe-c/gamma-1 0 chmod-transient:150 --provider probe-a --model alpha-1
	EL=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["elapsedMs"])' "$OUT/G2.json" 2>/dev/null || echo -1)
	AFTER=$(triple)
	# Either abandon verb means the retry loop gave up — the rung needs it to have
	# SUCCEEDED on a later attempt, so both are disqualifying.
	if said "$OUT/G2.err" "$RX_TRIED_RESTORE|$RX_ONLY_CHECKED"; then fail G2 "restore was abandoned; the transient window was too long"
	elif [ "$AFTER" != "probe-a/alpha-1:xhigh" ]; then fail G2 "restored value is not the ORIGINAL pre-switch state: $AFTER"
	elif [ "$EL" -lt 140 ]; then fail G2 "completed in ${EL} ms — the first attempt cannot have failed, rung is vacuous"
	else pass G2 "first write attempt failed (EACCES for 150 ms), a later one succeeded after ${EL} ms, and the value written back is the ORIGINAL pre-switch state $AFTER"; fi
fi

# G4a same-provider, model-only divergence
if want G4a; then
	slatecfg '{ "modelFailover": { "probe-a/alpha-1": "probe-a/alpha-2" }, "preserveGlobalModelDefault": false }'
	seed "$CANON"; runfailover G4a-off
	OFF=$(triple)
	slatecfg '{ "modelFailover": { "probe-a/alpha-1": "probe-a/alpha-2" } }'
	seed "$CANON"; runfailover G4a
	if ! switch_seen probe-a alpha-2; then fail G4a "no model_change to probe-a/alpha-2 in the session record — the switch never fired, so the rung is vacuous"
	elif [ "$OFF" != "probe-a/alpha-2:medium" ]; then fail G4a "control did not produce a model-only leak (got $OFF)"
	elif cmp -s "$OUT/G4a-before.json" "$OUT/G4a-after.json"; then pass G4a "same-provider model-only leak $OFF restored, byte-identical"
	else fail G4a "not restored: $(triple)"; fi
fi

# G4b thinking-level key ABSENT beforehand while the pair is present
if want G4b; then
	NOTHINK='{
  "defaultProvider": "probe-a",
  "defaultModel": "alpha-1",
  "retry": {
    "enabled": false
  }
}'
	slatecfg '{ "modelFailover": {}, "preserveGlobalModelDefault": false }'
	seed "$NOTHINK"; seed_handoff probe-a alpha-1 high; runadopt G4b-off
	OFF=$(triple)
	slatecfg '{ "modelFailover": {} }'
	seed "$NOTHINK"; seed_handoff probe-a alpha-1 high; runadopt G4b
	HASKEY=$(python3 -c 'import json,sys;print("yes" if "defaultThinkingLevel" in json.load(open(sys.argv[1])) else "no")' "$SETTINGS" 2>/dev/null)
	if ! thinking_change_seen high; then fail G4b "no thinking_level_change to high in the session record — adoption never set the level, so the rung is vacuous"
	elif [ "$OFF" != "probe-a/alpha-1:high" ]; then fail G4b "control did not write the absent thinking key (got $OFF)"
	elif [ "$HASKEY" != "no" ]; then fail G4b "defaultThinkingLevel present after restore — absence not restored"
	elif cmp -s "$OUT/G4b-before.json" "$OUT/G4b-after.json"; then pass G4b "thinking key absent before, written by the switch ($OFF), restored to ABSENCE; byte-identical"
	else fail G4b "file changed: $(triple)"; fi
fi

# =============================================================================
# Part 2 — the newly fixed behaviour
# =============================================================================

# P5a the blocker: a third party changes ONE half of the pair before the post-read
if want P5a; then
	seed "$CANON_XHIGH"
	runprobe P5a "$REPO/extension/model-default.ts" probe-c/gamma-1 0 'patch:{"defaultModel":"beta-1"}' --provider probe-a --model alpha-1
	AFTER=$(triple)
	OLDRES=""
	if [ -n "$OLDMOD" ]; then
		seed "$CANON_XHIGH"
		runprobe P5a-old "$OLDMOD" probe-c/gamma-1 0 'patch:{"defaultModel":"beta-1"}' --provider probe-a --model alpha-1
		OLDRES=$(triple)
	fi
	if [ "$AFTER" = "probe-a/beta-1:xhigh" ]; then fail P5a "BLOCKER reproduced: mixed pair probe-a/beta-1 written"
	elif [ "$AFTER" != "probe-c/beta-1:xhigh" ]; then fail P5a "unexpected end state $AFTER (expected the third party's pair, untouched)"
	elif [ -z "$OLDRES" ]; then skip P5a "end state is correct ($AFTER) but the pre-fix module could not be recovered, so the rung's teeth are unproven — pass --old-module <file> to complete it"
	elif [ "$OLDRES" != "probe-a/beta-1:xhigh" ]; then skip P5a "end state is correct ($AFTER) but the pre-fix module ($OLDMOD_SRC) did not reproduce the mixed pair either (got $OLDRES) — teeth unproven"
	else pass P5a "one half changed by a third party ⇒ whole pair left untouched ($AFTER); the pre-fix module ($OLDMOD_SRC) on the same input produces the mixed pair $OLDRES — teeth proven"; fi
fi

# P5b the absence variant: a restored half would have left a model with no provider
if want P5b; then
	NOPAIR='{
  "defaultThinkingLevel": "xhigh",
  "sentinelKeyMustSurvive": "keep-me",
  "retry": {
    "enabled": false
  }
}'
	seed "$NOPAIR"
	runprobe P5b "$REPO/extension/model-default.ts" probe-c/gamma-1 0 'patch:{"defaultModel":"beta-1"}' --provider probe-a --model alpha-1
	AFTER=$(triple); SENT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("sentinelKeyMustSurvive"))' "$SETTINGS" 2>/dev/null)
	OLDRES=""
	if [ -n "$OLDMOD" ]; then
		seed "$NOPAIR"; runprobe P5b-old "$OLDMOD" probe-c/gamma-1 0 'patch:{"defaultModel":"beta-1"}' --provider probe-a --model alpha-1
		OLDRES=$(triple)
	fi
	if [ "$AFTER" = "None/beta-1:xhigh" ]; then fail P5b "BLOCKER reproduced: defaultModel with no defaultProvider"
	elif [ "$AFTER" != "probe-c/beta-1:xhigh" ]; then fail P5b "unexpected end state $AFTER"
	elif [ "$SENT" != "keep-me" ]; then fail P5b "unrelated key lost"
	elif [ -z "$OLDRES" ]; then skip P5b "end state is correct ($AFTER) but the pre-fix module could not be recovered, so the rung's teeth are unproven — pass --old-module <file> to complete it"
	elif [ "$OLDRES" != "None/beta-1:xhigh" ]; then skip P5b "end state is correct ($AFTER) but the pre-fix module ($OLDMOD_SRC) did not produce a provider-less model either (got $OLDRES) — teeth unproven"
	else pass P5b "absence variant: pair left untouched ($AFTER), sentinel intact; the pre-fix module ($OLDMOD_SRC) produces $OLDRES — a defaultModel with no defaultProvider — teeth proven"; fi
fi

# P6 retry pacing: bounded number of REAL write attempts inside the budget
if want P6; then
	if ! command -v strace >/dev/null 2>&1; then skip P6 "strace not available"
	else
		seed "$CANON_XHIGH"; snapshot "P6-before.json"
		piexec PROBE_MODULE="$REPO/extension/model-default.ts" PROBE_TARGET=probe-c/gamma-1 PROBE_QUEUE=0 \
			PROBE_INJECT=chmod PROBE_RESULT="$OUT/P6.json" \
			timeout 300 strace -f -qq -e trace=openat -o "$OUT/P6.strace" \
			pi --no-extensions -e "$PROBE" --provider probe-a --model alpha-1 -p "x" > "$OUT/P6.out" 2> "$OUT/P6.err"
		assert_agent_dir "$AGENT" "reset the settings fixture after the strace run"
		chmod 644 "$SETTINGS" 2>/dev/null; snapshot "P6-after.json"
		N=$(grep -c "settings\.json\".*O_WRONLY.*EACCES" "$OUT/P6.strace" 2>/dev/null || true); N=${N:-0}
		EL=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["elapsedMs"])' "$OUT/P6.json" 2>/dev/null || echo -1)
		TEETH6=""
		if [ -f "$WEAK/nopacing.ts" ]; then
			seed "$CANON_XHIGH"
			piexec PROBE_MODULE="$WEAK/nopacing.ts" PROBE_TARGET=probe-c/gamma-1 PROBE_QUEUE=0 \
				PROBE_INJECT=chmod PROBE_RESULT="$OUT/P6-nopacing.json" \
				timeout 300 strace -f -qq -e trace=openat -o "$OUT/P6-nopacing.strace" \
				pi --no-extensions -e "$PROBE" --provider probe-a --model alpha-1 -p "x" > /dev/null 2>&1
			chmod 644 "$SETTINGS" 2>/dev/null
			TEETH6=$(grep -c "settings\.json\".*O_WRONLY.*EACCES" "$OUT/P6-nopacing.strace" 2>/dev/null || true)
		fi
		if [ "$N" -eq 0 ]; then skip P6 "no failed settings write syscalls seen in the trace (pattern mismatch); manual review needed"
		elif [ "$N" -gt 60 ]; then fail P6 "$N failed write syscalls in ${EL} ms — pacing not effective"
		elif [ -z "$TEETH6" ] || [ "$TEETH6" -le 60 ]; then skip P6 "$N failed write syscalls in ${EL} ms looks bounded, but the pacing-0 copy could not be built or did not blow the bound (${TEETH6:-n/a}) — teeth unproven"
		else pass P6 "$N failed settings-write syscalls in ${EL} ms; this plan writes the pair AND the thinking level, i.e. 2 writes per attempt ⇒ ~$((N/2)) attempts (budget 500 ms / pacing 25 ms ⇒ ≤ 21 expected) — tens, not hundreds. Teeth: a pacing-0 copy of the same module issues $TEETH6"
		fi
	fi
fi

# P7 monotonic budget: which clock does the budget use?
if want P7; then
	# Comment lines are excluded: the module NAMES Date.now() in prose to explain
	# why it is not used. Only executable references count.
	CODE_DATE=$(python3 - "$REPO/extension/model-default.ts" <<'PYEOF'
import sys, re
hits=[]
for n, line in enumerate(open(sys.argv[1]), 1):
    t = line.strip()
    if t.startswith("*") or t.startswith("//") or t.startswith("/*"):
        continue
    code = re.sub(r"//.*$", "", line)
    if "Date.now()" in code: hits.append(f"{n}:{t[:60]}")
print("; ".join(hits))
PYEOF
)
	# Any executable performance.now() counts — not one exact line — so reformatting
	# or renaming the helper cannot produce a false FAIL.
	CODE_PERF=$(grep -c "performance\.now()" "$REPO/extension/model-default.ts" || true)
	DEADLINE=$(grep -n "deadline\|nowMs()" "$REPO/extension/model-default.ts" | grep -v "^\s*\*" | tr '\n' ' ')
	if [ -n "$CODE_DATE" ]; then fail P7 "executable Date.now() reference(s) in the module: $CODE_DATE"
	elif [ "$CODE_PERF" -lt 1 ]; then fail P7 "the module reads no monotonic clock (no performance.now() anywhere)"
	else pass P7 "budget clock is nowMs() => performance.now() (monotonic); zero executable Date.now() references (the only textual one is prose in a comment). Established by CODE INSPECTION — the system clock was deliberately NOT manipulated. Sites: $DEADLINE"; fi
fi

# P8 sanitised reporting: raw escape bytes next to a syntax error
if want P8; then
	# Fixture: raw ESC/BEL bytes as a BARE token (outside any string literal), which
	# is what makes V8 embed a raw snippet of the file in its parse error. Path via
	# argv, never interpolated into the program text.
	assert_agent_dir "$AGENT" "write the escape-byte settings fixture"
	python3 -c 'import sys
q = b"\""
open(sys.argv[1], "wb").write(b"{ " + q + b"defaultProvider" + q + b": " + q + b"probe-a" + q
                              + b", " + q + b"x" + q + b": \x1b[31mBAD\x07 }")' "$SETTINGS"
	TEETH=$(node -e '
const {readFileSync}=require("fs");
try{JSON.parse(readFileSync(process.argv[1],"utf8"));console.log("no-parse-error")}
catch(e){console.log(e.message.includes("\u001b")||e.message.includes("\u0007")?"raw-escapes-in-parse-error":"no-escapes-in-parse-error")}' "$SETTINGS")
	slatecfg '{ "modelFailover": {} }'
	seed_handoff probe-c gamma-1 high; runadopt P8 --provider probe-a --model alpha-1
	ESC=$(python3 -c 'import sys
lines = open(sys.argv[1], "rb").read().split(b"\n")
mine = [l for l in lines if l.startswith(b"slate:")]
bad = any((b"\x1b" in l or b"\x07" in l) for l in mine)
print("yes" if bad else ("no" if mine else "no-slate-line"))' "$OUT/P8.err")
	PIESC=$(python3 -c 'import sys
lines = open(sys.argv[1], "rb").read().split(b"\n")
others = [l for l in lines if not l.startswith(b"slate:")]
print("yes" if any((b"\x1b" in l or b"\x07" in l) for l in others) else "no")' "$OUT/P8.err")
	if [ "$TEETH" != "raw-escapes-in-parse-error" ]; then skip P8 "the JSON parse error for this fixture carries no raw escapes ($TEETH) — rung would pass vacuously"
	elif ! said_something "$OUT/P8.err"; then fail P8 "no stand-down report emitted at all"
	elif ! said "$OUT/P8.err" "$RX_STOOD_DOWN"; then fail P8 "slate spoke but did not report standing down"
	elif [ "$ESC" = "no" ]; then pass P8 "parse error carries raw ESC/BEL bytes; slate's own stderr line carries none — sanitised (pi's own 'Warning:' lines DO print them raw: $PIESC — pi defect, outside slate)"
	elif [ "$ESC" = "no-slate-line" ]; then fail P8 "slate emitted no line at all"
	else fail P8 "raw escape bytes reached stderr inside slate's own line"; fi
fi

# P9 no false claims when nothing was switched / when divergence is unknown
if want P9a; then
	slatecfg '{ "modelFailover": {} }'
	seed "$CANON_XHIGH"; seed_handoff probe-a alpha-1 -     # model already live, no thinking level => no setter call
	assert_agent_dir "$AGENT" "hold the settings lock"
	rm -rf "$SETTINGS.lock"; node "$LAB/holdlock.mjs" "$SETTINGS" 40000 2>/dev/null & LP=$!
	sleep 0.4; runadopt P9a --provider probe-a --model alpha-1; kill $LP 2>/dev/null; wait $LP 2>/dev/null; rm -rf "$SETTINGS.lock"
	# The command must announce success, while the model-default wrapper itself stays silent.
	P9A_OTHER=$(slate_lines "$OUT/P9a.err" | grep -v 'adopted successfully' | wc -l | tr -d '[:space:]')
	if ! said "$OUT/P9a.err" 'adopted successfully'; then fail P9a "explicit /slate adopt emitted no positive success marker"
	elif [ "$P9A_OTHER" != 0 ]; then fail P9a "wrapper spoke even though no pi setter ran: $(slate_lines "$OUT/P9a.err" | grep -v 'adopted successfully' | head -1)"
	elif [ ! -f "$HANDOFF_FILE" ]; then fail P9a "explicit adoption consumed its corpus handoff record"
	elif ! cmp -s "$OUT/P9a-before.json" "$OUT/P9a-after.json"; then fail P9a "settings changed"
	else pass P9a "named adoption succeeded and retained its record; no setter called ⇒ no post-switch warning and settings stayed untouched under lock"; fi
fi
if want P9b; then
	# Mutual exclusion of the two report verbs is the assertion; the surrounding
	# prose is deliberately not matched.
	if [ ! -f "$OUT/R7.err" ] || [ ! -f "$OUT/R8.err" ]; then skip P9b "needs the R7 and R8 artifacts in the same run"
	elif said "$OUT/R8.err" "$RX_ONLY_CHECKED" && ! said "$OUT/R8.err" "$RX_TRIED_RESTORE" && \
	     said "$OUT/R7.err" "$RX_TRIED_RESTORE" && ! said "$OUT/R7.err" "$RX_ONLY_CHECKED"; then
		pass P9b "divergence never established (post-read always failed) ⇒ reported as 'could not CHECK' with a conditional about the switch; divergence established (write failed) ⇒ 'could not RESTORE' asserting the leak — the two are mutually exclusive, so no unfounded leak claim"
	else fail P9b "the two failure reports do not distinguish 'checked' from 'restored' — an unfounded leak claim is possible"; fi
fi

# P10 success notices off stderr, failure reports still on stderr in print mode
if want P10; then
	slatecfg '{ "modelFailover": { "probe-a/alpha-1": "probe-b/beta-1" } }'
	seed "$CANON"; runfailover P10
	# Structural, and stronger than matching the old success wording: a failover
	# that WORKED must leave NO slate line on stderr at all (success notices are
	# UI-only, and a successful restore is silent). Matching the notice's prose
	# would silently stop discriminating the moment it were reworded.
	SUCC=$(slate_lines "$OUT/P10.err" | wc -l)
	if ! switch_seen probe-b beta-1; then fail P10 "failover did not fire"
	elif [ "$SUCC" -ne 0 ]; then fail P10 "a successful failover still wrote to stderr: $(slate_lines "$OUT/P10.err" | head -1)"
	elif [ ! -f "$OUT/R5a.err" ]; then skip P10 "needs the R5a artifact to confirm failures ARE still visible in print mode"
	elif ! said_something "$OUT/R5a.err"; then fail P10 "failure reporting is no longer visible in print mode"
	else pass P10 "a successful failover leaves no slate line on stderr in -p mode ($SUCC), while a failure report does reach it (R5a)"; fi
fi

# P11 a truncated report is cut on a word boundary, marked, and keeps the
# EVIDENCE while losing only the advisory tail.
#
# Asserted against the FULL message, obtained by running the same scenario
# through a copy of the module whose report cap is removed. So the rung compares
# the real cut position with the real message: it hardcodes no prose, and a
# mid-word cut, a missing marker, rewritten text or lost diagnostics each fail it
# on their own. The settings path is pinned to a fixed length so the cap lands in
# the advisory region on every machine, and padded with a LETTERS-ONLY component
# so a cut inside the path could never be mistaken for a word boundary.
if want P11; then
	# 81 chars: the alignment where the emitted cut lands in the advisory prose AND
	# AND a no-boundary-search copy demonstrably cuts mid-word (teeth). Overridable
	# for diagnosis; the rung still asserts correctly at other lengths, only the
	# teeth demonstration depends on the alignment.
	P11_PATH_LEN=${P11_PATH_LEN:-81}
	P11_BASE=$(( ${#LAB} + 1 + 20 ))   # <lab>/<pad>/agent/settings.json
	P11_PADLEN=$(( P11_PATH_LEN - P11_BASE ))
	if [ ! -f "$WEAK/untrunc.ts" ]; then skip P11 "the cap-removed copy could not be generated, so the full message is unknown — there is nothing to compare a cut against"
	elif [ "$P11_PADLEN" -lt 1 ]; then skip P11 "scratch path too long ($LAB) to pin the settings path at $P11_PATH_LEN chars; re-run with a shorter --lab"
	else
		P11_PAD=$(python3 -c 'import sys;print("p"*int(sys.argv[1]))' "$P11_PADLEN")
		labdir "$P11_PAD/agent" "the P11 agent dir"; P11_AGENT="$LD_OUT"
		CLEAN_DIRS+=("$P11_AGENT")
		assert_agent_dir "$AGENT" "read the fixtures for the P11 agent dir"
		assert_agent_dir "$P11_AGENT" "seed the P11 agent dir"
		cp -f "$AGENT/models.json" "$AGENT/auth.json" "$P11_AGENT/" || die "cannot seed the P11 agent dir"
		p11seed() { assert_agent_dir "$P11_AGENT" "write the P11 settings fixture"
			printf '%s' "$CANON_XHIGH" > "$P11_AGENT/settings.json"; }
		p11seed; cp -f "$P11_AGENT/settings.json" "$OUT/P11-before.json"
		runprobe_at "$P11_AGENT" P11-real "$REPO/extension/model-default.ts" chmod --provider probe-a --model alpha-1
		cp -f "$P11_AGENT/settings.json" "$OUT/P11-after.json"
		p11seed; runprobe_at "$P11_AGENT" P11-full "$WEAK/untrunc.ts" chmod --provider probe-a --model alpha-1
		P11_NB=""
		if [ -f "$WEAK/noboundary.ts" ]; then
			p11seed; runprobe_at "$P11_AGENT" P11-nb "$WEAK/noboundary.ts" chmod --provider probe-a --model alpha-1
			P11_NB="$OUT/P11-nb.err"
		fi
		P11_OUT=$(python3 "$LAB/p11-assert.py" "$OUT/P11-real.err" "$OUT/P11-full.err" "$P11_AGENT/settings.json" "$P11_NB")
		case "$P11_OUT" in
			PASS*) pass P11 "${P11_OUT#PASS }" ;;
			SKIP*) skip P11 "${P11_OUT#SKIP }" ;;
			*)     fail P11 "${P11_OUT#FAIL }" ;;
		esac
	fi
fi

# =============================================================================
# Part 4 — worker-side per-dispatch model/effort switching
# =============================================================================

# WK1 the gap this ladder had: no rung above opens a WORKER session at all, so the
# guarantee that a per-dispatch worker model/effort switch cannot touch the user's
# global defaults (extension/worker.ts's read-only SettingsManager, AF8/AF9) was
# entirely unguarded — and it fails in exactly the silent way the restore
# mechanism does: the switch works, the action runs, the episode is fine, and the
# only symptom appears weeks later as "pi keeps starting on the model some worker
# thread was routed to". Per-action routing makes that switch happen on EVERY
# dispatch, not just on failover, which is what turns the gap into a hazard.
#
# Two phases, two SEPARATE pi processes, so both halves of the claim are asserted:
#   (a) zero bytes — the global settings file is byte-identical across both runs;
#   (b) not sticky — the second process is launched with NO model on the command
#       line, so its session model IS the global default; its worker must open on
#       the seeded default, not on what the first process's worker was switched to.
# Deliberately NOT asserted here: reopening the same THREAD session file can
# legitimately restore the switched model from its own session record (threads.ts
# CQ3) — that is session-scoped state, not a global default, and a different
# mechanism.
if want WK1; then
	wkrun() { # $1 label, $2 worker module, $3 phase, rest = extra pi args
		local label="$1" module="$2" phase="$3"; shift 3
		# PI_OFFLINE: createAgentSession may run a create-time catalogue refresh, and
		# this harness has no network at all. (piexec re-verifies the redirect target.)
		piexec WORKER_MODULE="$module" WORKER_PHASE="$phase" WORKER_RESULT="$OUT/$label.json" \
			timeout 180 pi --no-extensions -e "$LAB/worker-probe.ts" "$@" -p "x" \
			> "$OUT/$label.out" 2> "$OUT/$label.err"
	}
	wkfield() { python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print("UNREADABLE"); sys.exit()
v=d.get(sys.argv[2])
print("none" if v is None else v)' "$1" "$2"; }
	# No slatecfg: the probe loads worker.ts directly and reads no slate config at
	# all, so nothing here depends on what a previous rung left in slate.json.
	seed "$CANON"; snapshot "WK1-before.json"
	wkrun WK1-switch "$REPO/extension/worker.ts" switch --provider probe-a --model alpha-1
	# The mid snapshot localises a leak to ONE phase instead of the pair.
	snapshot "WK1-mid.json"
	wkrun WK1-reopen "$REPO/extension/worker.ts" reopen
	snapshot "WK1-after.json"
	WK_PHASE=both; cmp -s "$OUT/WK1-before.json" "$OUT/WK1-mid.json" && WK_PHASE="the reopen phase" || WK_PHASE="the switch phase"
	WK_ST=$(wkfield "$OUT/WK1-switch.json" status); WK_RT=$(wkfield "$OUT/WK1-reopen.json" status)
	WK_OPEN="$(wkfield "$OUT/WK1-switch.json" openedModel)@$(wkfield "$OUT/WK1-switch.json" openedEffort)"
	WK_SW="$(wkfield "$OUT/WK1-switch.json" switchedModel)@$(wkfield "$OUT/WK1-switch.json" switchedEffort)"
	WK_RE="$(wkfield "$OUT/WK1-reopen.json" reopenedModel)@$(wkfield "$OUT/WK1-reopen.json" reopenedEffort)"
	# Teeth: the same two phases through the file-backed copy must LEAK — otherwise
	# this rung could not fail and says so (NOT RUN), like G1 and P5a/P5b.
	WK_TEETH=""
	if [ -f "$WEAK/worker-filebacked.ts" ]; then
		seed "$CANON"; snapshot "WK1-weak-before.json"
		wkrun WK1-weak-switch "$WEAK/worker-filebacked.ts" switch --provider probe-a --model alpha-1
		wkrun WK1-weak-reopen "$WEAK/worker-filebacked.ts" reopen
		snapshot "WK1-weak-after.json"
		WK_WEAK_TRIPLE=$(triple)
		WK_WEAK_RE="$(wkfield "$OUT/WK1-weak-reopen.json" reopenedModel)@$(wkfield "$OUT/WK1-weak-reopen.json" reopenedEffort)"
		if ! cmp -s "$OUT/WK1-weak-before.json" "$OUT/WK1-weak-after.json"; then
			WK_TEETH="a file-backed copy of worker.ts writes the switch into the global settings ($WK_WEAK_TRIPLE) and a later session's worker then opens on $WK_WEAK_RE"
		elif [ "$WK_WEAK_RE" != "$WK_RE" ]; then
			WK_TEETH="a file-backed copy of worker.ts leaves a later session's worker on $WK_WEAK_RE instead of $WK_RE"
		fi
		# Whatever the copy wrote, the next rung must not inherit it.
		seed "$CANON"
	fi
	if [ "$WK_ST" != ok ]; then fail WK1 "the switch phase did not complete: $(wkfield "$OUT/WK1-switch.json" error)"
	elif [ "$WK_RT" != ok ]; then fail WK1 "the reopen phase did not complete: $(wkfield "$OUT/WK1-reopen.json" error)"
	elif [ "$WK_OPEN" != "probe-a/alpha-1@medium" ]; then fail WK1 "the worker did not open on the seeded default (got $WK_OPEN) — the rung would prove nothing"
	elif [ "$WK_SW" != "probe-c/gamma-1@high" ]; then fail WK1 "the per-dispatch model+effort switch did not take effect on the worker session (got $WK_SW) — rung vacuous"
	elif ! cmp -s "$OUT/WK1-before.json" "$OUT/WK1-after.json"; then fail WK1 "the global settings file was written during $WK_PHASE — now $(triple) (artifacts: WK1-before/mid/after.json)"
	elif [ "$WK_RE" != "probe-a/alpha-1@medium" ]; then fail WK1 "the switch is STICKY: a later session's worker opens on $WK_RE"
	elif [ -z "$WK_TEETH" ]; then skip WK1 "the per-dispatch switch $WK_OPEN⇒$WK_SW wrote nothing and did not stick, but the file-backed copy could not be built or did not leak either — teeth unproven"
	else pass WK1 "a worker-side per-dispatch switch $WK_OPEN⇒$WK_SW took effect on the worker session, wrote ZERO bytes to the global settings ($(sha "$OUT/WK1-after.json")) and did not stick — a later session's worker still opens on $WK_RE. Teeth: $WK_TEETH"; fi
fi

# ------------------------------------------------------------------- latency
if want LAT; then
	lat() { local knob="$1" i t s e; local -a T=()
		slatecfg "{ \"modelFailover\": { \"probe-a/alpha-1\": \"probe-c/gamma-1\" }$knob }"
		for i in 1 2 3 4 5 6 7; do seed "$CANON_XHIGH"; s=$(date +%s%N)
			piexec timeout 120 pi --no-extensions -e "$REPO" -p "say ok" >/dev/null 2>/dev/null
			mark_slate_child_ran
			e=$(date +%s%N); T+=( $(( (e-s)/1000000 )) ); done
		printf '%s\n' "${T[@]}" | sort -n | awk '{a[NR]=$1} END{printf "%s", a[int((NR+1)/2)]}'; }
	MON=$(lat ''); MOFF=$(lat ', "preserveGlobalModelDefault": false')
	echo "LATENCY median knob-on=${MON}ms knob-off=${MOFF}ms delta=$((MON-MOFF))ms (n=7 each)"
	LINES+=("LATENCY median on=${MON}ms off=${MOFF}ms delta=$((MON-MOFF))ms")
fi

# D217-D219 final evidence: sandbox fallback and repository are fatal. The real
# settings content hash is a nonfatal concurrency note.
REAL_AFTER=$(real_content_hash)
FALLBACK_AFTER=$(tree_fingerprint "$FALLBACK_AGENT")
REPO_AFTER=$(repo_fingerprint)
echo
if scratch_gone; then
	echo "verification: the scratch directory disappeared mid-run ($LAB) - the results above are VOID." >&2
	FAIL=$((FAIL+1))
fi
# The aggregate corpus assertion is load-bearing only after a full-slate child
# completed. A subset with no such child reports NOT RUN instead of disappearing.
if [ -f "$OUT/slate-child-ran" ]; then
	if scratch_corpus_has_session; then
		printf 'SAFE   %-6s PASS    — %s\n' "CORPUS" "at least one current-run slate child published a scratch corpus session"
		LINES+=("SAFE CORPUS PASS — at least one current-run slate child published a scratch corpus session")
	else
		FAIL=$((FAIL+1))
		printf 'SAFE   %-6s FAIL    — %s\n' "CORPUS" "SCRATCH CORPUS HAS NO SESSION DIRECTORY AFTER A SLATE CHILD RAN"
		LINES+=("SAFE CORPUS FAIL — scratch corpus has no session directory after a slate child ran")
		echo "verification: the PI_CODING_AGENT_DIR redirect has no positive scratch-corpus evidence. Investigate before trusting any rung above." >&2
	fi
else
	printf 'SAFE   %-6s PASS    — %s\n' "CORPUS" "not applicable: selected rung launches no full-slate child"
	LINES+=("SAFE CORPUS PASS — not applicable: no full-slate child selected")
fi
# WH7, second half: a run that executed no rung at all must never look like
# success. Reaching here with RAN=0 means --only selected nothing runnable.
# --strict: a NOT RUN is a check that could not be made meaningful. A human
# without strace should not be blocked by that; an automated runner must be, or
# a ladder that quietly skipped half its teeth reads as success.
if [ "$STRICT" = 1 ] && [ "$SKIP" -gt 0 ]; then
	echo "verification: --strict: $SKIP check(s) reported NOT RUN, which is fatal in strict mode." >&8
	printf '%s\n' "${LINES[@]}" | grep 'NOT RUN' | sed 's/^/       /' >&8
	FAIL=$((FAIL+1))
fi
if [ "$RAN" -eq 0 ]; then
	echo "verification: NO RUNG RAN. --only='${ONLY}' matched nothing runnable, so this run proves nothing." >&2
	echo "       Use --list-rungs to see the ids, or --setup-only to exercise the guards alone." >&2
	FAIL=$((FAIL+1))
fi
if [ "$FALLBACK_BEFORE" != "$FALLBACK_AFTER" ]; then
	FAIL=$((FAIL+1))
	printf 'SAFE   %-6s FAIL    — %s\n' "HOME" "throwaway HOME fallback agent changed — redirect loss is possible"
	LINES+=("SAFE HOME FAIL — fallback agent changed: before $FALLBACK_BEFORE after $FALLBACK_AFTER")
else
	printf 'SAFE   %-6s PASS    — %s\n' "HOME" "throwaway HOME fallback agent remained untouched"
	LINES+=("SAFE HOME PASS — throwaway HOME fallback agent untouched")
fi
declare -a SESSION_EVIDENCE_AGENTS=()
if [ -f "$PI_LEDGER" ]; then mapfile -t SESSION_EVIDENCE_AGENTS < <(sort -u "$PI_LEDGER"); fi
if [ "${#SESSION_EVIDENCE_AGENTS[@]}" -eq 0 ]; then
	printf 'SAFE   %-6s PASS    — %s\n' "SESSION" "not applicable: guarded launcher started no pi child"
	LINES+=("SAFE SESSION PASS — not applicable: guarded launcher started no pi child")
else
	for session_agent in "${SESSION_EVIDENCE_AGENTS[@]}"; do
		assert_agent_dir "$session_agent" "validate runtime-recorded session evidence"
		if [ -d "$session_agent/sessions" ] && find "$session_agent/sessions" -type f -name '*.jsonl' -print -quit | grep -q .; then
			printf 'SAFE   %-6s PASS    — %s\n' "SESSION" "current-run session evidence exists under $session_agent"
			LINES+=("SAFE SESSION PASS — evidence under $session_agent")
		else
			FAIL=$((FAIL+1)); printf 'SAFE   %-6s FAIL    — %s\n' "SESSION" "runtime-recorded agent has no session evidence: $session_agent"
			LINES+=("SAFE SESSION FAIL — no evidence under $session_agent")
		fi
	done
fi
if [ "$REPO_BEFORE" != "$REPO_AFTER" ]; then
	FAIL=$((FAIL+1))
	printf 'SAFE   %-6s FAIL    — %s\n' "REPO" "repository fingerprint changed — before $REPO_BEFORE after $REPO_AFTER"
	LINES+=("SAFE REPO FAIL — before $REPO_BEFORE after $REPO_AFTER")
else
	printf 'SAFE   %-6s PASS    — %s\n' "REPO" "repository fingerprint unchanged $REPO_AFTER"
	LINES+=("SAFE REPO PASS — repository fingerprint unchanged $REPO_AFTER")
fi
if [ "$REAL_BEFORE" != "$REAL_AFTER" ]; then
	printf 'NOTE   %-6s         — %s\n' "REAL" "real settings content changed concurrently — before $REAL_BEFORE after $REAL_AFTER; verdict unchanged"
	LINES+=("NOTE REAL — settings content changed concurrently; verdict unchanged")
else
	printf 'NOTE   %-6s         — %s\n' "REAL" "real settings content hash unchanged $REAL_AFTER; diagnostic only"
	LINES+=("NOTE REAL — settings content hash unchanged; diagnostic only")
fi

echo "== summary: $PASS pass, $FAIL fail, $SKIP not run =="
printf '%s\n' "${LINES[@]}" > "$OUT/summary.txt"
echo "artifacts: $OUT"
[ "$FAIL" -eq 0 ]
