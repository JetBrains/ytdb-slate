#!/usr/bin/env bash
# =============================================================================
# slate — writing-reminder hook/steer integration check
# =============================================================================
# Starts one real pi session against a deterministic in-process fake provider.
# The first model response calls two real canary tools. Slate's real tool_result
# hook steers one hidden custom message. The second model call must receive that
# exact message, and pi must persist it in session JSONL with display:false.
#
# Pi startup runs offline, and the fake provider performs no network operation.
# This is not a network sandbox. Reviewed extension code can still open sockets.
# The child receives an empty environment with only explicit throwaway values.
#
# This check does not prove visual TUI invisibility. It proves the SDK-visible
# contract behind invisibility by asserting display:false structurally. A PTY
# smoke test remains manual.
#
# Usage: bash verification/run-writing-reminder-check.sh --repo .
# Exit status: 0 all checks passed · 1 a check failed · 2 refused to start.
# =============================================================================
set -uo pipefail

exec 8>&2
die() { echo "verification: refused to start — $*" >&8; exit 2; }

REPO="."
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || die "option '--repo' requires a value"; REPO="$2"; shift 2 ;;
		-h|--help) sed -n '2,18p' "$0"; exit 0 ;;
		*) die "unknown argument '$1' (try --help)" ;;
	esac
done

# Every external command used below is checked before the first scratch write.
# Shell builtins such as cd, printf, command, and pwd need no executable.
for tool in node mktemp timeout mkdir rm date env cat tr sed; do
	command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
TIMEOUT_VERSION="$(timeout --version 2>/dev/null)" || die "cannot inspect timeout version"
case "$TIMEOUT_VERSION" in *"GNU coreutils"*) ;; *) die "timeout is not GNU coreutils; --kill-after support is required" ;; esac
REPO="$(cd "$REPO" 2>/dev/null && pwd -P)" || die "bad --repo: not a directory"
[ -f "$REPO/extension/index.ts" ] || die "the extension entry point is missing: $REPO/extension/index.ts"
CANARY="$REPO/verification/writing-reminder-canary.mjs"
[ -f "$CANARY" ] || die "the canary extension is missing: $CANARY"
[ -f "$REPO/package.json" ] || die "not a slate checkout: $REPO/package.json is missing"

PIN="$(node -e '
const fs=require("node:fs");
try { const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const v=p.devDependencies?.["@earendil-works/pi-coding-agent"]; if(typeof v==="string") process.stdout.write(v); } catch {}' "$REPO/package.json")" || die "cannot read package.json"
[ -n "$PIN" ] || die "package.json has no @earendil-works/pi-coding-agent devDependency pin"
if [ -n "${PI_BIN:-}" ]; then
	PI="$PI_BIN"
	echo "NOTE   PI_BIN override in use: $PI"
else
	PI="$REPO/node_modules/.bin/pi"
fi
[ -x "$PI" ] || die "no executable pi CLI at $PI; run 'npm ci --ignore-scripts' or set PI_BIN"
PIVER="$("$PI" --version 2>/dev/null | tr -d '[:space:]')" || die "'$PI --version' failed"
[ "$PIVER" = "$PIN" ] || die "pi CLI/pin version mismatch: CLI reports ${PIVER:-<nothing>}, package.json pins $PIN"

