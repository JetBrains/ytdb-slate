# ytdb-slate

Slate is a thread-weaving orchestration extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

The orchestrator (your main pi session) dispatches **bounded actions** to persistent **worker threads**. Each completed action is compressed by an LLM into an **episode** — a durable, structured record (intent, actions, findings, artifacts, open issues, handoff notes) that the orchestrator composes into further dispatches instead of re-reading raw transcripts. On top of that, Slate injects a mandatory workflow doctrine: research before design, design review, adversarial review, and track review — with optional umbrella **draft-PR publishing** for tracks.

## Why Slate?

Long-horizon agentic work fails on context management, not model capability. Existing architectures each solve a piece of the problem and trade away the rest: compaction is unpredictably lossy; naive subagents isolate context but hand back only a single response string; markdown plans go stale and get under-executed; rigid task trees can't adapt to information discovered mid-task; and planner/executor stacks synchronize through compress-and-return boundaries that risk dropping critical state.

Slate's answer is the **thread**: the orchestrator dispatches one bounded action at a time; the worker executes it and returns an **episode**. The orchestrator keeps the reactivity of a plain agent loop while gaining the context isolation, compaction, and parallelism that the single-context loop lacks.

| Aspect | ReAct | Markdown plan | Task trees | RLM (Recursive Language Models) | Devin / Manus / Altera | Claude Code / Codex subagents | Slate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Planning | implicit | file | explicit tree | REPL | planning agent | plan mode | implicit / adaptive — no upfront static plan |
| Decomposition | none | none | direct tree | REPL functions | task-based | subagent delegation | implicit |
| Synchronization | single thread | single thread | gated steps | REPL return | reduce & return | message passing | episodes |
| Intermediate feedback | per step | per step | on task failure | on execution end | after compress | message passing | per episode |
| Context isolation | n/a | n/a | per subtask | per subcall | subagent | subagent | per thread |
| Context compaction | n/a | n/a | task-based | REPL slicing | subagent compress | compaction | episode compress |
| Parallel execution | n/a | n/a | n/a | in REPL | Altera only | native | native |
| Expressivity | high | high | low | high | medium | medium | high |
| Adaptability | yes | if plan updated | no | yes | yes | limited by message passing | yes |

Characterizations of third-party systems reflect their publicly described designs at the time of writing. The taxonomy is adapted from the Random Labs technical report introducing the thread-weaving "Slate" architecture (published as the npm package `@randomlabs/slate`); ytdb-slate is an independent implementation of that architecture for pi.

**Threads are not subagents:**

- **Per-episode feedback.** Each thread executes one bounded action and hands control back. The orchestrator adapts after every episode — reactive like a ReAct loop — instead of firing off a subagent and hoping the result comes back usable.
- **Compaction at a chosen boundary.** Compression happens at a predictable point — action completion — instead of mid-stream when context overflows. The compression itself is still LLM-performed and lossy, but the boundary is chosen, not forced.
- **Episodes compose.** One thread's episode can seed another thread's context, so conclusions travel across the system by reference. Subagents pass back a single response string; episodes are durable, structured, reusable records.

Full rationale: [`docs/design-principles.md`](docs/design-principles.md) (shipped in the package) is the authoritative source for this comparison.

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
| `episodeModel` | string | newest available Anthropic Sonnet, else the worker's own model | Model (`provider/id`) used to compress a finished action into an episode. |
| `workerTools` | string[] | `["read", "bash", "edit", "write", "grep", "find", "ls"]` | Tools available to worker threads (an empty list also falls back to the default). |
| `maxConcurrent` | number | `4` | Maximum number of worker actions running concurrently (must be ≥ 1 — unenforced: a value of 0 or less silently hangs all dispatches). Excess dispatches wait in a queue; actions on the same thread always run in dispatch order. Default rationale: shipped `docs/design-principles.md` §5 (repo-local note). |
| `pauseThresholdPercent` | number | `40` | Orchestrator context budget (percent, in `(0, 100]`) at which Slate auto-pauses and prepares a fresh-session handoff. |
| `orchestratorPromptDocs` | string[] | `[]` | Project markdown files (paths relative to the project root) whose **contents** are appended to the orchestrator system prompt. |
| `workerPromptDocs` | string[] | `[]` | Project markdown files whose **contents** are appended to every worker-thread system prompt. |
| `workflow.draftPRs` | boolean | `false` | Enable umbrella draft-PR publishing for tracks. |
| `doctrineExtraPath` | string | — | Project markdown whose **content** is appended to the orchestrator doctrine (project-specific workflow additions). |
| `reviewPerspectivesPath` | string | — | Project review charters, each declaring its own finding-ID prefix. The doctrine references this **path**; the orchestrator reads the file alongside the shipped review rules. |

