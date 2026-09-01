#!/usr/bin/env bash
# =============================================================================
# slate — integrated research log, guidance and session list check (Track 15)
# =============================================================================
# Starts TWO real pi sessions against a deterministic in-process fake provider.
# The first session accepts one record change, so slate creates its session
# directory and one empty research log inside it. It then dispatches ONE real
# worker action that writes a unique marker through the exact prompt path. The
# second session continues the same pi conversation and restores that path.
#
# It proves the CONNECTED paths that no focused check covers: storage selection,
# durable creation, research log creation, doctrine path delivery, worker system
# prompt path delivery, shipped public guidance, session list output, and the
# same path again after a real restore.
#
# Pi startup runs offline, and the fake provider performs no network operation.
# This is not a network sandbox. Reviewed extension code can still open sockets.
# The child receives an empty environment with only explicit throwaway values.
#
# Usage: bash verification/run-research-log-check.sh --repo .
# Exit status: 0 all checks passed · 1 a check failed · 2 refused to start.
# =============================================================================
set -uo pipefail

exec 8>&2
die() { echo "verification: refused to start — $*" >&8; exit 2; }

REPO="."
while [ $# -gt 0 ]; do
	case "$1" in
		--repo) [ "$#" -ge 2 ] || die "option '--repo' requires a value"; REPO="$2"; shift 2 ;;
		-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
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
CANARY="$REPO/verification/research-log-canary.mjs"
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

LAB="$(mktemp -d "${TMPDIR:-/tmp}/slate-research-log-check.XXXXXX")" || die "could not create a scratch directory"
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
PROJECT="$(cd "$PROJECT" && pwd -P)" || die "cannot resolve the physical scratch project"
FIRST_EVIDENCE="$LAB/first-evidence.jsonl"
SECOND_EVIDENCE="$LAB/second-evidence.jsonl"
COMPLETION="$LAB/worker-complete.json"
MARKER="SLATE_RESEARCH_LOG_MARKER_$(date +%s%N)_$$"
ANALYSIS="$LAB/analysis.json"
: > "$FIRST_EVIDENCE" || die "could not create the first provider evidence file"
: > "$SECOND_EVIDENCE" || die "could not create the second provider evidence file"

