# ytdb-slate

[![CI status](https://github.com/JetBrains/ytdb-slate/actions/workflows/tier-1.yml/badge.svg?branch=main)](https://github.com/JetBrains/ytdb-slate/actions/workflows/tier-1.yml)

Slate is a thread-weaving orchestration extension for the [pi coding agent](https://pi.dev).

The orchestrator (your main pi session) dispatches **bounded actions** to persistent **worker threads**. Each completed action is compressed by an LLM into an **episode** — a durable, structured record (intent, actions, findings, artifacts, open issues, handoff notes) that the orchestrator composes into further dispatches instead of re-reading raw transcripts. On top of that, Slate injects a mandatory workflow doctrine: research before design, design review, adversarial review, and track review — with optional umbrella **draft-PR publishing** for tracks. An opt-in **model-failover** map adds high availability: when a model API fails, the orchestrator, worker threads, and episode compression each retry once on a configured equal-quality alternative. A second opt-in, **action-level model routing**, gives each dispatched action a model and an effort level chosen to be up to the task and no more, so cost is bounded per action instead of per session.

## Why Slate?

Long-horizon agentic work fails on context management, not model capability. Existing architectures each solve a piece of the problem and trade away the rest. Compaction is unpredictably lossy; naive subagents isolate context but hand back only a single response string; markdown plans go stale and get under-executed. Rigid task trees can't adapt to information discovered mid-task, and planner/executor stacks synchronize through compress-and-return boundaries that risk dropping critical state.

Slate's answer is the **thread**: the orchestrator dispatches one bounded action at a time; the worker executes it and returns an **episode**. The orchestrator keeps the reactivity of a plain agent loop while gaining the context isolation, compaction, and parallelism that the single-context loop lacks.

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

Characterizations of third-party systems reflect their publicly described designs at the time of writing. The taxonomy is adapted from the Random Labs technical report introducing the thread-weaving "Slate" architecture (its agent ships as the npm package `@randomlabs/slate`); ytdb-slate is an independent implementation of that architecture for pi.

**Threads are not subagents:**

- **Per-episode feedback.** Each thread executes one bounded action and hands control back. The orchestrator adapts after every episode — reactive like a ReAct loop — instead of firing off a subagent and hoping the result comes back usable.
- **Compaction at a chosen boundary.** Compression happens at a predictable point — action completion — instead of mid-stream when context overflows. The compression itself is still LLM-performed and lossy, but the boundary is chosen, not forced.
- **Episodes compose.** One thread's episode can seed another thread's context, so conclusions travel across the system by reference. Subagents pass back a single response string; episodes are durable, structured, reusable records.

Full rationale: [`docs/design-principles.md`](docs/design-principles.md), shipped in the package — if this summary and that document disagree, the document wins.

## Feature development workflow

In orchestrator mode, Slate injects a track-based development workflow as doctrine — it is not optional; project configuration can extend it (`doctrineExtraPath`) but never replace it. The flow:

1. **Research** — interactive exploration; a research log opens lazily when defined triggers fire (non-trivial decisions, surprises, risky invariants, session boundaries).
2. **User design review** — the user approves the design direction before any machine review.
3. **Adversarial review** — a fresh-context reviewer attacks the design pre-implementation; findings are triaged with the user.
4. **Track split approval** — the user approves how the change splits into independently reviewable tracks.
5. **Per-track loop** — implement → agent code review → fixes → mandatory user review → marker commit (an empty commit marking the track's boundary in history).
6. **Delivery** — with draft-PR publishing enabled, the squash-merge is performed by the user; the agent never merges. With it disabled (the default), the change lands as a squashed commit that carries the workflow log's key content in its message.

The workflow scales with change size: multi-track changes get the full flow, single-track changes skip the split and the marker commits, and trivial changes shrink the pre-implementation reviews to consent plus a micro-review (skippable with explicit user consent) — the agent code review and the mandatory user review still apply at every tier. Umbrella draft-PR publishing activates only when `workflow.draftPRs` is `true`.

This summary is orientation only; the shipped docs listed below are normative.

## Model failover

Slate can ride through model API outages. The opt-in `modelFailover` map in `.pi/slate.json` (trusted projects only) maps a model (`provider/id`) to an equal-quality alternative; on an eligible model API failure — not an abort or a context overflow, and for the orchestrator and worker sites only after pi's own retries are exhausted — the affected site (orchestrator, worker thread, or episode compression) retries once on the mapped model (single hop, never chained). An orchestrator failover — like the handoff adoption that re-applies a parent session's model — would otherwise leave pi's global model defaults changed, so Slate restores them on a best-effort basis unless `preserveGlobalModelDefault` is `false`. The map is empty by default (feature off) and read once at session start. Full semantics: the `modelFailover` row in [Configuration](#configuration) and the shipped [`docs/model-failover.md`](docs/model-failover.md) — if they disagree, that document wins.

## Action-level model routing

Slate can pick the model and the effort level per dispatched action rather than running every action on whatever model the orchestrator happens to be on. `router.models` in `.pi/slate.json` (trusted projects only) is a closed list of `provider/id` specs. Each action uses its `model` and `effort` arguments when present. Otherwise, it uses the thread's base model and a level DERIVED for the model it routes to. That level is the lowest one with a capability measurement, never a fixed default. The list is empty by default. An empty list disables candidate-list enforcement, base seeding, effort derivation, and the router's window, billing, and substitution paths. Per-action `model` and `effort` arguments stay active on both router states. Slate always checks an explicit effort against pi's vocabulary, and against the ladder of the model it routes to whenever it has that model's profile data. An action that omits `model` plans for the thread's pre-router pin, and a thread with no pin gives it no plan target. An action that omits `effort` resolves no level. In both cases the worker session returns to what it opened on. [`docs/model-routing.md`](docs/model-routing.md) holds the full contract, including the known cases where the model or level that runs differs. Only models Slate ships a benchmark profile for can be routed to; entries pi cannot serve, or has no profile for, are dropped with a warning naming them.

What the code enforces is deliberately narrower than what the routing data advises. The dispatch guards refuse an unlisted model, a level off the target model's ladder and a level the provider rejects outright; they warn about — and mark — an unmeasured level, refusing it only when `router.allowUnmeasuredEffort` is `false`; and the context-window guard substitutes a wider listed model instead of ever blocking an action. The obligations that come from the profile data itself — keeping review and gate actions on measured levels, and honoring a REFUSE such as `anthropic/claude-fable-5`'s for zero-data-retention work — are stated in the doctrine for the orchestrator to honor; they are **not** code-enforced guards. Full semantics: the `router.*` rows in [Configuration](#configuration) and the shipped [`docs/model-routing.md`](docs/model-routing.md) — if they disagree, that document wins.

## Optional writing guidance

Set `writing.check` to `true` to add writing guidance and human-only telemetry. In orchestrator mode, Slate adds a doctrine rule that states the convention. It also adds a status value such as `writing 1/4`. This value means that one of four measured prose turns had a fail-level finding. Each worker gets a shorter preamble reminder about sentence length, semicolons, and contractions.

The option has prompt cost. Each orchestrator system prompt contains the doctrine rule. You pay for this text on every turn. Each worker session also gets a gated preamble addition. Both additions are absent when the option is off. The worker preamble then stays byte-identical to its pre-feature form.

> **No conformance claim:** This is a dictionary-free proxy. It embeds no controlled vocabulary and claims no ASD-STE100 conformance.

The shipped CLI checks plain files, JSONL records, and unified diffs. See [`docs/writing-guidance.md`](docs/writing-guidance.md) for its rules, limits, output, and command examples.

Set `writing.remind` to `true` to add context-paced reminders after eligible tool results. Context-paced means Slate waits for configured context growth between reminders. The reminders are hidden from the normal TUI. They repeat five writing requirements and the scope exclusion before the next assistant response. This option remains off unless `writing.check` is also `true`.

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
| `episodeModel` | string | newest available Anthropic Sonnet, else the orchestrator's own base model | Model (`provider/id`) used to compress a finished action into an episode. Never the model an action was routed to: an episode is read by every later consumer of the thread, so one cheap route must not degrade the record. An unusable value is reported and the default is used. |
| `workerTools` | string[] | `["read", "bash", "edit", "write", "grep", "find", "ls"]` | Tools available to worker threads (an empty list also falls back to the default). |
| `workerExtensions` | string[] | `[]` | Regex patterns (matched **unanchored**) selecting which of the host session's already-loaded extensions also load into every worker thread; each matched extension's tools are added **on top of** `workerTools`. Empty (default) means workers load no extensions. The orchestrator keeps its restricted tool set but its doctrine is told what was whitelisted. Invalid patterns are dropped with a warning at session start. |
| `maxConcurrent` | number | `4` | Maximum number of worker actions running concurrently (must be ≥ 1 — unenforced: a value of 0 or less silently hangs all dispatches). Excess dispatches wait in a queue; actions on the same thread always run in dispatch order. Default rationale: shipped `docs/design-principles.md` §5 (repo-local note). |
| `contextBudget` | number \| object | `256000` (Anthropic models: `400000`) | Absolute orchestrator context budget (tokens) at which Slate auto-pauses and prepares a fresh-session handoff — semantics, defaults, per-model overrides, and rationale in [`docs/context-budget.md`](docs/context-budget.md). |
| `orchestratorPromptDocs` | string[] | `[]` | Project markdown files (paths relative to the project root) whose **contents** are appended to the orchestrator system prompt. |
| `workerPromptDocs` | string[] | `[]` | Project markdown files whose **contents** are appended to every worker-thread system prompt. |
| `workflow.draftPRs` | boolean | `false` | Enable umbrella draft-PR publishing for tracks. |
| `writing.check` | boolean | `false` | Add the writing doctrine rule, per-turn status, and worker guidance. An absent option is silently off. A malformed `writing` value, or a non-boolean `check` value, warns and defaults to off. Unknown `writing` keys warn and are ignored. See [`docs/writing-guidance.md`](docs/writing-guidance.md). |
| `writing.remind` | boolean | `false` | Send a hidden reminder after an eligible tool result. All gates must pass: orchestrator mode, project trust, `writing.check`, this option, no pause, cadence or handoff force, and one-per-round control. See [`docs/writing-guidance.md`](docs/writing-guidance.md). |
| `writing.remindPercent` | number | `10` | Set cadence as a percentage of Slate's current effective context budget. The value must be finite and in `(0, 100]`. The interval has an 8,192-token floor and no cap. A handoff force bypasses this threshold. See [`docs/writing-guidance.md`](docs/writing-guidance.md). |
| `doctrineExtraPath` | string | — | Project markdown whose **content** is appended to the orchestrator doctrine (project-specific workflow additions). |
| `reviewPerspectivesPath` | string | — | Project review charters, each declaring its own finding-ID prefix. The doctrine references this **path**; the orchestrator reads the file alongside the shipped review rules. |
| `modelFailover` | object (string → string) | — (empty, failover off) | Map of `provider/id` → equal-quality alternative model; on a model API failure the affected site retries once on the mapped model (worker/orchestrator sites only after pi's own retries are exhausted; episode compression has no pi retry loop). Read once at session start — see [`docs/model-failover.md`](docs/model-failover.md). |
| `preserveGlobalModelDefault` | boolean | `true` | Put pi's global model defaults (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`) back after a Slate-initiated model switch — orchestrator failover and handoff adoption — so the switch stays session-scoped. `false` turns that restore off at both sites (the switches themselves are unaffected), leaving each one persisted in pi's global settings. Best-effort: Slate reverts only a value its own switch produced, and can stand down or give up — limits in [`docs/model-failover.md`](docs/model-failover.md). |
| `router.models` | string[] | `[]` (empty — routing off) | Closed list of models (`provider/id`) an action may use. Empty or absent means the router is OFF. Slate enforces no candidate list, seeds no thread base, derives no effort level, and runs no router-only window, billing, or substitution path. Per-action `model` and `effort` arguments stay active on both router states. Slate still checks explicit effort against pi's vocabulary and the routed model's ladder when it has that model's profile data. An action that omits `model` plans for the thread's pre-router pin, and a thread with no pin gives it no plan target. An action that omits `effort` resolves no level. In both cases the worker session returns to what it opened on. The known cases where the model or level that runs differs are listed in [`docs/model-routing.md`](docs/model-routing.md). A listed model becomes routable only if Slate has its benchmark profile, pi registers it, and credentials are configured. Slate drops other entries with a warning. If all entries drop, routing turns off with one summary warning. Slate reads and resolves the list once per session. See [`docs/model-routing.md`](docs/model-routing.md). |
| `router.allowUnmeasuredEffort` | boolean | `true` | What happens when an explicitly requested effort level is on the target model's ladder but has no capability measurement in Slate's profiles: `true` dispatches it with a ⚠ notice and marks the episode `(unmeasured level)`; `false` refuses the dispatch. Either way a level that is off the model's ladder, or one the provider rejects outright, is refused, and a level Slate DERIVES for an action is always a measured one. |

Example `.pi/slate.json` (the `docs/agents/...` paths are placeholders — point them at markdown files that actually exist in **your** project):

```json
{
  "orchestratorModeDefault": true,
  "episodeModel": "anthropic/claude-sonnet-5",
  "maxConcurrent": 4,
  "orchestratorPromptDocs": ["docs/agents/orchestrator-guidelines.md"],
  "workerPromptDocs": ["docs/agents/thread-guidelines.md"],
  "workflow": { "draftPRs": true },
  "writing": {
    "check": true,
    "remind": false,
    "remindPercent": 10
  },
  "doctrineExtraPath": "docs/agents/workflow-additions.md",
  "reviewPerspectivesPath": "docs/agents/review-perspectives.md",
  "modelFailover": { "anthropic/claude-sonnet-5": "openai/gpt-5.2" },
  "router": { "models": ["openai/gpt-5.6-luna", "anthropic/claude-opus-5"] }
}
```

Older Slate releases warn about these reminder keys and ignore them. Use a Slate release whose documentation includes these keys.

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
- **Credential and filesystem reach.** Inside a worker the extension has the same filesystem and credential access it has in the host; Slate's read-only settings snapshot blocks pi-settings writes and nothing else.
- **Unsynced model-scoped tools.** Worker sessions never fire the session-start event, so an extension whose tool set is model-scoped stays unsynced and may offer a tool the worker's model cannot serve (e.g. pi-web-search's `url_context` on a non-Google worker model) — the call simply fails and the episode records it.
- **Abort.** A third-party extension may ignore the abort signal, so its network activity can outlive an abort or a context-budget pause.
- **Cost.** Provider-native tool billing can escape Slate's worker cost accounting.
- **Pathological patterns.** The patterns are regexes from your own trusted config — the same file that already steers models, prompts, and tool lists — matched with no time bound while the extension set is resolved once per session. A pattern with catastrophic backtracking can stall that resolution; treat it as a footgun to avoid, not a privilege boundary.

The load-time recursion guard behind this — and the risks it does and does not cover — is in [`docs/design-principles.md`](docs/design-principles.md).

## Trust

Slate reads project configuration (`.pi/slate.json`) and injects project files (`orchestratorPromptDocs`, `workerPromptDocs`, `doctrineExtraPath`, `reviewPerspectivesPath`) **only in trusted projects**. In untrusted projects Slate runs with built-in defaults and injects nothing from the working tree.

## Shipped docs

In orchestrator mode, Slate appends a short **doctrine** (a block of numbered rules) to the orchestrator's system prompt each turn. The doctrine does not embed the workflow docs — it cites them by **absolute path**, resolved inside the installed package (not your project), and the orchestrator reads them on demand. Those embedded paths are also why the block's character count depends on your install location; [`docs/context-budget.md`](docs/context-budget.md) has the measured sizes, with and without the optional rules, and the arithmetic for your own install:

- `docs/track-workflow.md` — the track-based workflow (research → design review → adversarial review → track review)
- `docs/pr-publishing.md` — umbrella draft-PR publishing (cited only when `workflow.draftPRs` is `true`)
- `docs/review-rules.md` — review discipline and finding rules
- `docs/design-principles.md` — Slate's own design rationale
- `docs/model-failover.md` — the opt-in `modelFailover` map (**reference documentation** — unlike the entries above it is not workflow doctrine and is not cited by the doctrine)
- `docs/context-budget.md` — the orchestrator `contextBudget`: defaults, per-model overrides, the window clamp, and the pricing rationale (also **reference documentation**, not cited by the doctrine)
- `docs/writing-guidance.md` — the optional writing convention, `writing.check` behavior, status line, and checker CLI
- `docs/model-routing.md` — action-level model routing: the two `router` keys, how a model becomes routable, how an omitted effort level resolves, the dispatch guards, and the warnings a first routed session emits. Unlike the two entries above it **is** cited by the doctrine, by absolute path, but only while the routing rule renders — it is the extra embedded path that appears with the rule, the fourth normally and the fifth when `workflow.draftPRs` is also on, which the size arithmetic in `docs/context-budget.md` accounts for. The routable model list itself is never read from this file: the rule renders it live from the session's own resolution, because that set depends on your registry and credentials.

Project-specific additions layer on top — they extend, not replace, the shipped doctrine — via two distinct mechanisms:

- **Content injection**: `doctrineExtraPath` (appended to the doctrine itself, re-read at each prompt assembly) and `orchestratorPromptDocs` / `workerPromptDocs` (appended to the respective system prompts).
- **Pointer**: `reviewPerspectivesPath` is cited by path from the doctrine's review rule and read on demand, like the shipped docs.

## License

Apache-2.0 — see [LICENSE](LICENSE).
