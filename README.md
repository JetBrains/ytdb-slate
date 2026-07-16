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
| `workerTools` | string[] | pi's default toolset | Tools available to worker threads. |
| `maxConcurrent` | number | `4` | Maximum number of worker actions running concurrently. |
| `pauseThresholdPercent` | number | `40` | Orchestrator context budget (percent, in `(0, 100]`) at which Slate auto-pauses and prepares a fresh-session handoff. |
| `orchestratorPromptDocs` | string[] | `[]` | Project markdown files (paths relative to the project root) injected into the orchestrator prompt. |
| `workerPromptDocs` | string[] | `[]` | Project markdown files injected into every worker-thread prompt. |
| `workflow.draftPRs` | boolean | `false` | Enable umbrella draft-PR publishing for tracks. |
| `doctrineExtraPath` | string | — | Project markdown appended to the orchestrator doctrine (e.g. a satellite peer-review process). |
| `reviewPerspectivesPath` | string | — | Project review charters; each charter declares its own finding-ID prefix. |

Example `.pi/slate.json`:

```json
{
  "orchestratorModeDefault": true,
  "episodeModel": "anthropic/claude-sonnet-5",
  "maxConcurrent": 4,
  "pauseThresholdPercent": 40,
  "orchestratorPromptDocs": ["docs-internal/agents/orchestrator-guidelines.md"],
  "workerPromptDocs": ["docs-internal/agents/thread-guidelines.md"],
  "workflow": { "draftPRs": true },
  "doctrineExtraPath": "docs-internal/agents/peer-review.md",
  "reviewPerspectivesPath": "docs-internal/agents/review-perspectives.md"
}
```

## Trust

Slate reads project configuration (`.pi/slate.json`) and injects project files (`orchestratorPromptDocs`, `workerPromptDocs`, `doctrineExtraPath`, `reviewPerspectivesPath`) **only in trusted projects**. In untrusted projects Slate runs with built-in defaults and injects nothing from the working tree.

## Shipped docs

The package ships its workflow doctrine as markdown, resolved at runtime from the installed package (not from your project) and injected into orchestrator prompts by the doctrine:

- `docs/track-workflow.md` — the track-based workflow (research → design review → adversarial review → track review)
- `docs/pr-publishing.md` — umbrella draft-PR publishing (active when `workflow.draftPRs` is `true`)
- `docs/review-rules.md` — review discipline and finding rules
- `docs/design-principles.md` — Slate's own design rationale

Project-specific additions layer on top via `doctrineExtraPath`, `reviewPerspectivesPath`, and the prompt-doc lists — they extend, not replace, the shipped doctrine.

## License

Apache-2.0 — see [LICENSE](LICENSE).
