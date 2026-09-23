# ytdb-slate 0.11.0

This release changes how Slate selects models, how it runs worker threads, and how the workflow decides which gates and reviews a change needs. Several configuration keys changed. Read the breaking changes before you upgrade.

## Highlights

- **Logical-model routing.** Slate uses logical models for routing now. A logical model is a name that does not depend on a provider. It has a fixed effort and a list of the exact provider models that it permits. Every `thread` call must name a logical `model` and give a short `reason`. One shared recovery policy covers dispatch, compression and failover. The shipped logical models are `luna-6`, `sol-6`, `gemini-3.8-flash`, `claude-sonnet-5`, `claude-opus-5.5` and `gpt-6-astra`. See `docs/model-routing.md`.
- **One action per thread.** Every `thread` call creates a new thread for one action. To continue earlier work, pass the earlier episode ids in `context`. An episode is the compressed record of one worker action.
- **Focus areas decide the workflow.** Eleven focus areas replace the size grades. A focus area is a type of risk, and the user must approve that a change has it. Only approved focus areas add design gates and reviewers. A track with no approved focus area gets no routine implementation review. A track is one part of a change that can be merged on its own.
- **Home preferences.** You can put an optional `slate.json` file in the pi agent directory. It also applies in untrusted projects. The values of a trusted project override it.
- **Request pacing for workers.** Slate limits OpenAI Responses requests from workers. The default limit is 12 requests per model in each rolling minute. Use the `requestThrottle.*` keys to change the limit. All worker requests share one cache key now.
- **Writing reminders count turns.** Writing reminders now come every `writing.remindTurns` completed turns. The default is 4. A reminder can also come at once when the writing checker finds a problem. Checker findings go into hidden reminders that the model can read.
- **Worker reminder for parallel tool calls.** A hidden reminder tells workers to make independent tool calls together. Compressed episodes do not include the reminder text.
- **Optional routing recommendations.** When `workflow.routingRecommendations` is `true`, Slate gives advice about model routing at the end of a change. The advice is based on evidence. The default is `false`. Slate never edits the routing configuration itself.
- **Workflow guidance.** The workflow prefers the simplest solution. It reuses facts and user answers that still apply. A change with more than one track stops for a user decision before each implementation phase. After two repair rounds fail on the same requirement, the workflow asks for a wider investigation and a new user approval. A new guideline keeps each track at about 400 changed lines, and this limit is not strict.

## Fixes

- Workers now receive the provider registrations of the main session. An extension that only adds a provider therefore works without an entry in `workerExtensions`.
- Worker extensions now run their startup code before an action and their shutdown code before the worker closes.
- When a cancellation happens first, Slate reports it as the main cause, even if startup fails later. Slate reports cleanup, save and progress failures separately.
- A handoff can now save project state before it finishes. A handoff moves the orchestrator to a new session when its context fills.
- Observation files keep up to 65,536 bytes of the final worker response. Before this fix, they kept only the last 8,000 characters.

## Breaking changes

1. **Routing configuration.** `router.models` uses the object form of logical models now. Slate ignores `modelFailover`, `episodeModel`, `router.allowUnmeasuredEffort` and `router.showWarnings`, shows a notice, and does not convert them. Configure the compression models in `router.compressor.models`.
2. **Removed logical model names.** Rename `gpt-5.6-luna` to `luna-6`, `gpt-5.6-sol` to `sol-6` and `claude-opus-5` to `claude-opus-5.5`. `gpt-5.6-terra` has no replacement. Slate provides no alias names. A reference to a removed name stops routing until you fix it.
3. **Thread calls.** The `freshContext` field and thread continuation are removed. Slate does not convert thread state that an older version saved.
4. **Ignored configuration keys.** Slate ignores `cacheKeyShards`, `writing.check`, `writing.remind` and `writing.remindPercent`. Remove them. Use `writing.remindTurns` in place of `writing.remindPercent`.
5. **Size grades are removed.** The size-grade command is removed. New work uses focus areas. Work that was approved under the earlier workflow can finish under the rules that it recorded.

## Compatibility

Slate 0.11.0 does not support Slate sessions that an earlier version started. To migrate, start a new Slate session. Then ask the orchestrator to import the work of the earlier session.

Restart the pi session after you change `slate.json`. An invalid home `slate.json` stops logical routing until you fix it.

## SDK compatibility

Slate 0.11.0 requires pi 0.87.1 or later. It was developed and tested against pi 0.87.1 and TypeBox 1.3.27. The pi software development kit (SDK) packages are still peer dependencies with the range `*`.