LAB="$(mktemp -d "${TMPDIR:-/tmp}/slate-reminder-check.XXXXXX")" || die "could not create a scratch directory"
KEEP=0
cleanup() { [ "$KEEP" = 1 ] || rm -rf "${LAB:-}"; }
# Install cleanup immediately. Every later refusal removes the scratch directory.
trap cleanup EXIT
trap 'exit 130' INT TERM
case "$LAB" in /*) ;; *) die "scratch directory is not absolute: $LAB" ;; esac
LAB="$(cd "$LAB" 2>/dev/null && pwd -P)" || die "cannot resolve the physical scratch directory"
[ -n "$LAB" ] || die "physical scratch directory resolved empty"
# REPO is physical too. This catches TMPDIR symlinks aimed into the checkout.
case "$LAB" in "$REPO"|"$REPO"/*) die "physical scratch directory is inside the checkout" ;; esac
PROJECT="$LAB/project"
AGENT="$LAB/agent"
CHILD_HOME="$LAB/home"
CHILD_TMP="$LAB/tmp"
mkdir -p "$PROJECT/.pi" "$AGENT" "$CHILD_HOME" "$CHILD_TMP" || die "could not create scratch fixtures"
EVIDENCE="$LAB/provider-evidence.json"
TOOL_MARKER="$LAB/tool-executed.txt"
RPC_IN="$LAB/rpc.in"
STDOUT="$LAB/pi.out"
STDERR="$LAB/pi.err"
ANALYSIS="$LAB/analysis.json"

cat > "$PROJECT/.pi/slate.json" <<'JSON' || die "could not write scratch slate config"
{
  "orchestratorModeDefault": true,
  "contextBudget": 200000,
  "writing": { "check": true, "remind": true, "remindPercent": 10 }
}
JSON
printf '%s\n' \
	'{"id":"commands","type":"get_commands"}' \
	'{"id":"mode","type":"prompt","message":"/slate on"}' \
	'{"id":"turn","type":"prompt","message":"Execute the writing_reminder_canary tool now."}' > "$RPC_IN" \
	|| die "could not write rpc input"

# Build a minimal child PATH for pi's /usr/bin/env node launcher. No variable
# from the caller crosses this env -i boundary. Dead proxies deter ordinary HTTP
# clients, but they do not block raw sockets and are not a sandbox.
NODE_BIN="$(command -v node)"
NODE_DIR="${NODE_BIN%/*}"
PI_DIR="${PI%/*}"
CHILD_PATH="$NODE_DIR:$PI_DIR:/usr/bin:/bin"
DEAD_PROXY="http://127.0.0.1:9"

START_NS="$(date +%s%N)"
(
	cd "$PROJECT" || exit 125
	env -i \
		HOME="$CHILD_HOME" PATH="$CHILD_PATH" TMPDIR="$CHILD_TMP" \
		PI_CODING_AGENT_DIR="$AGENT" PI_OFFLINE=1 \
		HTTP_PROXY="$DEAD_PROXY" HTTPS_PROXY="$DEAD_PROXY" ALL_PROXY="$DEAD_PROXY" NO_PROXY="" \
		SLATE_REMINDER_EVIDENCE="$EVIDENCE" SLATE_REMINDER_TOOL_MARKER="$TOOL_MARKER" \
		timeout --kill-after=5 60 "$PI" --no-extensions -e "$REPO" -e "$CANARY" --mode rpc -a \
			--provider slate-reminder-fake --model reminder-model < "$RPC_IN"
) > "$STDOUT" 2> "$STDERR"
PI_RC=$?
END_NS="$(date +%s%N)"

SESSION="$(node -e '
const fs=require("node:fs"), path=require("node:path");
let best="", time=-1;
function walk(dir) { let entries=[]; try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch { return; }
  for (const e of entries) { const p=path.join(dir,e.name); if(e.isDirectory()) walk(p); else if(e.isFile() && p.endsWith(".jsonl")) { const t=fs.statSync(p).mtimeMs; if(t>time){time=t;best=p;} } }
}
walk(process.argv[1]); process.stdout.write(best);' "$AGENT/sessions")"
node - "$STDOUT" "$SESSION" "$EVIDENCE" "$TOOL_MARKER" "$REPO" "$PROJECT" "$ANALYSIS" <<'NODE'
const fs = require("node:fs");
const [outFile, sessionFile, evidenceFile, markerFile, repo, project, analysisFile] = process.argv.slice(2);
const SUCCESS = "SLATE_REMINDER_REACHED_NEXT_MODEL_CALL_7f31c2";
function jsonLines(file) {
  if (!file || !fs.existsSync(file)) return { values: [], bad: ["missing file"] };
  const values = [], bad = [];
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try { values.push(JSON.parse(line)); } catch (e) { bad.push(`line ${i + 1}: ${e.message}`); }
  });
  return { values, bad };
}
const rpc = jsonLines(outFile);
const session = jsonLines(sessionFile);
let evidence = null;
try { evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8")); } catch {}
const expectedReminder = evidence?.expectedReminder;
const expectedReminderValid = typeof expectedReminder === "string" && expectedReminder.length > 0;
const custom = session.values.filter((e) => e?.type === "custom_message" && e.customType === "slate-writing-reminder");
const exact = custom.filter((e) => expectedReminderValid && e.content === expectedReminder);
const toolResults = session.values.filter((e) => e?.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "writing_reminder_canary");
const assistants = session.values.filter((e) => e?.type === "message" && e.message?.role === "assistant");
const assistantText = assistants.flatMap((e) => Array.isArray(e.message.content) ? e.message.content : []).filter((p) => p?.type === "text").map((p) => p.text);
const commands = rpc.values.find((o) => o?.type === "response" && o.command === "get_commands")?.data?.commands ?? [];
const slatePath = commands.find((c) => c?.name === "slate")?.sourceInfo?.path ?? "";
const extensionErrors = rpc.values.filter((o) => o?.type === "extension_error");
const result = {
  rpcBad: rpc.bad,
  sessionBad: session.bad,
  extensionErrors,
  slatePath,
  workingTree: typeof slatePath === "string" && (slatePath === repo || slatePath.startsWith(repo + "/")),
  trustedConfig: evidence?.trusted === true && evidence?.cwd === project,
  toolExecuted: fs.existsSync(markerFile) && fs.readFileSync(markerFile, "utf8") === "executed\nexecuted\n" && toolResults.length === 2,
  secondCall: evidence?.calls === 2 && assistantText.includes(SUCCESS),
  reminderContext: expectedReminderValid && evidence?.exactReminder === true && evidence?.reminderCount === 1 &&
    Array.isArray(evidence?.providerReminderContents) && evidence.providerReminderContents.length === 1 &&
    evidence.providerReminderContents[0] === expectedReminder && evidence?.providerReminderDetailsAbsent === true,
  reminderExactPersisted: expectedReminderValid && exact.length === 1 && Number.isSafeInteger(evidence?.deliveryId) &&
    evidence.deliveryId > 0 && evidence.deliveryIdSafe === true &&
    exact[0]?.details?.deliveryId === evidence.deliveryId,
  reminderCount: custom.length,
  displayFalse: exact.length === 1 && exact[0].display === false,
  toolResultClean: toolResults.length === 2 && toolResults.every((entry) => {
    const content = entry.message.content;
    return Array.isArray(content) && content.length === 1 && content[0] !== null &&
      typeof content[0] === "object" && Object.keys(content[0]).sort().join(",") === "text,type" &&
      content[0].type === "text" && content[0].text === "CANARY_TOOL_RESULT_ONLY";
  }),
  sessionFile,
};
fs.writeFileSync(analysisFile, JSON.stringify(result, null, 2));
NODE
ANALYZE_RC=$?

EXPECTED="pi-exit rpc-json hook-errors working-tree trusted-config tool-executed second-model-call reminder-context reminder-persisted reminder-once display-false tool-result-clean"
declare -A SEEN=()
PASS=0; FAIL=0
report() {
	local id="$1" verdict="$2" detail="$3"
	SEEN[$id]=$(( ${SEEN[$id]:-0} + 1 ))
	if [ "$verdict" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
	printf 'CHECK %-32s %-4s — %s\n' "$id" "$verdict" "$detail"
}
value() { node -e 'const x=require(process.argv[1]);let v=x[process.argv[2]];process.stdout.write(typeof v==="string"?v:JSON.stringify(v))' "$ANALYSIS" "$1" 2>/dev/null; }
truev() { [ "$(value "$1")" = true ]; }

if [ "$PI_RC" = 0 ]; then report pi-exit PASS "real pi session exited 0 before timeout's 60s TERM plus 5s KILL bound"
else report pi-exit FAIL "pi exited $PI_RC"; fi
if [ "$ANALYZE_RC" = 0 ] && [ -f "$ANALYSIS" ] && [ "$(value rpcBad)" = '[]' ] && [ "$(value sessionBad)" = '[]' ]; then
	report rpc-json PASS "rpc output and session JSONL parse completely"
else report rpc-json FAIL "unparseable or missing JSON evidence (rpc=$(value rpcBad), session=$(value sessionBad))"; fi
if [ "$ANALYZE_RC" = 0 ] && [ "$(value extensionErrors)" = '[]' ]; then report hook-errors PASS "pi emitted no extension_error event"
else report hook-errors FAIL "extension errors: $(value extensionErrors)"; fi
if truev workingTree; then report working-tree PASS "/slate command is attributed inside the checkout under test"
else report working-tree FAIL "/slate source path is outside the checkout: $(value slatePath)"; fi
if truev trustedConfig; then report trusted-config PASS "canary observed the trusted scratch project whose writing reminder config was loaded"
else report trusted-config FAIL "provider evidence did not confirm trusted scratch project"; fi
if truev toolExecuted; then report tool-executed PASS "two parallel real canary tools executed and both results persisted"
else report tool-executed FAIL "parallel tool markers or persisted tool results are missing"; fi
if truev secondCall; then report second-model-call PASS "the offline provider ran exactly twice and persisted its success marker"
else report second-model-call FAIL "the second provider call or success marker is missing"; fi
if truev reminderContext; then report reminder-context PASS "the next model call received exact content without hidden delivery details"
else report reminder-context FAIL "provider context content or hidden-details boundary is wrong"; fi
if truev reminderExactPersisted; then report reminder-persisted PASS "JSONL has exact content and the same positive safe deliveryId observed at message_start"
else report reminder-persisted FAIL "JSONL content or correlated deliveryId is missing or invalid"; fi
if [ "$(value reminderCount)" = 1 ]; then report reminder-once PASS "session JSONL contains exactly one slate-writing-reminder entry"
else report reminder-once FAIL "session JSONL reminder count is $(value reminderCount)"; fi
if truev displayFalse; then report display-false PASS "the persisted reminder has display:false (visual TUI suppression remains manual)"
else report display-false FAIL "the exact persisted reminder does not have display:false"; fi
if truev toolResultClean; then report tool-result-clean PASS "both toolResults equal one exact text block with no extra keys or blocks"
else report tool-result-clean FAIL "a canary toolResult differs from the complete expected content shape"; fi

ROSTER_OK=1
for id in $EXPECTED; do [ "${SEEN[$id]:-0}" = 1 ] || ROSTER_OK=0; done
for id in "${!SEEN[@]}"; do case " $EXPECTED " in *" $id "*) ;; *) ROSTER_OK=0 ;; esac; done
if [ "$ROSTER_OK" = 1 ]; then
	printf 'CHECK %-32s %-4s — %s\n' roster PASS "all expected check ids reported exactly once"
	PASS=$((PASS+1))
else
	printf 'CHECK %-32s %-4s — %s\n' roster FAIL "missing, duplicate, or unexpected check id"
	FAIL=$((FAIL+1))
fi

ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
echo "== summary: $PASS pass, $FAIL fail (${ELAPSED_MS} ms, pi $PIVER) =="
if [ "$FAIL" -ne 0 ]; then
	KEEP=1
	echo
	echo "---- pi stderr ----"; cat "$STDERR"; echo "---- end pi stderr ----"
	echo "---- pi stdout ----"; cat "$STDOUT"; echo "---- end pi stdout ----"
	echo "artifacts: $LAB"
fi
[ "$FAIL" -eq 0 ]