# A worker session is a NEW pi agent session, and it resolves its provider key
# from the agent configuration rather than from the extension registration. The
# fake catalogue below supplies that key. The canary's own streamSimple still
# answers every call, so no request leaves the process.
cat > "$AGENT/models.json" <<'JSON' || die "could not write the scratch model catalogue"
{
  "providers": {
    "slate-research-log-fake": {
      "baseUrl": "http://127.0.0.1:9/v1",
      "apiKey": "offline-canary-key",
      "api": "openai-completions",
      "models": [
        { "id": "research-log-model", "name": "Research log model", "reasoning": false,
          "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 1000000, "maxTokens": 1024 }
      ]
    }
  }
}
JSON
echo '{}' > "$AGENT/auth.json" || die "could not write the scratch auth file"

cat > "$PROJECT/.pi/slate.json" <<'JSON' || die "could not write scratch slate config"
{
  "orchestratorModeDefault": true,
  "contextBudget": 200000,
  "workerExtensions": ["research-log-canary"]
}
JSON

# Turn one: the mode change is the FIRST accepted record change, so slate mints
# its session directory and creates the empty research log. The prompt that
# follows renders the doctrine through the real before_agent_start hook. The
# session list runs last and must report both directories.
printf '%s\n' \
	'{"id":"commands","type":"get_commands"}' \
	'{"id":"mode","type":"prompt","message":"/slate on"}' \
	'{"id":"turn","type":"prompt","message":"SLATE_RESEARCH_LOG_DISPATCH_REQUEST"}' \
	'{"id":"list","type":"prompt","message":"/slate sessions"}' > "$LAB/rpc.first" \
	|| die "could not write the first rpc input"
printf '%s\n' \
	'{"id":"turn","type":"prompt","message":"State the research log path again."}' > "$LAB/rpc.second" \
	|| die "could not write the second rpc input"

# Build a minimal child PATH for pi's /usr/bin/env node launcher. No variable
# from the caller crosses this env -i boundary. Dead proxies deter ordinary HTTP
# clients, but they do not block raw sockets and are not a sandbox.
NODE_BIN="$(command -v node)"
NODE_DIR="${NODE_BIN%/*}"
PI_DIR="${PI%/*}"
CHILD_PATH="$NODE_DIR:$PI_DIR:/usr/bin:/bin"
DEAD_PROXY="http://127.0.0.1:9"

# Pi's rpc mode exits at stdin EOF without waiting for a running tool. The first
# producer therefore keeps stdin open until the parent provider observes the
# completed thread result and writes COMPLETION. No fixed sleep is involved.
feed_until_complete() {
	node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [input, completion] = process.argv.slice(2);
process.stdout.write(fs.readFileSync(input));
const deadline = Date.now() + 45_000;
const poll = () => {
  if (fs.existsSync(completion)) return process.exit(0);
  if (Date.now() >= deadline) return process.exit(124);
  setTimeout(poll, 50);
};
poll();
NODE
}

run_pi() {
	local input="$1" out="$2" err="$3" evidence="$4" completion="$5"
	shift 5
	(
		cd "$PROJECT" || exit 125
		if [ -n "$completion" ]; then feed_until_complete "$input" "$completion"; else cat "$input"; fi | env -i \
			HOME="$CHILD_HOME" PATH="$CHILD_PATH" TMPDIR="$CHILD_TMP" \
			PI_CODING_AGENT_DIR="$AGENT" PI_OFFLINE=1 \
			HTTP_PROXY="$DEAD_PROXY" HTTPS_PROXY="$DEAD_PROXY" ALL_PROXY="$DEAD_PROXY" NO_PROXY="" \
			SLATE_RESEARCH_LOG_EVIDENCE="$evidence" \
			SLATE_RESEARCH_LOG_COMPLETION="${completion:-$LAB/no-completion}" \
			SLATE_RESEARCH_LOG_MARKER="$MARKER" \
			timeout --kill-after=5 60 "$PI" --no-extensions -e "$REPO" -e "$CANARY" --mode rpc -a \
				--provider slate-research-log-fake --model research-log-model "$@"
	) > "$out" 2> "$err"
}

START_NS="$(date +%s%N)"
run_pi "$LAB/rpc.first" "$LAB/first.out" "$LAB/first.err" "$FIRST_EVIDENCE" "$COMPLETION"
FIRST_RC=$?
run_pi "$LAB/rpc.second" "$LAB/second.out" "$LAB/second.err" "$SECOND_EVIDENCE" "" --continue
SECOND_RC=$?
END_NS="$(date +%s%N)"

node - "$LAB" "$PROJECT" "$AGENT" "$REPO" "$ANALYSIS" "$MARKER" "$COMPLETION" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [lab, project, agent, repo, analysisFile, marker, completionFile] = process.argv.slice(2);

function jsonLines(file) {
  if (!fs.existsSync(file)) return { values: [], bad: ["missing file"] };
  const values = [], bad = [];
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try { values.push(JSON.parse(line)); } catch (e) { bad.push(`line ${i + 1}: ${e.message}`); }
  });
  return { values, bad };
}

const first = jsonLines(path.join(lab, "first.out"));
const second = jsonLines(path.join(lab, "second.out"));
const firstEvidence = jsonLines(path.join(lab, "first-evidence.jsonl"));
const secondEvidence = jsonLines(path.join(lab, "second-evidence.jsonl"));

// Slate stores one corpus project directory per project, and one session
// directory inside it. Both are discovered rather than assumed.
const projectsRoot = path.join(agent, "ytdb-slate", "projects");
let areas = [];
try { areas = fs.readdirSync(projectsRoot).map((n) => path.join(projectsRoot, n)); } catch {}
const sessionNamePattern = /^[a-z]+-[a-z]+-[0-9a-f]{4}$/;
const sessionDirs = areas.flatMap((area) => {
  let names = [];
  try { names = fs.readdirSync(area); } catch { return []; }
  return names.filter((n) => sessionNamePattern.test(n)).map((n) => path.join(area, n));
});
const sessionDirectory = sessionDirs.length === 1 ? sessionDirs[0] : "";
const researchLog = sessionDirectory === "" ? "" : path.join(sessionDirectory, "research-log.md");