Example `.pi/slate.json` (the `docs/agents/...` paths are placeholders — point them at markdown files that actually exist in **your** project):

```json
{
  "orchestratorModeDefault": true,
  "episodeModel": "anthropic/claude-sonnet-5",
  "maxConcurrent": 4,
  "pauseThresholdPercent": 40,
  "orchestratorPromptDocs": ["docs/agents/orchestrator-guidelines.md"],
  "workerPromptDocs": ["docs/agents/thread-guidelines.md"],
  "workflow": { "draftPRs": true },
  "doctrineExtraPath": "docs/agents/workflow-additions.md",
  "reviewPerspectivesPath": "docs/agents/review-perspectives.md"
}
```

> **Silent skip:** the project-file keys fail silently — no error is shown. For the content-injected keys (`orchestratorPromptDocs`, `workerPromptDocs`, `doctrineExtraPath`) a missing, unreadable, or empty file is skipped and nothing is injected. For `reviewPerspectivesPath` the pointer is omitted only when the file is missing — the file is not read at injection time, so an unreadable or empty file is still cited. Verify your paths after copying the example.

## Trust

Slate reads project configuration (`.pi/slate.json`) and injects project files (`orchestratorPromptDocs`, `workerPromptDocs`, `doctrineExtraPath`, `reviewPerspectivesPath`) **only in trusted projects**. In untrusted projects Slate runs with built-in defaults and injects nothing from the working tree.

## Feature development workflow

In orchestrator mode, Slate injects a track-based development workflow as doctrine — it is not optional; project configuration can *extend* it (`doctrineExtraPath`) but never replace it. The flow:

1. **Research** — interactive exploration; a research log opens lazily when decisions accumulate.
2. **User design review** — the user approves the design direction before any machine review.
3. **Adversarial review** — a fresh-context reviewer attacks the design pre-implementation; findings are triaged with the user.
4. **Track split approval** — the user approves how the change splits into independently reviewable tracks.
5. **Per-track loop** — implement → agent code review → fixes → mandatory user review → marker commit.
6. **Delivery** — with draft-PR publishing enabled, the squash-merge is performed by the user; the agent never merges.

The workflow scales with change size: multi-track changes get the full flow, single-track changes skip the split and the marker commits, and trivial changes collapse the reviews into a short consent-plus-micro-review. Umbrella draft-PR publishing activates only when `workflow.draftPRs` is `true`.

This summary is orientation only — the shipped docs listed below are the source of truth, and if this summary ever disagrees with them, the docs win.

## Shipped docs

In orchestrator mode, Slate appends a short **doctrine** (a block of numbered rules) to the orchestrator's system prompt each turn. The doctrine does not embed the workflow docs — it cites them by **absolute path**, resolved inside the installed package (not your project), and the orchestrator reads them on demand:

- `docs/track-workflow.md` — the track-based workflow (research → design review → adversarial review → track review)
- `docs/pr-publishing.md` — umbrella draft-PR publishing (cited only when `workflow.draftPRs` is `true`)
- `docs/review-rules.md` — review discipline and finding rules
- `docs/design-principles.md` — Slate's own design rationale

Project-specific additions layer on top — they extend, not replace, the shipped doctrine — via two distinct mechanisms:

- **Content injection**: `doctrineExtraPath` (appended to the doctrine itself, re-read at each prompt assembly) and `orchestratorPromptDocs` / `workerPromptDocs` (appended to the respective system prompts).
- **Pointer**: `reviewPerspectivesPath` is cited by path from the doctrine's review rule and read on demand, like the shipped docs.

## License

Apache-2.0 — see [LICENSE](LICENSE).
