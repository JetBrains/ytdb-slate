# Configuration

## Configuration files and merging

Slate reads two optional configuration files at session start:

- Home: `<getAgentDir()>/slate.json`, normally `~/.pi/agent/slate.json`. Pi's `PI_CODING_AGENT_DIR` environment variable can select another agent directory.
- Project: `<cwd>/.pi/slate.json`, read **only when the project is trusted**.

Project values override home values. Objects merge recursively. Arrays, scalar values, and explicit `null` replace the home value. Arrays never append. Slate applies its existing setting validators after the merge.

A missing file is valid. An unreadable file, invalid JSON, or a root that is not an object produces a warning naming that file. Any such error in a permitted file blocks model routing, even when the other file is valid.

Home preferences also apply in untrusted projects. Without a home file, existing project behavior and defaults stay unchanged. Configuration edits require a new session.

Paths in `orchestratorPromptDocs`, `workerPromptDocs`, `doctrineExtraPath`, and `reviewPerspectivesPath` belong to the file that supplies the value. Relative home paths start at the agent directory. Relative project paths start at the project root, not `.pi`. Absolute paths stay absolute. See [Safety and trust](safety-and-trust.md) for the security boundary.

Pi can refresh a prompt cache by sending background requests. Slate disables those requests in every worker because they bypass its request limits. This does not disable prompt caching for ordinary worker requests. The main session and saved pi settings stay unchanged.

## Common starting point

Create `.pi/slate.json` when you want new interactive sessions to start in orchestrator mode:

```json
{
  "orchestratorModeDefault": true
}
```

The project must be trusted before Slate reads this file. Start a new session after any configuration change.

## Complete option reference

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
| `contextBudget` | number \| object | `256000` (Anthropic models: `400000`) | Absolute orchestrator context budget (tokens) at which Slate auto-pauses and prepares a fresh-session handoff — semantics, defaults, per-model overrides, and rationale in [`docs/context-budget.md`](context-budget.md). |
| `orchestratorPromptDocs` | string[] | `[]` | Markdown files whose paths follow the source rules above and whose **contents** are appended to the orchestrator system prompt. |
| `workerPromptDocs` | string[] | `[]` | Markdown files whose **contents** are appended to every worker-thread system prompt. |
| `workflow.draftPRs` | boolean | `false` | Enable one umbrella draft pull request for the whole change before implementation. |
| `workflow.followUpIssues` | boolean | `false` | When true, the orchestrator asks which deferred items become tracked issues. Deferred items are always reported whatever the value. |
| `workflow.routingRecommendations` | boolean | `false` | Before final acceptance, add an evidence-bounded model-routing field for logical models dispatched during the current change. The enabled field always appears. It reports when no change is recommended and never edits routing files. |
| `writing.check` | boolean | ignored | This ignored writing key remains accepted for compatibility. Remove it from `slate.json`. Guidance is automatic during orchestrator mode when the project is trusted or a home file exists. See [`docs/writing-guidance.md`](writing-guidance.md). |
| `writing.remind` | boolean | ignored | This ignored writing key remains accepted for compatibility. Remove it from `slate.json`. Reminder gates require orchestrator mode, permitted Slate settings, no pause, and a ready trigger. Delivery is limited to one reminder per response round. See [`docs/writing-guidance.md`](writing-guidance.md). |
| `writing.remindPercent` | number | ignored | This retired key remains accepted and ignored. Slate emits a notice. Replace it with `writing.remindTurns`, which counts completed turns instead of a token-budget share. |
| `writing.remindTurns` | number | `4` | Set the reminder cadence in completed turns. The value must be a whole number from 1 through 20. An invalid value warns and falls back to `4`. See [`docs/writing-guidance.md`](writing-guidance.md). |
| `writing.remindOnFinding` | boolean | `true` | Send a reminder on the turn after a measured turn with a model-visible finding. An invalid value warns and falls back to `true`. `writing.findings: false` disables this trigger. |
| `writing.sentenceWordLimit` | number \| boolean | `25` | Set the sentence-length house-style limit in words. The value must be a whole number from 10 through 200, inclusive, or `false` to turn the rule off. See [`docs/writing-guidance.md`](writing-guidance.md). |
| `writing.statusWindowTurns` | number | `10` | Set the whole-number status window from 3 through 100 measured turns. An invalid value warns and falls back to `10`. The status line reports model-visible fail and style counts in this window. |
| `writing.findings` | boolean | `true` | Include the latest model-visible writing findings in the hidden reminder. An invalid value warns and falls back to `true`. Measurement and the status line continue when this value is `false`. |
| `doctrineExtraPath` | string | — | Markdown whose **content** is appended to the orchestrator doctrine (project-specific workflow additions). |
| `reviewPerspectivesPath` | string | — | Review charters, each declaring its own finding-ID prefix. The doctrine references this **path**; the orchestrator reads the file alongside the shipped review rules. |
| `router.models` | object | shipped six-model pool | Ordinary membership and definitions. `include` replaces the starting membership, including with an empty list. `add` accepts complete new definitions. `replace` changes selected fields. `exclude` applies last. Within each model definition, lists and provider maps replace shipped fields. The home and project configuration files merge first. |
| `router.compressor.models` | array of `{ model, effort }` | `[{"model":"claude-sonnet-5","effort":"medium"}]` | Independent ordered compressor list. An explicit empty list blocks work. |

## Extended example

The `docs/agents/...` values below are placeholders. Point them at Markdown files that exist in your project.

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
    "models": { "include": ["luna-6", "claude-opus-5.5"] },
    "compressor": { "models": [{ "model": "claude-sonnet-5", "effort": "medium" }] }
  }
}
```

Remove `writing.check` and `writing.remind` when copying an older configuration. Current Slate reports these ignored writing keys.

## Document path warning

> **Silent skip:** document-path errors produce no warning. Slate skips missing, unreadable, or empty files selected by `orchestratorPromptDocs`, `workerPromptDocs`, and `doctrineExtraPath`. For `reviewPerspectivesPath`, Slate omits the pointer only when the file is missing. Slate does not read that file at injection time, so an unreadable or empty file is still cited. Verify your paths after copying the example.