function statOf(file) {
  try { return fs.statSync(file); } catch { return undefined; }
}
const logStat = researchLog === "" ? undefined : statOf(researchLog);
let logText = "";
try { logText = fs.readFileSync(researchLog, "utf8"); } catch {}
let completion;
try { completion = JSON.parse(fs.readFileSync(completionFile, "utf8")); } catch {}

// Track 15 stores NO location choice. A stored key would mean the removed field
// came back, so its absence is asserted rather than its value.
let storedRuntimeKeys = [];
let storedThreads = [];
let storedEpisodes = [];
try {
  const state = JSON.parse(fs.readFileSync(path.join(sessionDirectory, "state.json"), "utf8"));
  storedRuntimeKeys = Object.keys(state?.runtime ?? {});
  storedThreads = state?.runtime?.threads ?? [];
  storedEpisodes = state?.runtime?.episodes ?? [];
} catch {}

// The shipped public guidance of Track 15 goals 4 and 5. README.md ships in every
// npm package, and this check reads the file the package publishes.
let guidance = "";
try { guidance = fs.readFileSync(path.join(repo, "README.md"), "utf8"); } catch {}
const sectionHeading = "## Storage situations you need to know";
const sectionStart = guidance.indexOf(sectionHeading);
const sectionTail = sectionStart < 0 ? "" : guidance.slice(sectionStart + sectionHeading.length);
const nextHeading = /^## /mu.exec(sectionTail);
const guidanceSection = nextHeading === null ? "" : sectionTail.slice(0, nextHeading.index);
const situationHeadings = [...guidanceSection.matchAll(/^\*\*(\d+)\. ([^*]+)\*\*/gmu)];
const parsedSituations = situationHeadings.map((match, index) => ({
  number: Number(match[1]),
  title: match[2].trim(),
  body: guidanceSection.slice(
    match.index + match[0].length,
    situationHeadings[index + 1]?.index ?? guidanceSection.length,
  ).trim(),
}));
const situationFacts = [
  [/Slate takes no lock across processes\./u, /one Slate session in one pi process at a time\./u],
  [/Two Slate sessions can share one project directory\./u, /Slate neither assigns nor enforces a single writer\./u, /Decide which Slate session changes project files\./u],
  [/Do not edit or delete `session\.json`, `state\.json`, episode files, observation files, or worker conversation files\./u, /You may read `research-log\.md`\./u, /Slate directs a worker to update that research log\./u],
  [/An ordinary copy of a project directory therefore gets a new and empty storage area\./u],
  [/A linked Git worktree can share the storage area/u, /still starts a new Slate session/u],
  [/A backup of the project alone omits every Slate record\./u, /Back up the pi agent directory together with the project directory\./u],
  [/Slate does not relocate a stored Slate session after a move or a rename\./u, /The moved project may no longer reach them\./u],
  [/The session directory stays under the pi agent directory\./u, /Delete a session directory yourself when you want those records gone\./u],
  [/A different pi agent directory shows different records\./u, /A different operating system user shows different records\./u, /Your model provider account changes nothing here\./u],
  [/Portable Operating System Interface \(POSIX\)/u, /Windows permission behaviour differs/u, /not a cross-platform access promise/u],
  [/This version refuses metadata that does not match its current shape\./u, /blocks the creation of the new session directory\./u, /Move every older session directory out/u, /Slate cannot read them again\./u],
];
const guidanceSituations = parsedSituations.map((item) => item.number);
const guidanceFacts = parsedSituations.map((item, index) =>
  (situationFacts[index] ?? []).every((pattern) => pattern.test(`${item.title} ${item.body}`)),
);

// Every notify text of one rpc stream, which is where a slate command answers.
function notifications(stream) {
  return stream.values
    .filter((o) => o && typeof o === "object")
    .map((o) => JSON.stringify(o))
    .join("\n");
}
const firstText = notifications(first);
const listLine = firstText.split("\\n").find((line) => line.includes("session directory: ")) ?? "";

