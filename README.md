# ytdb-slate

[![CI status](https://github.com/JetBrains/ytdb-slate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JetBrains/ytdb-slate/actions/workflows/ci.yml)

Slate is a thread-weaving orchestration extension for the [pi coding agent](https://pi.dev).

The orchestrator is your main pi session. It dispatches each **bounded action** to a new **worker thread**. Each thread runs one action. A large language model compresses successful work and failed partial work into one **episode**. A failure without a worker response uses a fixed episode and no compression call. The episode retains intent, actions, findings, artifacts, open issues, and handoff notes.

The orchestrator composes episodes into later dispatches instead of re-reading raw transcripts. Slate also injects a mandatory workflow doctrine. Its gates use focus areas backed by user-approved proofs. Optional **draft-PR publishing** uses either one pull request per track or one umbrella pull request.

Slate uses one trusted **logical-model policy** for action routing and recovery. Each action names a provider-free logical model and a short reason. The policy fixes effort, exact physical routes, capability and cost ratings, guidance, cautions, and bounded recovery order.

### Join our Zulip community!

If you are interested in Slate, consider joining our [Zulip](https://youtrackdb.zulipchat.com/#narrow/channel/634235-slate)
community.
Tell us about exciting applications you are building, ask for help, or just chat with friends 😃


## Why Slate?

Long-horizon agentic work fails on context management, not model capability. Existing architectures each solve a piece of the problem and trade away the rest. Compaction is unpredictably lossy. Naive subagents isolate context but hand back only a single response string. Markdown plans go stale and get under-executed. Rigid task trees cannot adapt to information discovered mid-task, and planner/executor stacks synchronize through compress-and-return boundaries that risk dropping critical state.

Slate's answer is the **thread**: the orchestrator dispatches one bounded action at a time. The worker executes it and returns an **episode**. The orchestrator keeps the reactivity of a plain agent loop while gaining the context isolation, compaction, and parallelism that the single-context loop lacks.

| Aspect | ReAct | Markdown plan | Task trees | RLM (Recursive Language Models) | Devin / Manus / Altera | Claude Code / Codex subagents | Slate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Planning | implicit | file | explicit tree | REPL | planning agent | plan mode | implicit / adaptive — no upfront static plan |
| Decomposition | none | none | direct tree | REPL functions | task-based | subagent delegation | implicit |
| Synchronization | single thread | single thread | gated steps | REPL return | reduce & return | message passing | episodes |
| Intermediate feedback | per step | per step | on task failure | on execution end | after compress | message passing | per episode |
| Context isolation | none | none | per subtask | per subcall | subagent | subagent | per thread |
| Context compaction | none | none | task-based | REPL slicing | subagent compress | compaction | episode compress |
| Parallel execution | none | none | none | in REPL | Altera only | native | native |
| Expressivity | high | high | low | high | medium | medium | high |
| Adaptability | yes | if plan updated | no | limited — no mid-run course correction | yes | limited by message passing | yes |

Characterizations of third-party systems reflect their publicly described designs at the time of writing. The taxonomy is adapted from the Random Labs technical report introducing the thread-weaving "Slate" architecture (its agent ships as the npm package `@randomlabs/slate`). ytdb-slate is an independent implementation of that architecture for pi.

**Threads are not subagents:**

- **Per-episode feedback.** Each thread executes one bounded action and hands control back. The orchestrator adapts after every episode — reactive like a ReAct loop — instead of firing off a subagent and hoping the result comes back usable.
- **Compaction at a chosen boundary.** Compression happens at a predictable point — action completion — instead of mid-stream when context overflows. The compression itself is still LLM-performed and lossy, but the boundary is chosen, not forced.
- **Episodes compose.** A follow-up action uses a new thread. The caller passes earlier episode identifiers through `context`. Slate loads that episode content into the new worker prompt. Subagents pass back one response string. Episodes are durable, structured records.

Full rationale: [`docs/design-principles.md`](docs/design-principles.md), shipped in the package — if this summary and that document disagree, the document wins.

## Feature development workflow

In orchestrator mode, Slate injects a mandatory track-based development workflow. Project configuration can extend it through `doctrineExtraPath`. Configuration cannot replace it.

Eleven focus areas name specific risks. They cover
concurrency defects, data loss, security weaknesses, performance degradation,
test-quality defects, unreadable user-facing prose, licensing exposure,
non-local logic defects, consumer contract breaks, governing-rule defects, and
unreported failures.
During planning, the orchestrator writes an independent risk record for the
change and for every track. Each record has one line for every focus area. A
NAMED line carries a four-part proof. User approval makes that area proved.
User rejection makes it SKIPPED. Only proved areas add gates or routine
implementation reviewers. A track with at least one proved area gets one general
Reviewer I plus every required area specialist. A track with no proved area gets
no routine implementation reviewer.

The workflow follows these steps:

1. **Plan and confirm** — the orchestrator proposes all eleven focus lines. The user alone approves or rejects each NAMED proof.
2. **Design** — a proved DESIGN-TRIGGERING area requires a high-level design. The user validates it before focus reconfirmation and one adversarial design review per proved DESIGN-TRIGGERING area. Final design approval follows.
3. **Implement tracks** — each track is one coherent, independently mergeable unit with its own focus set. About 400 added plus removed lines is a planning guideline. The orchestrator estimates before splitting work. The implementer estimates during work and stops at a coherent boundary near the guideline. A small overrun may finish the nearest coherent unit and must include its reason. Lockfiles, migration files, and generated output do not count.
4. **Review and deliver** — when a track has a proved area, one Reviewer I and every required area specialist inspect it in separate review actions. A zero-area track reports routine implementation review as `NOT REQUIRED`. Tracks with a proved DESIGN-TRIGGERING area require blocking user acceptance. Other tracks do not. Where a marker applies, it follows required machine gates, the packet, and resolution of blocking user notes. Per-track mode uses the user-merged commit instead. Final change acceptance is always blocking.

Draft-PR publishing activates only when `workflow.draftPRs` is `true`. The orchestrator then asks once whether every track gets its own pull request. A yes answer requires user merges in sequence and a fresh branch from updated `main` for each next track. A no answer keeps one umbrella draft pull request.

This summary provides orientation only. The shipped docs listed below are normative.

## Logical-model routing and recovery

Every `thread` call names a provider-free logical `model` and a short `reason`.
The active policy fixes effort and permits exact provider and model pairs. Slate
resolves one immutable policy when the parent session starts. Dispatch,
compression, main-session recovery, doctrine, and `/slate effective` share it.

The shipped ordinary pool has seven definitions. A trusted project can replace
membership, add complete definitions, replace selected fields, and exclude
members. The independent compressor list defaults to Sonnet at `medium`.
Untrusted projects use home preferences over the shipped policy and consume no project router data.
Critical errors block logical work. Legacy physical-router keys produce named
warnings and receive no automatic migration.

Pi retries the active physical route first. Slate advances only after Pi reports
known retry exhaustion. Recovery tries another permitted provider for the same
logical model before it moves through the ordinary or compressor order. Unknown
outcomes and cancellation stop recovery. One operation owns recovery. An
overlapping operation receives a visible busy refusal. Slate does not queue or
replay it.

Pi 0.85.1 model and effort switches are session-only unless persistence is
requested. Slate retains its saved-default compatibility guard for explicit
persistence and older behavior. Slate retains bounded completed worker output
when compression fails or is cancelled. A failed episode write can prevent an
episode. A failed final state save can leave episode bytes without a proved
durable reference. Both failures remain visible. A remembered later compressor
starts later actions at that entry and does not move backward until preference
reset. This is an accepted limitation. `extension/index.ts` is the supported
package entry.
The new logical-runtime exports are internal and unstable. The same rule applies
to retry-evidence exports, which classify provider retry outcomes.
[`docs/model-routing.md`](docs/model-routing.md) defines the complete contract.

## Writing guidance

Writing guidance and checker findings are active in orchestrator mode when the project is trusted or a home configuration file exists. Slate adds one doctrine rule for writing and another for design discipline. It also adds a status value such as `writing 2 fail, 3 style / 10 turns` in interactive sessions. The value reports model-visible findings in the latest ten measured prose turns. Each worker with permitted Slate settings gets a shorter reminder about reader understanding, semicolons, and contractions.

The guidance has prompt cost. Each orchestrator system prompt contains both doctrine rules. You pay for this text on every turn. Each worker with permitted Slate settings also gets the preamble addition.

> **No conformance claim:** This is a dictionary-free proxy. It embeds no controlled vocabulary and claims no ASD-STE100 conformance.

The shipped CLI checks plain files, JSONL records, and unified diffs. See [`docs/writing-guidance.md`](docs/writing-guidance.md) for its rules, limits, output, and command examples.

Slate sends hidden reminders after completed turns. The default cadence is four completed turns. A model-visible finding can trigger an immediate reminder when that option is enabled. The reminder carries the writing and conversation title, three retained style rules, ten writing requirements, and seven design requirements. A findings section appears only when the latest measured turn carries a model-visible finding. The requirements exclude research logs, worker task text, and this project's agent instruction file.

## Install

Install into a project (pinned, project-scoped — recorded in `.pi/settings.json`):

```bash
pi install -l npm:ytdb-slate@<version>
```

> **Note on pinning:** pinned specs (`@<version>`) are deliberately skipped by `pi update --extensions` / `pi update --all`. Bumping the pin is a conscious project change — review Slate's shipped workflow docs for changes when you do.

## Configuration

Slate reads two optional configuration files at session start:

- Home: `<getAgentDir()>/slate.json`, normally `~/.pi/agent/slate.json`. Pi's `PI_CODING_AGENT_DIR` environment variable can select another agent directory.
- Project: `<cwd>/.pi/slate.json`, read **only when the project is trusted**.

Project values override home values. Objects merge recursively. Arrays, scalar values, and explicit `null` replace the home value. Arrays never append. Slate applies its existing setting validators after the merge.

A missing file is valid. An unreadable file, invalid JSON, or a root that is not an object produces a warning naming that file. Any such error in a permitted file blocks model routing, even when the other file is valid.

Home preferences also apply in untrusted projects. Without a home file, existing project behavior and defaults stay unchanged. Configuration edits require a new session.

Paths in `orchestratorPromptDocs`, `workerPromptDocs`, `doctrineExtraPath`, and `reviewPerspectivesPath` belong to the file that supplies the value. Relative home paths start at the agent directory. Relative project paths start at the project root, not `.pi`. Absolute paths stay absolute. See [Trust](#trust) for the security boundary.

Pi can refresh a prompt cache by sending background requests. Slate disables those requests in every worker because they bypass its request limits. This does not disable prompt caching for ordinary worker requests. The main session and saved pi settings stay unchanged.

| Key | Type | Default | Semantics |
| --- | --- | --- | --- |
| `orchestratorModeDefault` | boolean | `false` | Start fresh interactive sessions with orchestrator mode ON. |
| `workerTools` | string[] | `["read", "bash", "edit", "write", "grep", "find", "ls"]` | Tools available to worker threads (an empty list also falls back to the default). |
| `workerExtensions` | string[] | `[]` | Regex patterns (matched **unanchored**) selecting which of the host session's already-loaded extensions also load into every worker thread; each matched extension's tools are added **on top of** `workerTools`. Empty (default) means workers load no project or discovered extensions. Slate still supplies one internal reminder component. The orchestrator keeps its restricted tool set but its doctrine is told what was whitelisted. Invalid patterns are dropped with a warning at session start. |
| `cacheKeyEnabled` | boolean | `true` | Add one OpenAI Responses prompt cache key to all workers in the current main Slate session. Another main session receives another key. `false` disables key injection. It does not disable request throttling. Provider requests with `cacheRetention: "none"`, including worker summaries, keep that opt-out and receive no forced key. |
| `cacheKeyShards` | number | ignored | This removed partitioning key has no effect. Slate reports it once at session start. Remove it from `slate.json`. |
| `requestThrottle.enabled` | boolean | `true` | Pace OpenAI Responses worker requests. `false` disables pacing. It does not disable cache-key injection. The scope includes worker turns, failover requests, history compaction, and branch summaries. It excludes orchestrator requests, episode compression, other provider interfaces, other sessions and processes, and direct tool requests. |
| `requestThrottle.maxRequestsPerMinute` | number | `12` | Maximum logical SDK requests admitted for one actual `provider/id` in the preceding 60 seconds. The value must be a whole number from 1 through 1000. Provider network retries inside one SDK request do not consume another admission. Different models have independent counters. This threshold is request pacing, not a cache-hit or provider-rate-limit guarantee. |
| `requestThrottle.baseWaitMs` | number | `1000` | Base delay before a blocked request rechecks capacity. The value must be a whole number from 1 through 60000. A positive minimum prevents a repeated zero-delay loop. |
| `requestThrottle.jitterMs` | number | `1000` | Uniform random extra delay from zero through this inclusive bound before a blocked request rechecks. The value must be a whole number from 0 through 60000. Admission is approximately fair. It is not first-in-first-out and does not promise a bounded wait. |
| `maxConcurrent` | number | `4` | Maximum number of worker actions running concurrently (must be ≥ 1 — unenforced: a value of 0 or less silently hangs all dispatches). Excess actions wait for a global concurrency slot. Every action has its own thread. Default rationale: shipped `docs/design-principles.md` §5 (repo-local note). |
| `contextBudget` | number \| object | `256000` (Anthropic models: `400000`) | Absolute orchestrator context budget (tokens) at which Slate auto-pauses and prepares a fresh-session handoff — semantics, defaults, per-model overrides, and rationale in [`docs/context-budget.md`](docs/context-budget.md). |
| `orchestratorPromptDocs` | string[] | `[]` | Markdown files whose paths follow the source rules above and whose **contents** are appended to the orchestrator system prompt. |
| `workerPromptDocs` | string[] | `[]` | Markdown files whose **contents** are appended to every worker-thread system prompt. |
| `workflow.draftPRs` | boolean | `false` | Enable draft-PR publishing. Before implementation, ask once whether each track gets its own pull request or all tracks share one umbrella pull request. |
| `workflow.followUpIssues` | boolean | `false` | When true, the orchestrator asks which deferred items become tracked issues. Deferred items are always reported whatever the value. |
| `workflow.routingRecommendations` | boolean | `false` | Before final acceptance, add evidence-bounded routing advice for logical models dispatched during the current change. The advice is optional and never edits routing files. |
| `writing.check` | boolean | ignored | This ignored writing key remains accepted for compatibility. Remove it from `slate.json`. Guidance is automatic during orchestrator mode when the project is trusted or a home file exists. See [`docs/writing-guidance.md`](docs/writing-guidance.md). |
| `writing.remind` | boolean | ignored | This ignored writing key remains accepted for compatibility. Remove it from `slate.json`. Reminder gates require orchestrator mode, permitted Slate settings, no pause, and a ready trigger. Delivery is limited to one reminder per response round. See [`docs/writing-guidance.md`](docs/writing-guidance.md). |
| `writing.remindPercent` | number | ignored | This retired key remains accepted and ignored. Slate emits a notice. Replace it with `writing.remindTurns`, which counts completed turns instead of a token-budget share. |
| `writing.remindTurns` | number | `4` | Set the reminder cadence in completed turns. The value must be a whole number from 1 through 20. An invalid value warns and falls back to `4`. See [`docs/writing-guidance.md`](docs/writing-guidance.md). |
| `writing.remindOnFinding` | boolean | `true` | Send a reminder on the turn after a measured turn with a model-visible finding. An invalid value warns and falls back to `true`. `writing.findings: false` disables this trigger. |
| `writing.sentenceWordLimit` | number \| boolean | `25` | Set the sentence-length house-style limit in words. The value must be a whole number from 10 through 200, inclusive, or `false` to turn the rule off. See [`docs/writing-guidance.md`](docs/writing-guidance.md). |
| `writing.statusWindowTurns` | number | `10` | Set the whole-number status window from 3 through 100 measured turns. An invalid value warns and falls back to `10`. The status line reports model-visible fail and style counts in this window. |
| `writing.findings` | boolean | `true` | Include the latest model-visible writing findings in the hidden reminder. An invalid value warns and falls back to `true`. Measurement and the status line continue when this value is `false`. |
| `doctrineExtraPath` | string | — | Markdown whose **content** is appended to the orchestrator doctrine (project-specific workflow additions). |
| `reviewPerspectivesPath` | string | — | Review charters, each declaring its own finding-ID prefix. The doctrine references this **path**; the orchestrator reads the file alongside the shipped review rules. |
| `router.models` | object | shipped seven-model pool | Ordinary membership and definitions. `include` replaces the starting membership, including with an empty list. `add` accepts complete new definitions. `replace` changes selected fields. `exclude` applies last. Within each model definition, lists and provider maps replace shipped fields. The home and project configuration files merge first. |
| `router.compressor.models` | array of `{ model, effort }` | `[{"model":"claude-sonnet-5","effort":"medium"}]` | Independent ordered compressor list. An explicit empty list blocks work. |

Example `.pi/slate.json` (the `docs/agents/...` paths are placeholders — point them at markdown files that actually exist in **your** project):

```json
{
  "orchestratorModeDefault": true,
  "cacheKeyEnabled": true,
  "requestThrottle": { "enabled": true, "maxRequestsPerMinute": 12, "baseWaitMs": 1000, "jitterMs": 1000 },
  "maxConcurrent": 4,
  "orchestratorPromptDocs": ["docs/agents/orchestrator-guidelines.md"],
  "workerPromptDocs": ["docs/agents/thread-guidelines.md"],
  "workflow": { "draftPRs": true, "followUpIssues": false, "routingRecommendations": false },
  "writing": { "remindTurns": 4, "remindOnFinding": true, "sentenceWordLimit": 25, "statusWindowTurns": 10, "findings": true },
  "doctrineExtraPath": "docs/agents/workflow-additions.md",
  "reviewPerspectivesPath": "docs/agents/review-perspectives.md",
  "router": {
    "models": { "include": ["gpt-5.6-luna", "claude-opus-5"] },
    "compressor": { "models": [{ "model": "claude-sonnet-5", "effort": "medium" }] }
  }
}
```

Remove `writing.check` and `writing.remind` when copying an older configuration. Current Slate reports these ignored writing keys.

> **Silent skip:** document-path errors produce no warning. Slate skips missing, unreadable, or empty files selected by `orchestratorPromptDocs`, `workerPromptDocs`, and `doctrineExtraPath`. For `reviewPerspectivesPath`, Slate omits the pointer only when the file is missing. Slate does not read that file at injection time, so an unreadable or empty file is still cited. Verify your paths after copying the example.

**Worker extensions (`workerExtensions`).** By default worker threads load no project or discovered extensions. Slate supplies one internal reminder component to every worker session. After tool results reach its handler, the component tells the worker to issue independent tool calls in one turn. It sends the reminder once for each such turn. The reminder persists in the worker transcript and stays hidden from the user in the normal terminal interface. The component is not gated on project trust.

This key is a list of regex patterns that select extensions the **host session has already loaded** and load them into every worker too. Each pattern is matched **unanchored** (unlike `contextBudget.overrides`, which is anchored) against a load unit's recorded source spec (e.g. `npm:pi-web-search@1.3.1`), its load-unit path, or the entry path of any tool that unit contributes, so a bare package name matches:

```json
{
  "workerExtensions": ["pi-smart-fetch", "pi-web-search"]
}
```

Every worker then gets the fetch and web-search tools **on top of** `workerTools` (and on top of the per-dispatch `tools` argument of the `thread` tool — those two govern the built-in tools only). The orchestrator itself does **not** gain these tools — orchestrator mode keeps its restricted set — but its doctrine gains a rule naming each whitelisted extension and its tools, so it knows what it can delegate.

For project and discovered extensions, pi's discovery, project-trust gating, and dedup remain the only ingress. A worker cannot load a whitelisted extension that the host is not running. An extension that registers no tools cannot be whitelisted. A host started with extensions disabled offers nothing to whitelist. Slate's internal reminder component is the separate always-loaded input described above.

**What to know before whitelisting** — it reaches past Slate's isolation, so it is an operator decision:

- **Delegation is unbounded.** Slate guarantees only that no worker obtains Slate's own `thread`/`threads`/`episode` tools. A whitelisted extension that ships its own sub-agent or delegation tool under any other name gives workers delegation Slate can neither detect, bound, nor account for.
- **Credential and filesystem reach.** Inside a worker the extension has the same filesystem and credential access it has in the host. Slate's read-only settings snapshot blocks pi-settings writes and nothing else.
- **Worker lifecycle.** Slate completes each selected extension's `session_start` before the worker action begins. A startup failure blocks the action. Slate emits one `session_shutdown` before it disposes the worker, including after startup or action failure and during host shutdown.
- **Abort.** A third-party extension may ignore the abort signal, so its network activity can outlive an abort or a context-budget pause. During a pause, Slate still allows orchestrator state-save workers while it refuses new user prompts.
- **Cost.** Provider-native tool billing can escape Slate's worker cost accounting.
- **Pathological patterns.** The patterns are regexes from your own trusted config — the same file that already steers models, prompts, and tool lists — matched with no time bound while the extension set is resolved once per session. A pattern with catastrophic backtracking can stall that resolution. Avoid such patterns. They are not a privilege boundary.

The load-time recursion guard behind this — and the risks it does and does not cover — is in [`docs/design-principles.md`](docs/design-principles.md).

**Worker provider registrations.** Every worker inherits host extension provider registrations that are absent after the worker session is constructed. This behavior is independent of `workerExtensions`. It supports provider-only extensions that register no tools. The worker's own registration wins by provider id, even when one side uses a native provider and the other uses the config form. A built-in provider is not an extension registration, so a host extension override of a built-in is inherited.

Inheritance happens after worker session construction and before route authentication or the first model request. Slate copies current registrations and reuses their provider functions. Nested config values and native provider objects can remain shared by reference. A worker uses its own pi credential resolution, but inherited provider authentication callbacks and configured keys can read or update the same credential files and third-party state that the host uses. Slate does not copy host event handlers such as `before_provider_headers`, `before_provider_request`, or `after_provider_response`. Provider extensions that depend on those handlers will not behave the same in a worker.

A worker extension can register the same provider id during construction. Its registration takes precedence. Slate does not synchronize later host changes or intercept later worker registrations. Pi can merge a later partial worker registration with inherited config. That merge can retain inherited credentials while changing the endpoint. This accepted startup-only boundary requires extension authors to replace provider configuration carefully. Compatibility with specific third-party provider extensions has not been verified.

## Trust

Slate excludes untrusted project Slate configuration and content selected through that configuration. Home preferences remain active, including documents and host extensions selected by those preferences. A home document path can point into a working tree, so select those paths carefully.

Home preferences do not change pi's project-trust decision. Pi's independent instruction loading stays unchanged. In particular, this feature does not filter pi's `AGENTS.md` context files. Slate still requires project trust before it restores pending handoff state. Worker pi settings remain nonpersistent.

## Shipped docs

In orchestrator mode, Slate appends a short **doctrine** (a block of numbered rules) to the orchestrator's system prompt each turn. The doctrine does not embed the workflow docs — it cites them by **absolute path**, resolved inside the installed package (not your project), and the orchestrator reads them on demand. Those embedded paths make the block's character count depend on your install location. [`docs/context-budget.md`](docs/context-budget.md) has the measured sizes, with and without the optional rules, and the arithmetic for your own install:

- `docs/track-workflow.md` — the focus-area lifecycle for research, design, implementation, review, and delivery
- `docs/pr-publishing.md` — per-track and umbrella draft-PR publishing (cited only when `workflow.draftPRs` is `true`)
- `docs/review-rules.md` — reviewer composition, the composite test-quality role, evidence standards, findings, and fix gates
- `docs/design-principles.md` — Slate's own design rationale
- `docs/context-budget.md` — the orchestrator `contextBudget`: defaults, per-model overrides, the window clamp, and the pricing rationale (also **reference documentation**, not cited by the doctrine)
- `docs/writing-guidance.md` — the always-active writing convention, ignored writing keys, status line, and checker CLI
- `docs/model-routing.md` — the logical-model policy, exact defaults, configuration, common recovery, history, and accepted limitations. The doctrine cites this absolute path for trusted sessions.
Project-specific additions layer on top — they extend, not replace, the shipped doctrine — via two distinct mechanisms:

- **Content injection**: `doctrineExtraPath` (appended to the doctrine itself, re-read at each prompt assembly) and `orchestratorPromptDocs` / `workerPromptDocs` (appended to the respective system prompts).
- **Pointer**: `reviewPerspectivesPath` is cited by path from the doctrine's review rule and read on demand, like the shipped docs.

## License

Apache-2.0 — see [LICENSE](LICENSE).
