#!/usr/bin/env bash
# =============================================================================
# slate — real worker simultaneous-tool-call reminder integration check
# =============================================================================
# Compares writing intervals on the normal path, at a compaction threshold,
# and at a simulated provider input limit. Additional cases exercise queued
# guidance, rejected construction, and independent model and handler choices.
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

for tool in node mktemp timeout mkdir rm date env cat tr sed; do
	command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
TIMEOUT_VERSION="$(timeout --version 2>/dev/null)" || die "cannot inspect timeout version"
case "$TIMEOUT_VERSION" in *"GNU coreutils"*) ;; *) die "timeout is not GNU coreutils; --kill-after support is required" ;; esac
REPO="$(cd "$REPO" 2>/dev/null && pwd -P)" || die "bad --repo: not a directory"
[ -f "$REPO/extension/index.ts" ] || die "the extension entry point is missing: $REPO/extension/index.ts"
CANARY="$REPO/verification/worker-reminder-canary.ts"
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

run_case() (
CADENCE="$1"
PROFILE="${2:-normal}"
THRESHOLD=0
STARTUP_HISTORY=0
case "$PROFILE" in
	threshold|handler|compact-*) THRESHOLD=1; STARTUP_HISTORY=1 ;;
	overflow|overflow-disabled|length) STARTUP_HISTORY=1 ;;
esac
STARTUP_ARGS=()
WORKER_EXTENSIONS='[]'
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
if [ "$PROFILE" != normal ] && [ "$PROFILE" != model ]; then
	STARTUP="$LAB/reminder-startup-probe.mjs"
	STARTUP_ARGS=(-e "$STARTUP")
	WORKER_EXTENSIONS='["reminder-startup-probe[.]mjs$"]'
	ENABLED=true
	RESERVE=996750
	case "$PROFILE" in
		overflow-disabled) ENABLED=false ;;
		overflow|length) RESERVE=1000 ;;
	esac
	STEERING=""
	[ "$PROFILE" != steer-all ] || STEERING=',"steeringMode":"all"'
	printf '%s\n' "{\"compaction\":{\"enabled\":$ENABLED,\"reserveTokens\":$RESERVE,\"keepRecentTokens\":240},\"retry\":{\"enabled\":false}$STEERING}" > "$AGENT/settings.json" || die "could not write canary policy"
	cat > "$STARTUP" <<'JS' || die "could not write startup fixture"
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const profile = process.env.SLATE_WORKER_REMINDER_PROFILE;
export default function (pi) {
  const record = (value) => appendFileSync(process.env.SLATE_WORKER_REMINDER_EVIDENCE + ".startup", JSON.stringify(value) + "\n");
  pi.registerTool({
    name: "reminder_startup_probe", label: "Startup probe", description: "Select the startup fixture for the worker.",
    parameters: { type: "object", properties: {} },
    execute() { throw new Error("The startup probe is not a work tool"); },
  });
  pi.on("session_start", async (_, ctx) => {
    if (ctx.mode !== "print" || process.env.SLATE_WORKER_REMINDER_STARTUP !== "1") return;
    if (!ctx.isIdle()) throw new Error("Worker must be idle at startup");
    for (let i = 0; i < 12; i++) {
      await pi.sendMessage({ customType: "canary-startup", content: "Idle startup record " + i, display: false }, { triggerTurn: false });
    }
    const messages = ctx.sessionManager.buildSessionProjection().messages;
    record({ phase: "startup", idle: ctx.isIdle(), offset: messages.length, count: messages.filter(m => m.customType === "canary-startup").length });
  });
  const finalIndex = (ctx) => ctx.sessionManager.buildSessionProjection().messages.findIndex(
    m => m.role === "assistant" && m.content.some(p => p.text?.startsWith("WORKER_REMINDER_CONTINUATION_OK_51c824")));
  let restore;
  pi.on("session_start", (_, ctx) => {
    if (ctx.mode !== "print" || profile !== "rejected") return;
    // Inject a one-byte measurement fault only for the exact standalone form.
    const byteLength = Buffer.byteLength;
    Buffer.byteLength = (value, encoding) => {
      const bytes = byteLength(value, encoding);
      const header = "[slate] Reminder:\n\n";
      if (typeof value === "string" && bytes === 1180 && value.startsWith(header) &&
          createHash("sha256").update(value.slice(header.length)).digest("hex") === "843d2b18183011d985de68e1d38e8d5cea6be77530ecca33a976c101f629af2f") {
        record({ phase: "rejected", bytes, measured: bytes + 1 });
        return bytes + 1;
      }
      return bytes;
    };
    restore = () => { Buffer.byteLength = byteLength; };
  });
  pi.on("message_end", (event, ctx) => {
    if (ctx.mode !== "print" || !profile.startsWith("steer-") || event.message.role !== "assistant" ||
        !event.message.content.some(p => p.id === "worker-read-again")) return;
    pi.sendMessage({ customType: "canary-earlier", content: "CANARY_EARLIER_GUIDANCE_51c824", display: false }, { deliverAs: "steer" });
  });
  pi.on("session_before_compact", (_, ctx) => {
    if (ctx.mode === "print" && profile === "compact-cancel") return { cancel: true };
  });
  pi.on("session_compact_failed", (event, ctx) => {
    if (ctx.mode === "print") record({ phase: "compact-failed", reason: event.reason, aborted: event.aborted,
      willRetry: event.willRetry, fromExtension: event.fromExtension, error: event.errorMessage });
  });
  pi.on("session_compact", (event, ctx) => {
    if (ctx.mode !== "print") return;
    record({ phase: "compact", reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension, index: finalIndex(ctx) });
    if (profile === "handler" && event.reason === "threshold") {
      record({ phase: "handler-queued", idle: ctx.isIdle() });
      pi.sendMessage({ customType: "canary-handler", content: "CANARY_COMPACTION_FOLLOW_UP_51c824", display: false }, { deliverAs: "followUp" });
    }
  });
  pi.on("session_shutdown", (_, ctx) => {
    if (ctx.mode !== "print") return;
    restore?.();
    record({ phase: "shutdown", index: finalIndex(ctx) });
  });
}
JS
fi