const firstOrchestrator = firstEvidence.values.filter((v) => v.worker !== true);
const firstWorker = firstEvidence.values.filter((v) => v.worker === true);
const parentThreadResults = firstOrchestrator.flatMap((v) => v.toolResults ?? []).filter((v) => v.toolName === "thread");
const workerWriteResults = firstWorker.flatMap((v) => v.toolResults ?? []).filter((v) => v.toolName === "write");
const firstPrompts = firstOrchestrator.map((v) => v.systemPrompt ?? "");
const workerPrompts = firstWorker.map((v) => v.systemPrompt ?? "");
const secondPrompts = secondEvidence.values.filter((v) => v.worker !== true).map((v) => v.systemPrompt ?? "");
const exactLine = researchLog === "" ? "" : `Research log of this Slate session: <<${researchLog}>>`;
const workerLine = researchLog === "" ? "" : `Slate keeps the research log of this session at <<${researchLog}>>.`;
const pendingSentence = "Slate has no exact path before then";
const withheldSentence = "Slate cannot present that exact path";
const removedSentence = "keeps its research log at the project directory path it";

const result = {
  firstBad: first.bad,
  secondBad: second.bad,
  evidenceBad: [...firstEvidence.bad, ...secondEvidence.bad],
  extensionErrors: [...first.values, ...second.values].filter((o) => o?.type === "extension_error"),
  slatePath: first.values.find((o) => o?.type === "response" && o.command === "get_commands")?.data?.commands?.find?.((c) => c?.name === "slate")?.sourceInfo?.path ?? "",
  // Orchestrator records only. A worker session is a separate pi agent session,
  // and this canary's session_start does not run in it, so a worker record
  // carries no trust fields.
  trustedConfigEvidenceCount: firstOrchestrator.length,
  trustedConfig: firstOrchestrator.length > 0
    && firstOrchestrator.every((v) => v.trusted === true && v.cwd === project),
  sessionDirectoryCount: sessionDirs.length,
  sessionDirectory,
  researchLog,
  logHasExactMarker: logStat !== undefined && logStat.isFile() && logText === marker,
  completionSignal: completion?.marker === marker && completion?.threadResult === true,
  storedRuntimeKeys,
  noStoredLocation: storedRuntimeKeys.length > 0 && !storedRuntimeKeys.includes("researchLogLocation"),
  projectLogAbsent: statOf(path.join(project, "research-log.md")) === undefined,
  firstProviderCalls: firstPrompts.length,
  workerProviderCalls: workerPrompts.length,
  secondProviderCalls: secondPrompts.length,
  doctrineExactPath: firstPrompts.length > 0 && exactLine !== "" && firstPrompts.every((p) => p.includes(exactLine)),
  doctrineNoFallback: firstPrompts.length > 0
    && firstPrompts.every((p) => !p.includes(pendingSentence) && !p.includes(withheldSentence) && !p.includes(removedSentence)),
  workerExactPath: workerPrompts.length > 0 && workerLine !== "" && workerPrompts.every((p) => p.includes(workerLine)),
  workerWriteSucceeded: workerWriteResults.length === 1 && workerWriteResults[0].isError !== true,
  parentToolSucceeded: parentThreadResults.length === 1 && parentThreadResults[0].isError !== true && parentThreadResults[0].text.includes("STATUS: OK"),
  completedEpisode: storedThreads.length === 1 && storedThreads[0]?.status === "successful"
    && storedEpisodes.length === 1 && storedEpisodes[0]?.status === "ok"
    && storedThreads[0]?.episodeId === storedEpisodes[0]?.id,
  guidanceShipped: parsedSituations.length === 11
    && parsedSituations.every((item) => item.title !== "" && item.body !== "")
    && guidanceSituations.every((value, index) => value === index + 1)
    && guidanceFacts.length === 11 && guidanceFacts.every(Boolean),
  guidanceSituations,
  guidanceFacts,
  guidanceTitles: parsedSituations.map((item) => item.title),
  resumeSamePath: secondPrompts.length > 0 && exactLine !== "" && secondPrompts.every((p) => p.includes(exactLine)),
  listReportsBoth: firstText.includes(`session directory: ${sessionDirectory}\\n  project directory: ${project}`),
  listExactSessionDirectory: listLine.includes(`session directory: ${sessionDirectory}`),
  listLine,
  listNoWorktreeLabel: firstText.includes("session directory: ") && !firstText.includes("| worktree "),
  recordsUnderReportedPath: sessionDirectory !== ""
    && ["episodes", "observations", "threads"].every((c) => statOf(path.join(sessionDirectory, c))?.isDirectory() === true),
  workingTree: typeof repo === "string",
};
result.workingTree = typeof result.slatePath === "string" && (result.slatePath === repo || result.slatePath.startsWith(repo + "/"));
fs.writeFileSync(analysisFile, JSON.stringify(result, null, 2));
NODE
ANALYZE_RC=$?

