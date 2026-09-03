# ytdb-slate

[![CI status](https://github.com/JetBrains/ytdb-slate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JetBrains/ytdb-slate/actions/workflows/ci.yml)

Slate is a thread-weaving orchestration extension for the [pi coding agent](https://pi.dev).

The orchestrator is your main pi session. It dispatches each **bounded action** to a new **worker thread**. Each thread runs one action. A large language model compresses successful work and failed partial work into one **episode**. A failure without a worker response uses a fixed episode and no compression call. The episode retains intent, actions, findings, artifacts, open issues, and handoff notes.

The orchestrator composes episodes into later dispatches instead of re-reading raw transcripts. Slate also injects a mandatory workflow doctrine. Its gates use a confirmed size grade and the focus areas the change engages. Optional umbrella **draft-PR publishing** covers tracks.

An opt-in **model-failover** map adds high availability: when a model API fails, the orchestrator, worker threads, and episode compression each retry once on a configured equal-quality alternative. A second opt-in, **action-level model routing**, gives each dispatched action a model and an effort level chosen to be up to the task and no more, so cost is bounded per action instead of per session.

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

Slate uses three workload grades. SMALL covers up to 50 predicted changed
production-logic lines. MEDIUM covers 51 through 1,000. LARGE covers more than
1,000. More than 25 changed files raises SMALL or MEDIUM by one grade.

Focus is separate from size. Ten focus areas add design or review gates. They
cover concurrency, durability, security, core behavior, performance, design
uncertainty, contracts, silent failures, project test artifacts, and
user-facing or licensing-adjacent prose. Every project test artifact gets a
separate test-quality and structure reviewer. That reviewer checks behavioral
effectiveness and test isolation.

The workflow follows these steps:

1. **Predict and confirm** — the orchestrator predicts size and focus before implementation. The user confirms both together.
2. **Design** — MEDIUM and LARGE need a high-level design. Design uncertainty adds adversarial review. Removing or altering an existing consumer-reachable rule also adds it. A purely additive public rule does not.
3. **Implement tracks** — each track declares its files and focus areas. Track reviews are non-blocking. Final change acceptance remains blocking.
4. **Measure** — the size command shipped with Slate checks the committed range at the first track boundary.
5. **Review and deliver** — grade and focus select fresh machine reviewers. The user gives final acceptance and performs any squash merge.

SMALL has a mechanical fast path. Any focus area, project test artifact, or
verification machinery voids it. Umbrella draft-PR publishing activates only
when `workflow.draftPRs` is `true`.

This summary provides orientation only. The shipped docs listed below are normative.

## Model failover

Slate can ride through model API outages. The opt-in `modelFailover` map in `.pi/slate.json` (trusted projects only) maps a model (`provider/id`) to an equal-quality alternative. On an eligible model API failure — not an abort or a context overflow, and for the orchestrator and worker sites only after pi's own retries are exhausted — the affected site (orchestrator, worker thread, or episode compression) retries once on the mapped model (single hop, never chained). An orchestrator failover — like the handoff adoption that re-applies a parent session's model — would otherwise leave pi's global model defaults changed, so Slate restores them on a best-effort basis unless `preserveGlobalModelDefault` is `false`. The map is empty by default (feature off) and read once at session start. Full semantics: the `modelFailover` row in [Configuration](#configuration) and the shipped [`docs/model-failover.md`](docs/model-failover.md) — if they disagree, that document wins.

## Action-level model routing

Slate can pick the model and effort level for each action. `router.models` in `.pi/slate.json` is a closed list of `provider/id` specs for trusted projects. Each action uses its explicit `model` and `effort` when present. Otherwise, Slate derives the lowest measured effort for the selected base model. An empty list disables candidate-list enforcement, base seeding, and effort derivation. Explicit action arguments stay active in both router states. Slate checks explicit effort against pi's vocabulary. Slate also checks the model ladder when profile data exists. Each action opens a new worker session. [`docs/model-routing.md`](docs/model-routing.md) holds the full contract.

Router startup warnings have two classes. One class is a configuration fault. It reports project configuration that Slate ignored or dropped. A configuration fault also covers problems the user can stop by adding a model, credential, or failover entry.

The addition must go into their project configuration or pi credentials. Removing the model named by a warning does not meet this second test. Slate always shows configuration faults.

The other class is a model data note. It reports shipped research data that project configuration cannot correct. Slate hides those notes by default.

With this repository's six-model list and pi's stock registry, Slate hides eleven notes. Slate shows one discoverability line instead. A local registry override can change that count. The line names the hidden warning count and the `router.showWarnings` setting. Hidden notes do not change model selection.

The dispatch guards refuse an unlisted model and an invalid effort level. They mark an unmeasured level. They refuse that level only when `router.allowUnmeasuredEffort` is `false`. Slate does not substitute models by context size. Slate does not print a long-prompt price notice. The doctrine states profile-based obligations that code does not enforce. Full semantics appear in the `router.*` configuration rows and [`docs/model-routing.md`](docs/model-routing.md).

## Writing guidance

Writing guidance and human-only telemetry are active for every trusted project in orchestrator mode. Slate adds one doctrine rule for writing and another for design discipline. It also adds a status value such as `writing 1/4` in interactive sessions. This value means one of four measured prose turns had a fail-level finding. Each trusted worker gets a shorter reminder about reader understanding, semicolons, and contractions.

The guidance has prompt cost. Each orchestrator system prompt contains both doctrine rules. You pay for this text on every turn. Each trusted worker session also gets the preamble addition.

> **No conformance claim:** This is a dictionary-free proxy. It embeds no controlled vocabulary and claims no ASD-STE100 conformance.

The shipped CLI checks plain files, JSONL records, and unified diffs. See [`docs/writing-guidance.md`](docs/writing-guidance.md) for its rules, limits, output, and command examples.

Slate sends context-paced reminders after eligible tool results. Context-paced means Slate waits for configured context growth between reminders. The reminders are hidden from the normal terminal user interface. They repeat nine writing requirements and six design requirements before the next assistant response. The requirements exclude research logs, worker task text, and this project's agent instruction file.

## Install

Install into a project (pinned, project-scoped — recorded in `.pi/settings.json`):

```bash
pi install -l npm:ytdb-slate@<version>
```

> **Note on pinning:** pinned specs (`@<version>`) are deliberately skipped by `pi update --extensions` / `pi update --all`. Bumping the pin is a conscious project change — review Slate's shipped workflow docs for changes when you do.

## Configuration

Optional config file: `slate.json` in the project's pi config dir (`.pi/slate.json`). It is honored **only in trusted projects** (see [Trust](#trust)).

| Key | Type | Default | Semantics |
| --- | --- | --- | --- |
| `orchestratorModeDefault` | boolean | `false` | Start fresh interactive sessions with orchestrator mode ON. |
| `episodeModel` | string | newest available Anthropic Sonnet, else the orchestrator's own base model | Model (`provider/id`) used to compress a successful action or failed partial work into an episode. A failure without a worker response uses no compression model. Never the model an action was routed to: an episode is read by every later consumer of the thread, so one cheap route must not degrade the record. An unusable value is reported and the default is used. |
| `workerTools` | string[] | `["read", "bash", "edit", "write", "grep", "find", "ls"]` | Tools available to worker threads (an empty list also falls back to the default). |
| `workerExtensions` | string[] | `[]` | Regex patterns (matched **unanchored**) selecting which of the host session's already-loaded extensions also load into every worker thread; each matched extension's tools are added **on top of** `workerTools`. Empty (default) means workers load no extensions. The orchestrator keeps its restricted tool set but its doctrine is told what was whitelisted. Invalid patterns are dropped with a warning at session start. |
| `maxConcurrent` | number | `4` | Maximum number of worker actions running concurrently (must be ≥ 1 — unenforced: a value of 0 or less silently hangs all dispatches). Excess actions wait for a global concurrency slot. Every action has its own thread. Default rationale: shipped `docs/design-principles.md` §5 (repo-local note). |
| `contextBudget` | number \| object | `256000` (Anthropic models: `400000`) | Absolute orchestrator context budget (tokens) at which Slate auto-pauses and prepares a fresh-session handoff — semantics, defaults, per-model overrides, and rationale in [`docs/context-budget.md`](docs/context-budget.md). |
| `orchestratorPromptDocs` | string[] | `[]` | Project markdown files (paths relative to the project root) whose **contents** are appended to the orchestrator system prompt. |
| `workerPromptDocs` | string[] | `[]` | Project markdown files whose **contents** are appended to every worker-thread system prompt. |
| `workflow.draftPRs` | boolean | `false` | Enable umbrella draft-PR publishing for tracks. |
| `workflow.followUpIssues` | boolean | `false` | When true, the orchestrator asks which suggestions become follow-up issues in the project tracker. Suggestions are always reported whatever the value. |
| `writing.check` | boolean | ignored | This ignored writing key remains accepted for compatibility. Remove it from `slate.json`. Guidance is automatic in trusted projects during orchestrator mode. See [`docs/writing-guidance.md`](docs/writing-guidance.md). |
| `writing.remind` | boolean | ignored | This ignored writing key remains accepted for compatibility. Remove it from `slate.json`. Reminder gates are orchestrator mode, project trust, no pause, cadence or handoff force, and one-per-round control. See [`docs/writing-guidance.md`](docs/writing-guidance.md). |
| `writing.remindPercent` | number | `5` | Set cadence as a percentage of Slate's current effective context budget. The value must be finite and in `(0, 100]`. The interval has an 8,192-token floor and no cap. A handoff force bypasses this threshold. See [`docs/writing-guidance.md`](docs/writing-guidance.md). |
| `doctrineExtraPath` | string | — | Project markdown whose **content** is appended to the orchestrator doctrine (project-specific workflow additions). |
| `reviewPerspectivesPath` | string | — | Project review charters, each declaring its own finding-ID prefix. The doctrine references this **path**; the orchestrator reads the file alongside the shipped review rules. |
| `modelFailover` | object (string → string) | — (empty, failover off) | Map of `provider/id` → equal-quality alternative model; on a model API failure the affected site retries once on the mapped model (worker/orchestrator sites only after pi's own retries are exhausted; episode compression has no pi retry loop). Read once at session start — see [`docs/model-failover.md`](docs/model-failover.md). |
| `preserveGlobalModelDefault` | boolean | `true` | Put pi's global model defaults (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`) back after a Slate-initiated model switch — orchestrator failover and handoff adoption — so the switch stays session-scoped. `false` turns that restore off at both sites (the switches themselves are unaffected), leaving each one persisted in pi's global settings. Best-effort: Slate reverts only a value its own switch produced, and can stand down or give up — limits in [`docs/model-failover.md`](docs/model-failover.md). |
| `router.models` | string[] | `[]` (empty — routing off) | Closed list of models (`provider/id`) an action may use. Empty or absent means the router is OFF. Slate enforces no candidate list, seeds no thread base, derives no effort level, and runs no router-only window, billing, or substitution path. Per-action `model` and `effort` arguments stay active on both router states. Slate still checks explicit effort against pi's vocabulary and the routed model's ladder when it has that model's profile data. An action that omits `model` plans for the thread's pre-router pin, and a thread with no pin gives it no plan target. An action that omits `effort` resolves no level. In both cases the worker session returns to what it opened on. The known cases where the model or level that runs differs are listed in [`docs/model-routing.md`](docs/model-routing.md). A listed model becomes routable only if Slate has its benchmark profile, pi registers it, and credentials are configured. Slate drops other entries with a warning. If all entries drop, routing turns off with one summary warning. Slate reads and resolves the list once per session. See [`docs/model-routing.md`](docs/model-routing.md). |
| `router.allowUnmeasuredEffort` | boolean | `true` | What happens when an explicitly requested effort level is on the target model's ladder but has no capability measurement in Slate's profiles: `true` dispatches it with a ⚠ notice and marks the episode `(unmeasured level)`; `false` refuses the dispatch. Either way a level that is off the model's ladder, or one the provider rejects outright, is refused, and a level Slate DERIVES for an action is always a measured one. |
| `router.showWarnings` | boolean | `false` | Reveal model data notes about Slate's shipped routing research. Configuration faults are never hidden. See [`docs/model-routing.md`](docs/model-routing.md). |

Example `.pi/slate.json` (the `docs/agents/...` paths are placeholders — point them at markdown files that actually exist in **your** project):

```json
{
  "orchestratorModeDefault": true,
  "episodeModel": "anthropic/claude-sonnet-5",
  "maxConcurrent": 4,
  "orchestratorPromptDocs": ["docs/agents/orchestrator-guidelines.md"],
  "workerPromptDocs": ["docs/agents/thread-guidelines.md"],
  "workflow": { "draftPRs": true, "followUpIssues": false },
  "writing": { "remindPercent": 5 },
  "doctrineExtraPath": "docs/agents/workflow-additions.md",
  "reviewPerspectivesPath": "docs/agents/review-perspectives.md",
  "modelFailover": { "anthropic/claude-sonnet-5": "openai/gpt-5.2" },
  "router": { "models": ["openai/gpt-5.6-luna", "anthropic/claude-opus-5"] }
}
```

Remove `writing.check` and `writing.remind` when copying an older configuration. Current Slate reports these ignored writing keys.

> **Silent skip:** the project-file keys fail silently — no error is shown. For the content-injected keys (`orchestratorPromptDocs`, `workerPromptDocs`, `doctrineExtraPath`) a missing, unreadable, or empty file is skipped and nothing is injected. For `reviewPerspectivesPath` the pointer is omitted only when the file is missing — the file is not read at injection time, so an unreadable or empty file is still cited. Verify your paths after copying the example.

**Worker extensions (`workerExtensions`).** By default worker threads load no extensions. This key is a list of regex patterns that select extensions the **host session has already loaded** and load them into every worker too. Each pattern is matched **unanchored** (unlike `contextBudget.overrides`, which is anchored) against a load unit's recorded source spec (e.g. `npm:pi-web-search@1.3.1`), its load-unit path, or the entry path of any tool that unit contributes, so a bare package name matches:

```json
{
  "workerExtensions": ["pi-smart-fetch", "pi-web-search"]
}
```

Every worker then gets the fetch and web-search tools **on top of** `workerTools` (and on top of the per-dispatch `tools` argument of the `thread` tool — those two govern the built-in tools only). The orchestrator itself does **not** gain these tools — orchestrator mode keeps its restricted set — but its doctrine gains a rule naming each whitelisted extension and its tools, so it knows what it can delegate. pi's discovery, project-trust gating, and dedup remain the only ingress: a worker can never load an extension the host is not running, an extension that registers no tools cannot be whitelisted, and a host started with extensions disabled offers nothing to whitelist.

**What to know before whitelisting** — it reaches past Slate's isolation, so it is an operator decision:

- **Delegation is unbounded.** Slate guarantees only that no worker obtains Slate's own `thread`/`threads`/`episode` tools. A whitelisted extension that ships its own sub-agent or delegation tool under any other name gives workers delegation Slate can neither detect, bound, nor account for.
- **Credential and filesystem reach.** Inside a worker the extension has the same filesystem and credential access it has in the host. Slate's read-only settings snapshot blocks pi-settings writes and nothing else.
- **Unsynced model-scoped tools.** Worker sessions never fire the session-start event, so an extension whose tool set is model-scoped stays unsynced and may offer a tool the worker's model cannot serve (e.g. pi-web-search's `url_context` on a non-Google worker model) — the call simply fails and the episode records it.
- **Abort.** A third-party extension may ignore the abort signal, so its network activity can outlive an abort or a context-budget pause.
- **Cost.** Provider-native tool billing can escape Slate's worker cost accounting.
- **Pathological patterns.** The patterns are regexes from your own trusted config — the same file that already steers models, prompts, and tool lists — matched with no time bound while the extension set is resolved once per session. A pattern with catastrophic backtracking can stall that resolution. Avoid such patterns. They are not a privilege boundary.

The load-time recursion guard behind this — and the risks it does and does not cover — is in [`docs/design-principles.md`](docs/design-principles.md).

## Trust

Slate reads project configuration (`.pi/slate.json`) and injects project files (`orchestratorPromptDocs`, `workerPromptDocs`, `doctrineExtraPath`, `reviewPerspectivesPath`) **only in trusted projects**. In untrusted projects Slate runs with built-in defaults and injects nothing from the working tree.

## Shipped docs

In orchestrator mode, Slate appends a short **doctrine** (a block of numbered rules) to the orchestrator's system prompt each turn. The doctrine does not embed the workflow docs — it cites them by **absolute path**, resolved inside the installed package (not your project), and the orchestrator reads them on demand. Those embedded paths make the block's character count depend on your install location. [`docs/context-budget.md`](docs/context-budget.md) has the measured sizes, with and without the optional rules, and the arithmetic for your own install:

- `docs/track-workflow.md` — the size-grade and focus-area lifecycle for research, design, implementation, review, and delivery
- `docs/pr-publishing.md` — umbrella draft-PR publishing (cited only when `workflow.draftPRs` is `true`)
- `docs/review-rules.md` — reviewer composition, the composite test-quality role, evidence standards, findings, and fix gates
- `docs/design-principles.md` — Slate's own design rationale
- `docs/model-failover.md` — the opt-in `modelFailover` map (**reference documentation** — unlike the entries above it is not workflow doctrine and is not cited by the doctrine)
- `docs/context-budget.md` — the orchestrator `contextBudget`: defaults, per-model overrides, the window clamp, and the pricing rationale (also **reference documentation**, not cited by the doctrine)
- `docs/writing-guidance.md` — the always-active writing convention, ignored writing keys, status line, and checker CLI
- `docs/model-routing.md` — the action-level model routing reference. It covers the three `router` keys, model eligibility, omitted effort, and dispatch guards. It also covers first-session warnings. The doctrine cites this absolute path only while the routing rule renders. This path is fourth normally and fifth when `workflow.draftPRs` is on. The rule renders the live list because it depends on the session registry and credentials.

Project-specific additions layer on top — they extend, not replace, the shipped doctrine — via two distinct mechanisms:

- **Content injection**: `doctrineExtraPath` (appended to the doctrine itself, re-read at each prompt assembly) and `orchestratorPromptDocs` / `workerPromptDocs` (appended to the respective system prompts).
- **Pointer**: `reviewPerspectivesPath` is cited by path from the doctrine's review rule and read on demand, like the shipped docs.

## License

Apache-2.0 — see [LICENSE](LICENSE).
