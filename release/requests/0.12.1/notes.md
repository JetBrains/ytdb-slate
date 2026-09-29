# ytdb-slate 0.12.1

This release gives built-in reviewers design-quality questions for their focus areas. It also adds a record folder for each workflow change and a startup workflow summary. It changes where Slate stores runtime files and handoff state. Read the breaking changes below before you upgrade.

Version 0.12.0 was uploaded to npm, but it was never released as `latest`. Version 0.12.1 contains the same changes as 0.12.0. Install 0.12.1, not 0.12.0.

## Highlights

- **Reviewers judge design quality in their focus areas.** A focus area is a type of risk, for example concurrency, security or data loss. The user approves which focus areas a change has. Each built-in implementation reviewer covers one focus area. Reviewer I is a general reviewer, and the Test-quality and structure reviewer checks tests. Each built-in reviewer now receives design-quality questions for its own area. The questions ask whether the code structure serves the approved requirement simply, is easy to maintain and fits the surrounding system. For example, the Concurrency reviewer asks whether the coordination makes required safety and progress clear and enforceable. The orchestrator selects reviewers with the new `reviewPerspectives` field of the `thread` tool. Slate then gives each reviewer its instructions and questions automatically. Reviewers report a design problem only when they can show that it causes real harm, such as a bug, extra maintenance work or a broken caller. Reviewers do not report personal style preferences.
- **Change records and the `slate_change` tool.** A change is one unit of work that the workflow tracks from start to delivery. The orchestrator starts a change with `slate_change start` and ends it with `slate_change close`. Slate keeps the records of each change in its own `slate-changes/<change>/` folder. While a change is open, an implementer `thread` call must give the track number in `trackNumber`. A track is one part of a change that can be merged on its own.
- **One umbrella draft pull request.** When `workflow.draftPRs` is `true`, Slate publishes one draft pull request for the whole change. Slate no longer asks which publishing mode to use.
- **Startup workflow summary.** An interactive orchestrator session shows a short summary of the Slate workflow when it starts. The summary uses the colors of the active terminal theme. Use `/slate summary off` to hide it, `/slate summary on` to show it again, and `/slate summary` to switch between the two states. Slate saves the choice as `startupSummary` in `slate-preferences.json` in the pi agent directory.
- **Status line.** The status line is the line of Slate status text in the terminal. It now uses the colors of the active theme. Writing statistics are hidden by default. Set `writing.showStatus` to `true` in `slate.json` to show them. Writing measurement and writing reminders stay active when the statistics are hidden.
- **Size rules for design and review.** When the orchestrator estimates a track at more than 100 counted lines, the track needs a high-level design before implementation. When an implementer reports a track above 100 counted lines, the track gets Reviewer I. Documentation-only tracks do not get Reviewer I for size.

## Fixes

- A worker episode now reports a failure when a turn or a command fails after the worker starts. An episode is the compressed record of one worker action. Before this fix, such an episode could record an `ok` result.
- Orchestrator mode now blocks tools that another extension activates later. When orchestrator mode ends, Slate restores the tools that are allowed.
- After a handoff, the new session shows or hides the workflow summary in the same way as the earlier session. A handoff moves the orchestrator to a new session when its context fills.
- Episode compression now works with providers that an extension registers in the pi model registry.

## Breaking changes

1. **New runtime folder for each session start.** Slate writes new episodes, observations and worker transcripts to a separate folder for each session start, under `.pi/slate/<runtime folder>/`. Slate still reads files from the earlier flat folders but does not write to them. Action: Update any external tool that reads the earlier flat folders. Do not go back to an earlier Slate version with a session that holds the new records, because the earlier version can lose the saved references to them.
2. **New handoff storage.** Slate saves handoff state in an entry of the new session. Slate 0.12.1 does not use a pending handoff file that an earlier version saved. Action: Complete an unfinished handoff before you upgrade, or start a new handoff after you upgrade.
3. **Workflow records need an open change.** Workflow records move into `slate-changes/<change>/`. An implementer `thread` call in an open change must give `trackNumber`. Action: Use `slate_change start` before the first implementation action of a change. Use `slate_change close` after delivery or abandonment.
4. **Per-track draft pull requests are removed.** `workflow.draftPRs` keeps its name and its default value `false`. When it is `true`, Slate now creates one umbrella draft pull request for the change. Action: Finish work that depends on separate pull requests for each track before you upgrade, or change that work to one umbrella pull request.
5. **The thread widget is removed.** Slate no longer shows the thread widget. The paused state now appears in the status line. Action: Use `/slate` or the `threads` tool to inspect threads.
6. **Compression uses the pi model runtime only.** Episode compression no longer uses provider overrides that existed only for compatibility. It also no longer uses credentials that exist only as request headers, because the pi runtime rejects them. Action: Give each compression model credentials that the pi model runtime accepts.

## Compatibility

This release does not add, remove or rename any key in `slate.json`. It adds the optional key `writing.showStatus`, and the default is `false`. The new `startupSummary` preference is stored in `slate-preferences.json`, not in `slate.json`. It has no effect in `slate.json`.

Slate still ignores `cacheKeyShards`, `writing.check`, `writing.remind` and `writing.remindPercent`, as in 0.11.0. Remove them from your configuration. Use `writing.remindTurns` in place of `writing.remindPercent`.

Restart the pi session after you change `slate.json`.

## SDK compatibility

The pi software development kit (SDK) pins did not change in this release. Slate 0.12.1 was developed and tested against pi 0.87.1 and TypeBox 1.3.27. The SDK packages are still peer dependencies with the range `*`.