cat > "$PROJECT/.pi/slate.json" <<JSON || die "could not write scratch slate config"
{
  "orchestratorModeDefault": true,
  "router": {
    "models": {
      "include": [],
      "add": [{
        "model": "worker-reminder-canary",
        "capabilityRating": 50,
        "effort": "off",
        "costRating": 50,
        "preferredProvider": "slate-worker-reminder-fake",
        "providers": { "slate-worker-reminder-fake": "worker-reminder-model" },
        "guidelines": [],
        "cautions": []
      }],
      "replace": [{
        "model": "claude-sonnet-5.5",
        "preferredProvider": "slate-worker-reminder-fake",
        "providers": { "slate-worker-reminder-fake": "worker-reminder-model" }
      }]
    },
    "compressor": { "models": [{ "model": "claude-sonnet-5.5", "effort": "off" }] }
  },
  "workerExtensions": $WORKER_EXTENSIONS,
  "cacheKeyEnabled": false,
  "writing": { "remindTurns": $CADENCE }
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
	env -i HOME="$CHILD_HOME" PATH="$CHILD_PATH" TMPDIR="$CHILD_TMP" \
		PI_CODING_AGENT_DIR="$AGENT" PI_OFFLINE=1 \
		HTTP_PROXY="$DEAD_PROXY" HTTPS_PROXY="$DEAD_PROXY" ALL_PROXY="$DEAD_PROXY" NO_PROXY="" \
		SLATE_WORKER_REMINDER_EVIDENCE="$EVIDENCE" SLATE_WORKER_REMINDER_PROJECT="$PROJECT" SLATE_WORKER_REMINDER_PROFILE="$PROFILE" SLATE_WORKER_REMINDER_STARTUP="$STARTUP_HISTORY" \
		node - "$RPC_IN" "$PI" "$REPO" "$CANARY" "${STARTUP_ARGS[@]}" <<'RPC'
const { readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const [input, pi, repo, canary, ...extensions] = process.argv.slice(2);
const child = spawn("timeout", ["--kill-after=5", "60", pi, "--no-extensions", "-e", repo, "-e", canary,
  ...extensions, "--mode", "rpc", "-a", "--provider", "slate-worker-reminder-fake", "--model", "worker-reminder-model"],
  { stdio: ["pipe", "pipe", "inherit"] });
child.stdout.pipe(process.stdout, { end: false });
let accepted = false, settled = false, closed = false, failure = false;
const finish = () => {
  if (!closed) { closed = true; child.stdin.end(); }
};
createInterface({ input: child.stdout }).on("line", line => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event?.id === "turn" && event.type === "response") {
    accepted = event.success === true;
    if (!accepted) { failure = true; finish(); }
  }
  if (event?.type === "agent_settled") settled = true;
  if (accepted && settled) finish();
});
child.stdin.on("error", error => { console.error(error); failure = true; });
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("close", code => { process.exitCode = code || (accepted && settled && !failure ? 0 : 1); });
child.stdin.write(readFileSync(input));
RPC
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
walk(process.argv[1]);if(files.length===1&&/\/runtime-\d{8}T\d{6}Z-[0-9a-f]{32}\/threads\//.test(files[0]))process.stdout.write(files[0]);' "$PROJECT/.pi/slate")"

(cd "$REPO" && node - "$STDOUT" "$HOST_SESSION" "$WORKER_SESSION" "$EVIDENCE" "$PROJECT" "$REPO" "$ANALYSIS" "$PROFILE" <<'NODE'
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const [outFile, hostFile, workerFile, evidenceFile, project, repo, analysisFile, profile] = process.argv.slice(2);
const unsuccessfulCompaction = profile === "compact-cancel" || profile === "compact-fail";
const thresholdCase = profile === "threshold" || profile === "handler" || unsuccessfulCompaction;
const overflowCase = ["overflow", "overflow-disabled", "length"].includes(profile);
const queued = "CANARY_EARLIER_GUIDANCE_51c824";
const handler = "CANARY_COMPACTION_FOLLOW_UP_51c824";
const overflowDiagnostic = "context_length_exceeded: canary request exceeds 3000 test tokens";
const answerMarker = "WORKER_REMINDER_CONTINUATION_OK_51c824";
const expectedAnswer = answerMarker + (thresholdCase ? "\n" + "Saved final answer. ".repeat(36).trimEnd() : "");
const REMINDER_TYPE = "slate-worker-reminder";
const REMINDER_TEXT = "Reminder: ALL INDEPENDENT TOOL CALLS MUST be issued SIMULTANEOUSLY in ONE TURN. Use separate turns only when results depend on each other or conflict. When codemode is available, use it to run independent tool calls together, chain dependent calls, or filter large output while keeping large intermediate data in script variables.";
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
const customIndexes=customEntries.map(indexOfEntry);
const assistantIndexes=assistantEntries.map(indexOfEntry);
const hostToolResults=host.values.filter((entry)=>entry?.type==="message"&&entry.message?.role==="toolResult"&&entry.message.toolName==="thread");
const threadResult=hostToolResults[0]?.message;
const warnings=threadResult?.details?.warnings;
const episodeFile=threadResult?.details?.episodeFile;
let episodeText="";try{episodeText=fs.readFileSync(episodeFile,"utf8")}catch{}
const requestReminders=workerCalls.map(({context})=>context.messages.filter((message)=>
  message.customType===REMINDER_TYPE||message.content.startsWith(REMINDER_TEXT)));
const bytes=(text)=>Buffer.byteLength(text);
const firstToolCalls=assistantEntries[0]?.message?.content?.filter((part)=>part?.type==="toolCall")??[];
const commands=rpc.values.find((o)=>o?.type==="response"&&o.command==="get_commands")?.data?.commands??[];
const slatePath=commands.find((c)=>c?.name==="slate")?.sourceInfo?.path??"";
const config=JSON.parse(fs.readFileSync(`${project}/.pi/slate.json`,"utf8"));
const writingDue=config.writing.remindTurns===1;
const combined=writingDue && profile!=="rejected";
const crossesThreshold = thresholdCase && combined;
const compacts = crossesThreshold && !unsuccessfulCompaction;
const compactionUnsuccessful = crossesThreshold && unsuccessfulCompaction;
const handlerExtra = compacts && profile === "handler";
const modelExtra = combined && profile === "model";
const oneExtra = profile === "steer-one";
const overflowFailed = overflowCase && combined && profile === "overflow-disabled";
const overflowRetried = overflowCase && combined && !overflowFailed;
const furtherCalls = handlerExtra || modelExtra || oneExtra || overflowRetried;
const expectedStatus = overflowFailed ? "failed" : "ok";
const expectedCalls = ["orchestrator", "worker", "worker", "worker",
  ...(overflowRetried ? ["summary", "summary"] : compacts || profile === "compact-fail" ? ["summary"] : []),
  ...(furtherCalls ? ["worker"] : []), "compressor", "orchestrator"];
const noExtraWorkerCall = calls.map(c => c.kind).join(",") === expectedCalls.join(",");
const trace = jsonLines(evidenceFile + ".startup");
const [startup] = trace.values;
const compact = trace.values.find(e => e.phase === "compact");
const shutdown = trace.values.at(-1);
const savedCompactions = workerEntries.filter(e => e.type === "compaction");
const usage = assistantEntries.map(e => e.message.usage);
const settings = thresholdCase || overflowCase || profile.startsWith("steer-") ?
  JSON.parse(fs.readFileSync(`${project}/../agent/settings.json`, "utf8")) : null;
const model = thresholdCase ? JSON.parse(fs.readFileSync(`${project}/../agent/models.json`, "utf8")).providers["slate-worker-reminder-fake"].models[0] : null;
const threshold = model?.contextWindow - settings?.compaction.reserveTokens;
const serializedRequestBytes = messages => messages.reduce((sum, m) => sum + m.bytes, messages.length + 1);
const usageMatches = workerCalls.length === (furtherCalls ? 4 : 3) && workerCalls.slice(0, 3).every((call, i) => {
  const outputBytes = Buffer.byteLength(JSON.stringify(assistantEntries[i]?.message?.content ?? []));
  const input = Math.ceil(serializedRequestBytes(call.context.messages) / 4), output = Math.ceil(outputBytes / 4);
  return usage[i]?.input === input && usage[i]?.output === output && usage[i]?.totalTokens === input + output;
});
const obsHeader = episodeText.match(/^> observations: stored \| path: (\.pi\/slate\/runtime-[^/\s]+\/observations\/t\d+\.e1\.md) \| bytes: (\d+) \| truncated: no \|/m);
const expectedObservationPath = typeof episodeFile === "string" ? episodeFile.replace(/\/episodes\//, "/observations/") : "";
let observation;
try {
  if (obsHeader && `${project}/${obsHeader[1]}` === expectedObservationPath) observation = fs.readFileSync(expectedObservationPath);
} catch {}
const observationExact = observation?.equals(Buffer.from(expectedAnswer)) === true && Number(obsHeader?.[2]) === observation.length;
const firstWorkerRequest = workerCalls[0]?.context.messages ?? [];
const startupRecords = Array.from({length: 12}, (_, i) => `Idle startup record ${i}`);
const savedStartup = workerEntries.filter(e => e.type === "custom_message" && e.customType === "canary-startup");
const sameIdleStartup = startup?.phase === "startup" && startup.idle === true && startup.offset === 12 && startup.count === 12 &&
  JSON.stringify(firstWorkerRequest.filter(m => m.content.startsWith("Idle startup record ")).map(m => m.content)) === JSON.stringify(startupRecords) &&
  savedStartup.length === startupRecords.length && savedStartup.every((e, i) => e.display === false && e.content === startupRecords[i] && indexOfEntry(e) < assistantIndexes[0]);
const addition = requestReminders[2]?.at(-1)?.content.slice(REMINDER_TEXT.length) ?? "";
const additionBytes = Buffer.byteLength(JSON.stringify(addition)) - 2;
const withoutAddition = usageMatches ? Math.ceil((serializedRequestBytes(workerCalls[2].context.messages) - additionBytes) / 4) + usage[2].output : null;
const atThreshold = usageMatches && settings?.compaction.enabled === true && threshold === 3250 && usage.slice(0, 2).every(u => u.totalTokens < threshold) &&
  withoutAddition <= threshold && (crossesThreshold ? usage[2].totalTokens > threshold : usage[2].totalTokens === withoutAddition);
const phases = trace.values.map(e => e.phase).join(",");
const compactedAfterAnswer = trace.bad.length === 0 && phases ===
  (compacts ? handlerExtra ? "startup,compact,handler-queued,shutdown" : "startup,compact,shutdown" :
    compactionUnsuccessful ? "startup,compact-failed,shutdown" : "startup,shutdown") && shutdown?.phase === "shutdown" &&
  (compacts ? savedCompactions.length === 1 && indexOfEntry(savedCompactions[0]) > assistantIndexes[2] &&
    savedCompactions[0].summary.startsWith("WORKER_HISTORY_SUMMARY_51c824") && compact?.reason === "threshold" &&
    compact.willRetry === false && compact.fromExtension === false && compact.index >= 0 && compact.index < startup?.offset && shutdown.index === compact.index
    : savedCompactions.length === 0 && shutdown.index >= startup?.offset);
const second=customEntries[1]?.content;
const increment=typeof second==="string"?second.slice(REMINDER_TEXT.length):"";
const exactSecond=combined
  ? typeof second==="string"&&second.startsWith(REMINDER_TEXT+"\n\n")&&bytes(increment)===1163&&
    createHash("sha256").update(increment.slice(2)).digest("hex")==="843d2b18183011d985de68e1d38e8d5cea6be77530ecca33a976c101f629af2f"
  : second===REMINDER_TEXT;
const containsReminder=(value)=>value.includes(REMINDER_TEXT)||/slate-(?:worker|writing)-reminder(?![-A-Za-z0-9_])/.test(value)||
  (combined&&increment.length>2&&value.includes(increment.slice(2)));
const savedLines=workerFile?fs.readFileSync(workerFile,"utf8").split("\n").filter((line)=>{
  try { const entry=JSON.parse(line);return entry.type==="custom_message"&&entry.customType===REMINDER_TYPE; } catch { return false; }
}):[];
const expectedToolResults={"worker-read-alpha":["read","ALPHA_CANARY_RESULT"],"worker-read-beta":["read","BETA_CANARY_RESULT"],"worker-read-again":["read","ALPHA_CANARY_RESULT"],
  ...(modelExtra ? {"worker-read-extra":["read","BETA_CANARY_RESULT"]} : {})};
const cleanToolResults=toolResults.map((message)=>message.toolCallId).join(",")===Object.keys(expectedToolResults).join(",")&&toolResults.every((message)=>{
  const expected=expectedToolResults[message.toolCallId];
  return expected&&message.toolName===expected[0]&&message.isError===false&&Array.isArray(message.content)&&message.content.length===1&&
    Object.keys(message.content[0]).sort().join(",")==="text,type"&&message.content[0].type==="text"&&message.content[0].text===expected[1];
});
const expectedReminders = [[], [REMINDER_TEXT], oneExtra ? [REMINDER_TEXT] : [REMINDER_TEXT, second]];
if (oneExtra) expectedReminders.push([REMINDER_TEXT, second]);
if (modelExtra) expectedReminders.push([REMINDER_TEXT, second, second]);
if (handlerExtra) expectedReminders.push([second]);
if (overflowRetried) expectedReminders.push([]);
const serialized = workerCalls.map(call => serializedRequestBytes(call.context.messages));
const inputTokens = serialized.map(n => Math.ceil(n / 4));
const cutoff = 3000;
const badTurn = assistantEntries[2]?.message;
const recoveryChecks = sameIdleStartup && inputTokens.slice(0, 2).every(n => n <= cutoff) &&
  (combined ? inputTokens[2] > cutoff && Math.ceil((serialized[2] - additionBytes) / 4) <= cutoff &&
    badTurn?.usage?.input === inputTokens[2] && (profile === "length" ?
      badTurn.stopReason === "length" && badTurn.usage.output === 3 && textOf(badTurn.content) === "CANARY_TRUNCATED_51c824" :
      badTurn.stopReason === "error" && badTurn.errorMessage === overflowDiagnostic)
    : inputTokens[2] <= cutoff) &&
  settings?.retry?.enabled === false && settings?.compaction?.enabled === (profile !== "overflow-disabled") &&
  (overflowRetried ?
    phases === "startup,compact,shutdown" && compact?.reason === "overflow" && compact.willRetry === true &&
      compact.fromExtension === false && savedCompactions.length === 1 &&
      savedCompactions[0].summary.includes("**Turn Context (split turn):**") &&
      byKind("summary").length === 2 && byKind("summary")[0].context.messages.some(m => m.content.includes("Idle startup record 0")) &&
      byKind("summary")[1].context.messages.some(m => m.content.includes(second)) &&
      workerCalls[3]?.context.messages.some(m => m.content.includes("WORKER_HISTORY_SUMMARY_51c824")) &&
      inputTokens[3] <= cutoff && workerEntries.some(e => e.type === "context_edit" &&
        e.targetId === assistantEntries[2].id && e.replacement === null)
    : phases === "startup,shutdown" && savedCompactions.length === 0) &&
  (!overflowFailed || (episodeText.includes("STATUS: FAILED") && episodeText.includes("> failure: " + overflowDiagnostic) &&
    textOf(threadResult?.content).includes(overflowDiagnostic)));
const failedCompaction = trace.values.find(e => e.phase === "compact-failed");
const extraChecks = unsuccessfulCompaction ?
  compactionUnsuccessful && failedCompaction?.reason === "threshold" && failedCompaction.willRetry === false &&
  failedCompaction.fromExtension === false &&
  (profile === "compact-cancel" ? failedCompaction.aborted === true && failedCompaction.error === undefined :
    failedCompaction.aborted === false && failedCompaction.error === "Auto-compaction failed: Summarization failed: Canary summary refused.") :
  profile === "rejected" ?
  phases === "rejected,shutdown" && trace.values[0]?.bytes === 1180 && trace.values[0]?.measured === 1181 :
  profile.startsWith("steer-") ?
    (profile === "steer-all" ? settings?.steeringMode === "all" : !Object.hasOwn(settings ?? {}, "steeringMode")) &&
    [[], [], [queued], ...(oneExtra ? [[queued]] : [])].every((expected, i) => JSON.stringify(expected) ===
      JSON.stringify(workerCalls[i]?.context.messages.filter(m => m.content === queued).map(m => m.content))) &&
    workerEntries.filter(e => e.type === "custom_message" && e.customType === "canary-earlier").length === 1 &&
    workerEntries.find(e => e.type === "custom_message" && e.customType === "canary-earlier")?.display === false &&
    workerEntries.findIndex(e => e.type === "custom_message" && e.customType === "canary-earlier") < customIndexes[1] :
  profile === "model" ? savedCompactions.length === 0 && (!modelExtra ||
    JSON.stringify(badTurn?.content?.map(p => [p.type, p.name, p.id, p.arguments])) ===
      JSON.stringify([["toolCall", "read", "worker-read-extra", {path: `${project}/beta.txt`}]])) :
  profile === "handler" ? !handlerExtra || (trace.values[2]?.idle === false &&
    workerCalls.slice(0, 3).every(c => !c.context.messages.some(m => m.content === handler)) &&
    workerCalls[3]?.context.messages.filter(m => m.content === handler).length === 1 &&
    workerEntries.filter(e => e.type === "custom_message" && e.customType === "canary-handler" && e.content === handler && e.display === false).length === 1) :
  overflowCase ? recoveryChecks : true;
const expectedCustomTypes = [
  ...((thresholdCase || overflowCase) ? Array.from({ length: 12 }, () => "canary-startup") : []),
  REMINDER_TYPE, ...(profile.startsWith("steer-") ? ["canary-earlier"] : []), REMINDER_TYPE,
  ...(modelExtra ? [REMINDER_TYPE] : []), ...(handlerExtra ? ["canary-handler"] : []),
];
const expectedStops = ["toolUse", "toolUse",
  overflowFailed || overflowRetried ? (profile === "length" ? "length" : "error") : modelExtra ? "toolUse" : "stop",
  ...(furtherCalls ? ["stop"] : [])];
const result={
  extraChecks,
  profileEvidence: { profile, inputTokens, phases, stops: assistantEntries.map(e => e.message.stopReason),
    kinds: calls.map(c => c.kind), status: threadResult?.details?.status, requestReminders: requestReminders.map(r => r.map(m => m.bytes)) },
  rpcBad:rpc.bad,hostBad:host.bad,workerBad:worker.bad,
  extensionErrors:rpc.values.filter((o)=>o?.type==="extension_error"),
  workingTree:typeof slatePath==="string"&&(slatePath===repo||slatePath.startsWith(repo+"/")),slatePath,
  providerRoute:evidence?.registrations?.host===1&&evidence?.registrations?.runtime>=1&&calls.every(call =>
    call.kind !== "unknown" && call.provider === "slate-worker-reminder-fake" && call.model === "worker-reminder-model") &&
    workerCalls.every(call => !call.context.messages.some(m => m.content.startsWith("The previous attempt was interrupted by a model API failure."))),
  oneDispatch:hostToolResults.length===1&&threadResult?.details?.status===expectedStatus&&textOf(threadResult?.content).includes("STATUS: " + expectedStatus.toUpperCase()),
  workerRequests:workerCalls.length===expectedStops.length&&assistantEntries.length===expectedStops.length&&firstToolCalls.length===2&&
    [firstToolCalls, assistantEntries[1]?.message?.content?.filter(part => part.type === "toolCall")].every((batch, i) =>
      JSON.stringify(batch?.map(call => [call.name, call.id, call.arguments])) === JSON.stringify(i === 0 ? [
        ["read", "worker-read-alpha", {path: `${project}/alpha.txt`}], ["read", "worker-read-beta", {path: `${project}/beta.txt`}],
      ] : [["read", "worker-read-again", {path: `${project}/alpha.txt`}]])) &&
    assistantEntries.map(e => e.message.stopReason).join(",")===expectedStops.join(",") &&
    (overflowFailed || textOf(assistantEntries.at(-1)?.message?.content)===expectedAnswer),
  toolResultsClean:cleanToolResults,
  reminderExact:JSON.stringify(workerEntries.filter(e => e.type === "custom_message").map(e => e.customType))===JSON.stringify(expectedCustomTypes)&&
    customEntries.length===(modelExtra ? 3 : 2)&&customEntries.every((entry)=>entry.display===false)&&
    customEntries[0].content===REMINDER_TEXT&&exactSecond&&(!modelExtra || customEntries[2].content===second),
  reminderOrder:toolIndexes[1]<customIndexes[0]&&customIndexes[0]<assistantIndexes[1]&&
    assistantIndexes[1]<toolIndexes[2]&&toolIndexes[2]<customIndexes[1]&&customIndexes[1]<assistantIndexes[oneExtra ? 3 : 2]&&
    (!modelExtra || assistantIndexes[2]<toolIndexes[3]&&toolIndexes[3]<customIndexes[2]&&customIndexes[2]<assistantIndexes[3]),
  continuationReminder:JSON.stringify(requestReminders.slice(0, expectedReminders.length).map((round)=>round.map((message)=>message.content)))===
    JSON.stringify(expectedReminders) && (profile !== "normal" ||
      (savedLines.map(line => bytes(line) + 1).join(",") === (combined ? "499,1679" : "499,499") &&
        requestReminders.map(round => round.map(message => message.bytes).join(":")).join(",") ===
          (combined ? ",409,409:1589" : ",409,409:409"))),
  byteCosts:{
    content:customEntries.map((entry)=>bytes(entry.content)),
    savedJsonl:savedLines.map((line)=>bytes(line)+1),
    providerMessages:requestReminders.map((round)=>round.map((message)=>message.bytes)),
  },
  noExtraWorkerCall,
  sameIdleStartup, atThreshold, compactedAfterAnswer, observationExact,
  thresholdEvidence: { threshold, usage: usage.map(u => u.totalTokens), withoutAddition, trace: trace.values, calls: calls.map(c => c.kind),
    observationBytes: observation?.length, observationHash: observation && createHash("sha256").update(observation).digest("hex") },
  silentLossClean:cleanToolResults&&Array.isArray(warnings)&&!warnings.some((warning)=>/reminder/i.test(String(warning)))&&
    !textOf(threadResult?.content).includes(MISS_WARNING),
  compressorClean:compressorCalls.length===1&&
    !compressorCalls[0].context.messages.some(message => containsReminder(message.content) || containsReminder(message.customType??"") ||
      message.content.includes("WORKER_HISTORY_SUMMARY_51c824")) &&
    [overflowFailed ? overflowDiagnostic : answerMarker,"ALPHA_CANARY_RESULT","BETA_CANARY_RESULT"].every(marker =>
      JSON.stringify(compressorCalls[0].context).includes(marker)),
  episodeClean:typeof episodeFile==="string"&&/^runtime-\d{8}T\d{6}Z-[0-9a-f]{32}\/episodes\/t\d+\.e1\.md$/.test(episodeFile.slice((project+"/.pi/slate/").length))&&episodeFile.startsWith(project+"/.pi/slate/")&&episodeText.length>0&&
    !containsReminder(episodeText),
  configBoundary:JSON.stringify(config.workerExtensions)===(profile === "normal" || profile === "model" ? '[]' : '["reminder-startup-probe[.]mjs$"]')&&config.cacheKeyEnabled===false&&
    config.router?.models?.add?.[0]?.model==="worker-reminder-canary"&&config.router?.compressor?.models?.[0]?.model==="claude-sonnet-5.5"&&
    !Object.hasOwn(config,"episodeModel")&&!Object.hasOwn(config,"modelFailover"),
  hostSuccess:hostCalls.length===2&&textOf(host.values.filter((entry)=>entry?.type==="message"&&entry.message?.role==="assistant").at(-1)?.message?.content)
    .includes("WORKER_REMINDER_DISPATCH_OK_51c824"),
  hostFile,workerFile,episodeFile,
};
(async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const reopened = workerFile && SessionManager.open(workerFile).buildSessionProjection().messages;
  const ordinary = messages => messages.filter(m => m.role === "assistant" || m.role === "toolResult" || m.customType === REMINDER_TYPE);
  const saved = workerEntries.flatMap(e => e.type === "message" ? [e.message] :
    e.type === "custom_message" ? [{ role: "custom", customType: e.customType, content: e.content, display: e.display }] : []);
  const stable = messages => ordinary(messages).map(m => [m.role, m.customType, m.content, m.display, m.toolCallId, m.toolName, m.isError, m.stopReason]);
  result.reopenedRecords = reopened && JSON.stringify(stable(reopened)) === JSON.stringify(stable(saved));
  fs.writeFileSync(analysisFile,JSON.stringify(result,null,2));
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
)
ANALYZE_RC=$?

EXPECTED="pi-exit json-lines extension-errors working-tree provider-route one-dispatch worker-requests tool-results reminder-exact reminder-order continuation-context call-count silent-loss compressor-input durable-episode config-boundary host-completion"
if [ "$THRESHOLD" = 1 ]; then EXPECTED="$EXPECTED idle-startup usage-threshold compaction-offset observation-bytes"; fi
case "$PROFILE" in
	normal|model|rejected|steer-*) EXPECTED="$EXPECTED reopened-records" ;;
esac
case "$PROFILE" in
	normal|threshold) ;;
	*) EXPECTED="$EXPECTED profile-evidence" ;;
