#!/usr/bin/env bash
# =============================================================================
# slate — real worker simultaneous-tool-call reminder integration check
# =============================================================================
# Starts one real offline pi session. The orchestrator dispatches one real worker
# action. The worker issues two independent built-in read calls in one turn. The
# next worker call receives one hidden reminder, and episode compression excludes
# it. The provider is an in-process custom API implementation. No HTTP server or
# network request is used.
#
# This check proves display:false in persisted JSONL. Visual invisibility in the
# terminal user interface stays a manual check.
#
# Usage: bash verification/run-worker-reminder-check.sh --repo .
# Exit status: 0 all checks passed · 1 a check failed · 2 refused to start.
# =============================================================================
set -uo pipefail

exec 8>&2
die() { echo "verification: refused to start — $*" >&8; exit 2; }

REPO="."
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || die "option '--repo' requires a value"; REPO="$2"; shift 2 ;;
		-h|--help) sed -n '2,16p' "$0"; exit 0 ;;
		*) die "unknown argument '$1' (try --help)" ;;
	esac
done

for tool in node mktemp timeout mkdir rm date env cat tr sed sleep; do
	command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
TIMEOUT_VERSION="$(timeout --version 2>/dev/null)" || die "cannot inspect timeout version"
case "$TIMEOUT_VERSION" in *"GNU coreutils"*) ;; *) die "timeout is not GNU coreutils; --kill-after support is required" ;; esac
REPO="$(cd "$REPO" 2>/dev/null && pwd -P)" || die "bad --repo: not a directory"
[ -f "$REPO/extension/index.ts" ] || die "the extension entry point is missing: $REPO/extension/index.ts"
CANARY="$REPO/verification/worker-reminder-canary.mjs"
[ -f "$CANARY" ] || die "the canary extension is missing: $CANARY"
[ -f "$REPO/package.json" ] || die "not a slate checkout: $REPO/package.json is missing"

PIN="$(node -e '
const fs=require("node:fs");
try { const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const v=p.devDependencies?.["@earendil-works/pi-coding-agent"]; if(typeof v==="string") process.stdout.write(v); } catch {}' "$REPO/package.json")" || die "cannot read package.json"
[ -n "$PIN" ] || die "package.json has no @earendil-works/pi-coding-agent devDependency pin"
if [ -n "${PI_BIN:-}" ]; then PI="$PI_BIN"; echo "NOTE   PI_BIN override in use: $PI"; else PI="$REPO/node_modules/.bin/pi"; fi
[ -x "$PI" ] || die "no executable pi CLI at $PI; run 'npm ci --ignore-scripts' or set PI_BIN"
PIVER="$("$PI" --version 2>/dev/null | tr -d '[:space:]')" || die "'$PI --version' failed"
[ "$PIVER" = "$PIN" ] || die "pi CLI/pin version mismatch: CLI reports ${PIVER:-<nothing>}, package.json pins $PIN"

