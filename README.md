# ytdb-slate

Slate is a thread-weaving orchestration extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

The orchestrator (your main pi session) dispatches **bounded actions** to persistent **worker threads**. Each completed action is compressed by an LLM into an **episode** — a durable, structured record (intent, actions, findings, artifacts, open issues, handoff notes) that the orchestrator composes into further dispatches instead of re-reading raw transcripts. On top of that, Slate injects a mandatory workflow doctrine: research before design, design review, adversarial review, and track review — with optional umbrella **draft-PR publishing** for tracks.

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
| `maxConcurrent` | number | `4` | Maximum number of worker actions running concurrently. |
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