EXPECTED="pi-exit rpc-json working-tree trusted-config hook-errors one-session-directory research-log-created worker-log-marker completion-signal no-stored-location project-log-absent doctrine-exact-path doctrine-no-fallback worker-exact-path worker-write-result parent-tool-result completed-episode guidance-shipped resume-same-path list-both-directories list-exact-session-directory list-no-stale-label records-under-reported-path"
declare -A SEEN=()
PASS=0; FAIL=0
report() {
	local id="$1" verdict="$2" detail="$3"
	SEEN[$id]=$(( ${SEEN[$id]:-0} + 1 ))
	if [ "$verdict" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
	printf 'CHECK %-30s %-4s — %s\n' "$id" "$verdict" "$detail"
}
value() { node -e 'const x=require(process.argv[1]);let v=x[process.argv[2]];process.stdout.write(typeof v==="string"?v:JSON.stringify(v))' "$ANALYSIS" "$1" 2>/dev/null; }
truev() { [ "$(value "$1")" = true ]; }

if [ "$FIRST_RC" = 0 ] && [ "$SECOND_RC" = 0 ]; then
	report pi-exit PASS "both real pi sessions exited 0 before timeout's 60s TERM plus 5s KILL bound"
else report pi-exit FAIL "first pi exited $FIRST_RC and continued pi exited $SECOND_RC"; fi
if [ "$ANALYZE_RC" = 0 ] && [ -f "$ANALYSIS" ] && [ "$(value firstBad)" = '[]' ] && [ "$(value secondBad)" = '[]' ] && [ "$(value evidenceBad)" = '[]' ]; then
	report rpc-json PASS "both rpc streams and both provider evidence files parse completely"
else report rpc-json FAIL "unparseable or missing JSON evidence (first=$(value firstBad), second=$(value secondBad), evidence=$(value evidenceBad))"; fi
if truev workingTree; then report working-tree PASS "/slate command is attributed inside the checkout under test"
else report working-tree FAIL "/slate source path is outside the checkout: $(value slatePath)"; fi
if truev trustedConfig; then report trusted-config PASS "the canary observed the trusted scratch project on every provider call"
elif [ "$(value trustedConfigEvidenceCount)" = 0 ]; then report trusted-config FAIL "the harness collected no evidence"
else report trusted-config FAIL "provider evidence did not confirm the trusted scratch project"; fi
if [ "$ANALYZE_RC" = 0 ] && [ "$(value extensionErrors)" = '[]' ]; then report hook-errors PASS "pi emitted no extension_error event in either session"
else report hook-errors FAIL "extension errors: $(value extensionErrors)"; fi
if [ "$(value sessionDirectoryCount)" = 1 ]; then report one-session-directory PASS "the two sessions share exactly one session directory: $(value sessionDirectory)"
else report one-session-directory FAIL "session directory count is $(value sessionDirectoryCount)"; fi
if [ -n "$(value researchLog)" ] && [ -f "$(value researchLog)" ]; then report research-log-created PASS "slate created $(value researchLog)"
else report research-log-created FAIL "no research log inside the session directory"; fi
if truev logHasExactMarker; then report worker-log-marker PASS "the worker wrote the exact unique marker through the displayed research log path"
else report worker-log-marker FAIL "the research log does not contain only the expected marker"; fi
if truev completionSignal; then report completion-signal PASS "the parent provider observed the completed thread result before stdin closed"
else report completion-signal FAIL "the deterministic completion signal is missing or invalid"; fi
if truev noStoredLocation; then report no-stored-location PASS "state.json stores runtime keys without any research log location key"
else report no-stored-location FAIL "stored runtime keys are $(value storedRuntimeKeys)"; fi
if truev projectLogAbsent; then report project-log-absent PASS "the project directory received no research log"
else report project-log-absent FAIL "a research log appeared in the project directory"; fi
if truev doctrineExactPath; then report doctrine-exact-path PASS "every system prompt of the first session carried the exact research log path"
else report doctrine-exact-path FAIL "the exact path is missing from a system prompt ($(value firstProviderCalls) provider calls)"; fi
if truev doctrineNoFallback; then report doctrine-no-fallback PASS "no system prompt carried the pending or project-directory case beside the exact path"
else report doctrine-no-fallback FAIL "a system prompt blended two research log location cases"; fi
if truev workerExactPath; then report worker-exact-path PASS "every worker system prompt of the dispatched action carried the exact research log path"
else report worker-exact-path FAIL "no worker prompt carried the exact path ($(value workerProviderCalls) worker provider calls)"; fi
if truev workerWriteSucceeded; then report worker-write-result PASS "the worker write tool returned one successful result"
else report worker-write-result FAIL "the worker write result was absent, duplicated, or failed"; fi
if truev parentToolSucceeded; then report parent-tool-result PASS "the parent received one successful thread tool result with STATUS: OK"
else report parent-tool-result FAIL "the successful parent thread tool result was absent or duplicated"; fi
if truev completedEpisode; then report completed-episode PASS "state.json stores one successful thread linked to one completed OK episode"
else report completed-episode FAIL "stored thread and episode state does not prove completion"; fi
if truev guidanceShipped; then report guidance-shipped PASS "the shipped README has eleven non-empty ordered situations with every decisive fact"
else report guidance-shipped FAIL "the shipped public guidance is incomplete (situations: $(value guidanceSituations), facts: $(value guidanceFacts))"; fi
if truev resumeSamePath; then report resume-same-path PASS "the continued session restored the same path from stored state"
else report resume-same-path FAIL "the continued session lost the path ($(value secondProviderCalls) provider calls)"; fi
if truev listReportsBoth; then report list-both-directories PASS "/slate sessions reported both exact paths on separate labelled lines"
else report list-both-directories FAIL "session list entry is wrong: $(value listLine)"; fi
if truev listExactSessionDirectory; then report list-exact-session-directory PASS "the displayed session directory exactly matches the worker research log parent"
else report list-exact-session-directory FAIL "the displayed session directory is not exact: $(value listLine)"; fi
if truev listNoWorktreeLabel; then report list-no-stale-label PASS "the session list no longer prints the former worktree label"
else report list-no-stale-label FAIL "the session list still prints the former worktree label"; fi
if truev recordsUnderReportedPath; then report records-under-reported-path PASS "the reported session directory holds the episode, observation and thread records"
else report records-under-reported-path FAIL "the reported session directory does not hold the record categories"; fi

ROSTER_OK=1
for id in $EXPECTED; do [ "${SEEN[$id]:-0}" = 1 ] || ROSTER_OK=0; done
for id in "${!SEEN[@]}"; do case " $EXPECTED " in *" $id "*) ;; *) ROSTER_OK=0 ;; esac; done
if [ "$ROSTER_OK" = 1 ]; then
	printf 'CHECK %-30s %-4s — %s\n' roster PASS "all expected check ids reported exactly once"
	PASS=$((PASS+1))
else
	printf 'CHECK %-30s %-4s — %s\n' roster FAIL "missing, duplicate, or unexpected check id"
	FAIL=$((FAIL+1))
fi

ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
echo "== summary: $PASS pass, $FAIL fail (${ELAPSED_MS} ms, pi $PIVER) =="
if [ "$FAIL" -ne 0 ]; then
	KEEP=1
	echo
	for stream in first second; do
		echo "---- pi $stream stderr ----"; cat "$LAB/$stream.err"; echo "---- end ----"
		echo "---- pi $stream stdout ----"; cat "$LAB/$stream.out"; echo "---- end ----"
	done
	echo "artifacts: $LAB"
fi
[ "$FAIL" -eq 0 ]