LAB="$(mktemp -d "${TMPDIR:-/tmp}/slate-worker-reminder-check.XXXXXX")" || die "could not create a scratch directory"
KEEP=0
cleanup() { [ "$KEEP" = 1 ] || rm -rf "${LAB:-}"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
case "$LAB" in /*) ;; *) die "scratch directory is not absolute: $LAB" ;; esac
LAB="$(cd "$LAB" 2>/dev/null && pwd -P)" || die "cannot resolve the physical scratch directory"
[ -n "$LAB" ] || die "physical scratch directory resolved empty"
case "$LAB" in "$REPO"|"$REPO"/*) die "physical scratch directory is inside the checkout" ;; esac
PROJECT="$LAB/project"
AGENT="$LAB/agent"
CHILD_HOME="$LAB/home"
CHILD_TMP="$LAB/tmp"
mkdir -p "$PROJECT/.pi" "$AGENT" "$CHILD_HOME" "$CHILD_TMP" || die "could not create scratch fixtures"
EVIDENCE="$LAB/provider-evidence.json"
RPC_IN="$LAB/rpc.in"
STDOUT="$LAB/pi.out"
STDERR="$LAB/pi.err"
ANALYSIS="$LAB/analysis.json"

cat > "$PROJECT/.pi/slate.json" <<'JSON' || die "could not write scratch slate config"
{
  "orchestratorModeDefault": true,
  "episodeModel": "slate-worker-reminder-fake/worker-reminder-model",
  "workerExtensions": [],
  "cacheKeyEnabled": false,
  "writing": { "check": false, "remind": false }
}
JSON
cat > "$AGENT/models.json" <<'JSON' || die "could not write scratch model config"
{
  "providers": {
    "slate-worker-reminder-fake": {
      "name": "Worker reminder offline canary",
      "api": "slate-worker-reminder-test-api",
      "baseUrl": "http://127.0.0.1:9/unused",
      "apiKey": "literal-offline-canary-key",
      "models": [{
        "id": "worker-reminder-model",
        "name": "Worker reminder model",
        "reasoning": false,
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 1000000,
        "maxTokens": 1024
      }]
    }
  }
}
JSON
printf 'ALPHA_CANARY_RESULT' > "$PROJECT/alpha.txt" || die "could not write alpha fixture"
printf 'BETA_CANARY_RESULT' > "$PROJECT/beta.txt" || die "could not write beta fixture"
printf '%s\n' \
	'{"id":"commands","type":"get_commands"}' \
	'{"id":"turn","type":"prompt","message":"Dispatch the deterministic worker reminder canary now."}' > "$RPC_IN" \
	|| die "could not write rpc input"

NODE_BIN="$(command -v node)"
NODE_DIR="${NODE_BIN%/*}"
PI_DIR="${PI%/*}"
CHILD_PATH="$NODE_DIR:$PI_DIR:/usr/bin:/bin"
DEAD_PROXY="http://127.0.0.1:9"
START_NS="$(date +%s%N)"
(
	cd "$PROJECT" || exit 125
	{ cat "$RPC_IN"; sleep 5; } | env -i HOME="$CHILD_HOME" PATH="$CHILD_PATH" TMPDIR="$CHILD_TMP" \
		PI_CODING_AGENT_DIR="$AGENT" PI_OFFLINE=1 \
		HTTP_PROXY="$DEAD_PROXY" HTTPS_PROXY="$DEAD_PROXY" ALL_PROXY="$DEAD_PROXY" NO_PROXY="" \
		SLATE_WORKER_REMINDER_EVIDENCE="$EVIDENCE" SLATE_WORKER_REMINDER_PROJECT="$PROJECT" \
		timeout --kill-after=5 60 "$PI" --no-extensions -e "$REPO" -e "$CANARY" --mode rpc -a \
			--provider slate-worker-reminder-fake --model worker-reminder-model
	exit "${PIPESTATUS[1]}"
) > "$STDOUT" 2> "$STDERR"
PI_RC=$?
END_NS="$(date +%s%N)"

HOST_SESSION="$(node -e '
const fs=require("node:fs"),path=require("node:path");let best="",time=-1;
function walk(d){let es=[];try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}for(const e of es){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.isFile()&&p.endsWith(".jsonl")){const t=fs.statSync(p).mtimeMs;if(t>time){time=t;best=p}}}}
walk(process.argv[1]);process.stdout.write(best);' "$AGENT/sessions")"
WORKER_SESSION="$(node -e '
const fs=require("node:fs"),path=require("node:path");let files=[];
function walk(d){let es=[];try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}for(const e of es){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.isFile()&&p.endsWith(".jsonl"))files.push(p)}}
walk(process.argv[1]);if(files.length===1)process.stdout.write(files[0]);' "$PROJECT/.pi/slate/threads")"

node - "$STDOUT" "$HOST_SESSION" "$WORKER_SESSION" "$EVIDENCE" "$PROJECT" "$REPO" "$ANALYSIS" <<'NODE'
const fs = require("node:fs");
const [outFile, hostFile, workerFile, evidenceFile, project, repo, analysisFile] = process.argv.slice(2);
const REMINDER_TYPE = "slate-worker-reminder";
const REMINDER_TEXT = "Reminder: ALL INDEPENDENT TOOL CALLS MUST be issued SIMULTANEOUSLY in ONE TURN. Use separate turns only when results depend on each other or conflict.";
const MISS_WARNING = "slate: a worker tool result reached the reminder handler, but the reminder is missing";
function jsonLines(file) {
  if (!file || !fs.existsSync(file)) return { values: [], bad: ["missing file"] };
  const values=[],bad=[];
  fs.readFileSync(file,"utf8").split("\n").forEach((line,i)=>{if(!line.trim())return;try{values.push(JSON.parse(line))}catch(e){bad.push(`line ${i+1}: ${e.message}`)}});
  return { values,bad };
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part)=>part?.type==="text").map((part)=>part.text).join("\n");
}
const rpc=jsonLines(outFile), host=jsonLines(hostFile), worker=jsonLines(workerFile);
let evidence=null;try{evidence=JSON.parse(fs.readFileSync(evidenceFile,"utf8"))}catch{}
const calls=Array.isArray(evidence?.calls)?evidence.calls:[];
const byKind=(kind)=>calls.filter((call)=>call.kind===kind);
const workerCalls=byKind("worker"), hostCalls=byKind("orchestrator"), compressorCalls=byKind("compressor");
const workerEntries=worker.values;
const workerMessages=workerEntries.filter((entry)=>entry?.type==="message").map((entry)=>entry.message);
const toolResults=workerMessages.filter((message)=>message?.role==="toolResult");
const customEntries=workerEntries.filter((entry)=>entry?.type==="custom_message"&&entry.customType===REMINDER_TYPE);
const assistantEntries=workerEntries.filter((entry)=>entry?.type==="message"&&entry.message?.role==="assistant");
const indexOfEntry=(entry)=>workerEntries.indexOf(entry);
const toolIndexes=workerEntries.map((entry,i)=>entry?.type==="message"&&entry.message?.role==="toolResult"?i:-1).filter((i)=>i>=0);
const customIndex=customEntries.length===1?indexOfEntry(customEntries[0]):-1;
const nextAssistantIndex=workerEntries.findIndex((entry,i)=>i>customIndex&&entry?.type==="message"&&entry.message?.role==="assistant");
const hostToolResults=host.values.filter((entry)=>entry?.type==="message"&&entry.message?.role==="toolResult"&&entry.message.toolName==="thread");
const threadResult=hostToolResults[0]?.message;
const warnings=threadResult?.details?.warnings;
const episodeFile=threadResult?.details?.episodeFile;
let episodeText="";try{episodeText=fs.readFileSync(episodeFile,"utf8")}catch{}
const firstWorkerContext=workerCalls[0]?.context;
const secondWorkerContext=workerCalls[1]?.context;
const secondReminders=(secondWorkerContext?.messages??[]).filter((message)=>message.customType===REMINDER_TYPE||message.content===REMINDER_TEXT);
const containsReminder=(value)=>value.includes(REMINDER_TEXT)||/slate-worker-reminder(?![-A-Za-z0-9_])/.test(value);
const firstToolCalls=assistantEntries[0]?.message?.content?.filter((part)=>part?.type==="toolCall")??[];
const commands=rpc.values.find((o)=>o?.type==="response"&&o.command==="get_commands")?.data?.commands??[];
const slatePath=commands.find((c)=>c?.name==="slate")?.sourceInfo?.path??"";
const config=JSON.parse(fs.readFileSync(`${project}/.pi/slate.json`,"utf8"));
const expectedToolResults={"worker-read-alpha":["read","ALPHA_CANARY_RESULT"],"worker-read-beta":["read","BETA_CANARY_RESULT"]};
const cleanToolResults=toolResults.length===2&&toolResults.every((message)=>{
  const expected=expectedToolResults[message.toolCallId];
  return expected&&message.toolName===expected[0]&&message.isError===false&&Array.isArray(message.content)&&message.content.length===1&&
    Object.keys(message.content[0]).sort().join(",")==="text,type"&&message.content[0].type==="text"&&message.content[0].text===expected[1];
});
const result={
  rpcBad:rpc.bad,hostBad:host.bad,workerBad:worker.bad,
  extensionErrors:rpc.values.filter((o)=>o?.type==="extension_error"),
  workingTree:typeof slatePath==="string"&&(slatePath===repo||slatePath.startsWith(repo+"/")),slatePath,
  providerRoute:evidence?.registrations>=2&&calls.length===5&&calls.every((call)=>call.kind!=="unknown"),
  oneDispatch:hostToolResults.length===1&&threadResult?.details?.status==="ok"&&textOf(threadResult?.content).includes("STATUS: OK"),
  workerRequests:workerCalls.length===2&&firstToolCalls.length===2&&firstToolCalls[0]?.name==="read"&&firstToolCalls[1]?.name==="read"&&
    textOf(assistantEntries.at(-1)?.message?.content)==="WORKER_REMINDER_CONTINUATION_OK_51c824",
  toolResultsClean:cleanToolResults,
  reminderExact:customEntries.length===1&&customEntries[0].content===REMINDER_TEXT&&customEntries[0].display===false,
  reminderOrder:toolIndexes.length===2&&Math.max(...toolIndexes)<customIndex&&customIndex<nextAssistantIndex,
  continuationReminder:secondReminders.length===1&&secondReminders[0].content===REMINDER_TEXT,
  noExtraWorkerCall:workerCalls.length===2&&hostCalls.length===2&&compressorCalls.length===1&&calls.length===5,
  silentLossClean:toolResults.length===2&&customEntries.length===1&&Array.isArray(warnings)&&!warnings.some((warning)=>String(warning).includes(MISS_WARNING))&&
    !textOf(threadResult?.content).includes(MISS_WARNING),
  compressorClean:compressorCalls.length===1&&!containsReminder(JSON.stringify(compressorCalls[0].context)),
  episodeClean:typeof episodeFile==="string"&&episodeFile.startsWith(project+"/.pi/slate/episodes/")&&episodeText.length>0&&
    !containsReminder(episodeText),
  configBoundary:Array.isArray(config.workerExtensions)&&config.workerExtensions.length===0&&config.cacheKeyEnabled===false&&
    config.episodeModel==="slate-worker-reminder-fake/worker-reminder-model"&&customEntries.length===1,
  hostSuccess:hostCalls.length===2&&textOf(host.values.filter((entry)=>entry?.type==="message"&&entry.message?.role==="assistant").at(-1)?.message?.content)
    .includes("WORKER_REMINDER_DISPATCH_OK_51c824"),
  hostFile,workerFile,episodeFile,
};
fs.writeFileSync(analysisFile,JSON.stringify(result,null,2));
NODE
ANALYZE_RC=$?

EXPECTED="pi-exit json-lines extension-errors working-tree provider-route one-dispatch worker-requests tool-results reminder-exact reminder-order continuation-context call-count silent-loss compressor-input durable-episode config-boundary host-completion"
declare -A SEEN=()
PASS=0; FAIL=0
report(){ local id="$1" verdict="$2" detail="$3"; SEEN[$id]=$(( ${SEEN[$id]:-0}+1 )); if [ "$verdict" = PASS ];then PASS=$((PASS+1));else FAIL=$((FAIL+1));fi; printf 'CHECK %-32s %-4s — %s\n' "$id" "$verdict" "$detail"; }
value(){ node -e 'const x=require(process.argv[1]);let v=x[process.argv[2]];process.stdout.write(typeof v==="string"?v:JSON.stringify(v))' "$ANALYSIS" "$1" 2>/dev/null; }
truev(){ [ "$(value "$1")" = true ]; }

if [ "$PI_RC" = 0 ];then report pi-exit PASS "real pi session exited 0 before timeout's 60s TERM plus 5s KILL bound";else report pi-exit FAIL "pi exited $PI_RC";fi
if [ "$ANALYZE_RC" = 0 ]&&[ -f "$ANALYSIS" ]&&[ "$(value rpcBad)" = '[]' ]&&[ "$(value hostBad)" = '[]' ]&&[ "$(value workerBad)" = '[]' ];then report json-lines PASS "rpc, host, and worker JSON Lines parse completely";else report json-lines FAIL "missing or unparseable evidence (rpc=$(value rpcBad), host=$(value hostBad), worker=$(value workerBad))";fi
if [ "$ANALYZE_RC" = 0 ]&&[ "$(value extensionErrors)" = '[]' ];then report extension-errors PASS "pi emitted no extension_error event";else report extension-errors FAIL "extension errors: $(value extensionErrors)";fi
if truev workingTree;then report working-tree PASS "/slate command is attributed inside the checkout under test";else report working-tree FAIL "/slate source path is outside the checkout: $(value slatePath)";fi
if truev providerRoute;then report provider-route PASS "the module-global custom API handled orchestrator, worker, and compressor calls offline";else report provider-route FAIL "the custom API registration or call classification is wrong";fi
if truev oneDispatch;then report one-dispatch PASS "one real thread dispatch completed with status ok";else report one-dispatch FAIL "the real thread result is missing, duplicated, or failed";fi
if truev workerRequests;then report worker-requests PASS "the worker made one two-read request and one fixed-marker continuation request";else report worker-requests FAIL "the worker request sequence or fixed success marker is wrong";fi
if truev toolResultsClean;then report tool-results PASS "both built-in read results persisted unchanged";else report tool-results FAIL "a built-in read result differs from its exact persisted shape";fi
if truev reminderExact;then report reminder-exact PASS "one exact slate-worker-reminder persisted with display:false (visual TUI invisibility stays manual)";else report reminder-exact FAIL "the reminder count, content, custom type, or display flag is wrong";fi
if truev reminderOrder;then report reminder-order PASS "the reminder follows both tool results and precedes the continuation assistant message";else report reminder-order FAIL "the persisted reminder is outside the required turn boundary";fi
if truev continuationReminder;then report continuation-context PASS "the second worker provider context contains exactly one reminder";else report continuation-context FAIL "the continuation provider context does not contain exactly one exact reminder";fi
if truev noExtraWorkerCall;then report call-count PASS "the provider saw exactly two worker, two orchestrator, and one compressor call";else report call-count FAIL "an expected provider call is missing or an extra call occurred";fi
if truev silentLossClean;then report silent-loss PASS "the delivered reminder produces no false reminder-miss warning";else report silent-loss FAIL "the delivered reminder or returned warnings are inconsistent";fi
if truev compressorClean;then report compressor-input PASS "the compressor request contains no reminder text or custom type";else report compressor-input FAIL "the worker reminder leaked into the compressor request";fi
if truev episodeClean;then report durable-episode PASS "the durable episode exists and contains no reminder text or custom type";else report durable-episode FAIL "the durable episode is missing or contains a worker reminder";fi
if truev configBoundary;then report config-boundary PASS "empty workerExtensions and cacheKeyEnabled:false did not prevent delivery";else report config-boundary FAIL "the required scratch config boundary or delivery proof is missing";fi
if truev hostSuccess;then report host-completion PASS "the orchestrator received the thread result and returned its fixed marker";else report host-completion FAIL "the orchestrator completion marker is missing";fi
ROSTER_OK=1
for id in $EXPECTED;do [ "${SEEN[$id]:-0}" = 1 ]||ROSTER_OK=0;done
for id in "${!SEEN[@]}";do case " $EXPECTED " in *" $id "*) ;; *) ROSTER_OK=0 ;; esac;done
if [ "$ROSTER_OK" = 1 ];then printf 'CHECK %-32s %-4s — %s\n' roster PASS "all expected check ids reported exactly once";PASS=$((PASS+1));else printf 'CHECK %-32s %-4s — %s\n' roster FAIL "missing, duplicate, or unexpected check id";FAIL=$((FAIL+1));fi
ELAPSED_MS=$(( (END_NS-START_NS)/1000000 ))
echo "== summary: $PASS pass, $FAIL fail (${ELAPSED_MS} ms, pi $PIVER) =="
echo "NOTE   display:false is proven structurally; visual invisibility in the terminal user interface stays a manual check."
echo "NOTE   this clean delivery run cannot prove that a real missing reminder produces a warning; unit and resolver checks cover that path."
if [ "$FAIL" -ne 0 ];then KEEP=1;echo;echo "---- pi stderr ----";cat "$STDERR";echo "---- end pi stderr ----";echo "---- pi stdout ----";cat "$STDOUT";echo "---- end pi stdout ----";echo "artifacts: $LAB";fi
[ "$FAIL" -eq 0 ]