esac
declare -A SEEN=()
PASS=0; FAIL=0
report(){ local id="$1" verdict="$2" detail="$3"; SEEN[$id]=$(( ${SEEN[$id]:-0}+1 )); if [ "$verdict" = PASS ];then PASS=$((PASS+1));else FAIL=$((FAIL+1));fi; printf 'CHECK %-32s %-4s — %s\n' "$id" "$verdict" "$detail"; }
value(){ node -e 'const x=require(process.argv[1]);let v=x[process.argv[2]];process.stdout.write(typeof v==="string"?v:JSON.stringify(v))' "$ANALYSIS" "$1" 2>/dev/null; }
truev(){ [ "$(value "$1")" = true ]; }

if [ "$PI_RC" = 0 ];then report pi-exit PASS "real pi session exited 0 before timeout's 60s TERM plus 5s KILL bound";else report pi-exit FAIL "pi exited $PI_RC";fi
if [ "$ANALYZE_RC" = 0 ]&&[ -f "$ANALYSIS" ]&&[ "$(value rpcBad)" = '[]' ]&&[ "$(value hostBad)" = '[]' ]&&[ "$(value workerBad)" = '[]' ];then report json-lines PASS "rpc, host, and worker JSON Lines parse completely";else report json-lines FAIL "missing or unparseable evidence (rpc=$(value rpcBad), host=$(value hostBad), worker=$(value workerBad))";fi
if [ "$ANALYZE_RC" = 0 ]&&[ "$(value extensionErrors)" = '[]' ];then report extension-errors PASS "pi emitted no extension_error event";else report extension-errors FAIL "extension errors: $(value extensionErrors)";fi
if truev workingTree;then report working-tree PASS "/slate command is attributed inside the checkout under test";else report working-tree FAIL "/slate source path is outside the checkout: $(value slatePath)";fi
if truev providerRoute;then report provider-route PASS "Pi's registered provider handled orchestrator, worker, and compressor calls offline";else report provider-route FAIL "the custom API registration or call classification is wrong";fi
if truev oneDispatch;then report one-dispatch PASS "one real thread dispatch returned the expected status";else report one-dispatch FAIL "the real thread result is missing, duplicated, or failed";fi
if truev workerRequests;then report worker-requests PASS "the worker followed the expected tool and response sequence";else report worker-requests FAIL "the worker request sequence or fixed success marker is wrong";fi
if truev toolResultsClean;then report tool-results PASS "all expected built-in read results persisted unchanged";else report tool-results FAIL "a built-in read result differs from its exact persisted shape";fi
if truev reminderExact;then report reminder-exact PASS "the exact slate-worker-reminder entries persisted with display:false";else report reminder-exact FAIL "the reminder count, content, custom type, or display flag is wrong";fi
if truev reminderOrder;then report reminder-order PASS "each reminder follows its tool results and precedes the next assistant message";else report reminder-order FAIL "the persisted reminder is outside the required turn boundary";fi
if truev continuationReminder;then report continuation-context PASS "the provider received each exact reminder in the expected request and order";else report continuation-context FAIL "the continuation requests have missing, extra, reordered, or changed reminders";fi
if truev noExtraWorkerCall;then report call-count PASS "the provider saw only the expected calls in order";else report call-count FAIL "an expected provider call is missing, reordered, or duplicated";fi
case "$PROFILE" in
	normal|model|rejected|steer-*)
		if truev reopenedRecords; then report reopened-records PASS "Pi reopened the exact ordinary records and hidden reminders"
		else report reopened-records FAIL "reopened ordinary records or hidden reminders differ"; fi ;;
