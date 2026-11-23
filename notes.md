# ytdb-slate 0.20.0

Slate now uses one default context budget for every provider. This release also reduces the context that the thread list uses.

## Highlights

- The default `contextBudget` is now 400,000 tokens for every provider. This setting is the context size at which Slate pauses for a handoff. A handoff transfers the work to a new session. The earlier default was 256,000 tokens for every provider except Anthropic. Slate still lowers the value for a model with a smaller context window.
- The `threads` tool now returns totals for all worker threads and at most eight threads, newest first. A worker thread is a separate session that performs one action. The result stays within 4,096 bytes. The orchestrator is the main session that plans the work. It requests older threads with `before` and routing details with `detail: true`.
- The `episode` tool returns the stored record of one worker action. For an unknown ID it now returns a short error. It no longer lists every known ID.
- After a handoff, the default first message no longer tells the orchestrator to call `threads` or `episode`. A custom `.pi/slate-handoff.md` template is unchanged.
- The routing instructions for the orchestrator carry new cautions. For Sol models, a review task should require a reproduced run for each major claim about runtime behavior. For `luna-6`, a task that stages supplied text should require a read-back against the task text. The model list and the ratings are unchanged.

## Fixes

- With `notifications.native` enabled on Windows, Slate now finds the system Windows PowerShell application when its Start menu entry has a different name.

## Breaking changes

1. **Pi 1.6.0 is the minimum supported version.** Action: Upgrade pi before updating Slate if you use an older version. Older versions can load Slate without a warning.

## Compatibility

No configuration keys changed. With a provider other than Anthropic, Slate can now pause for a handoff later than before. The context can then pass a provider price boundary for long context. To pause earlier, set `contextBudget` or add a `contextBudget.overrides` entry for the model. `docs/context-budget.md` explains the calculation.

## SDK compatibility

Slate was tested with the pi software development kit (SDK) at version 1.6.0.