esac
case "$PROFILE" in
	normal|threshold) ;;
	*)
		echo "PROFILE cadence $CADENCE: $(value profileEvidence)"
		if truev extraChecks; then report profile-evidence PASS "$PROFILE has exact profile-specific cause and outcome"
		else report profile-evidence FAIL "$PROFILE cause or outcome differs"; fi ;;
esac
if [ "$THRESHOLD" = 1 ]; then
  echo "THRESHOLD cadence $CADENCE: $(value thresholdEvidence)"
  check_threshold() {
    local verdict=FAIL
    if truev "$2"; then verdict=PASS; fi
    report "$1" "$verdict" "$3"
  }
  check_threshold idle-startup sameIdleStartup "the idle worker starts with twelve exact history messages"
  check_threshold usage-threshold atThreshold "only the combined final usage exceeds the fixed threshold"
  check_threshold compaction-offset compactedAfterAnswer "the saved answer position reflects the expected compaction outcome"
  check_threshold observation-bytes observationExact "the stored observation equals the expected final answer byte for byte"
fi
if truev silentLossClean;then report silent-loss PASS "the delivered reminder produces no false reminder-miss warning";else report silent-loss FAIL "the delivered reminder or returned warnings are inconsistent";fi
if truev compressorClean;then report compressor-input PASS "the compressor request contains no reminder text or custom type";else report compressor-input FAIL "the worker reminder leaked into the compressor request";fi
if truev episodeClean;then report durable-episode PASS "the durable episode exists and contains no reminder text or custom type";else report durable-episode FAIL "the durable episode is missing or contains a worker reminder";fi
if truev configBoundary;then report config-boundary PASS "the expected extension allowlist and cacheKeyEnabled:false did not prevent delivery";else report config-boundary FAIL "the required scratch config boundary or delivery proof is missing";fi
if truev hostSuccess;then report host-completion PASS "the orchestrator received the thread result and returned its fixed marker";else report host-completion FAIL "the orchestrator completion marker is missing";fi
ROSTER_OK=1
for id in $EXPECTED;do [ "${SEEN[$id]:-0}" = 1 ]||ROSTER_OK=0;done
for id in "${!SEEN[@]}";do case " $EXPECTED " in *" $id "*) ;; *) ROSTER_OK=0 ;; esac;done
if [ "$ROSTER_OK" = 1 ];then printf 'CHECK %-32s %-4s — %s\n' roster PASS "all expected check ids reported exactly once";PASS=$((PASS+1));else printf 'CHECK %-32s %-4s — %s\n' roster FAIL "missing, duplicate, or unexpected check id";FAIL=$((FAIL+1));fi
ELAPSED_MS=$(( (END_NS-START_NS)/1000000 ))
echo "== $PROFILE cadence $CADENCE summary: $PASS pass, $FAIL fail (${ELAPSED_MS} ms, pi $PIVER) =="
echo "BYTES cadence $CADENCE: $(value byteCosts)"
echo "NOTE   display:false is proven structurally; visual invisibility in the terminal user interface stays a manual check."
echo "NOTE   this clean delivery run cannot prove that a real missing reminder produces a warning; unit and resolver checks cover that path."
if [ "$FAIL" -ne 0 ];then KEEP=1;echo;echo "---- pi stderr ----";cat "$STDERR";echo "---- end pi stderr ----";echo "---- pi stdout ----";cat "$STDOUT";echo "---- end pi stdout ----";echo "artifacts: $LAB";fi
[ "$FAIL" -eq 0 ]
)

verdict=0
for pair in normal:20 normal:1 threshold:20 threshold:1 rejected:1 steer-one:1 steer-all:1 \
	model:20 model:1 handler:20 handler:1 compact-cancel:1 compact-fail:1 overflow:20 overflow:1 overflow-disabled:20 overflow-disabled:1 length:20 length:1; do
	run_case "${pair#*:}" "${pair%:*}"
	rc=$?
	if [ "$rc" = 2 ]; then exit 2; fi
	if [ "$rc" != 0 ]; then verdict=1; fi
done
exit "$verdict"
