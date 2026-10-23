# ytdb-slate 0.15.0

This release adds JavaScript tool calls to workers and reduces routine workflow output. It also gives concurrent actions separate temporary folders. Read the compatibility changes before upgrading from 0.14.0.

## Highlights

- **JavaScript tool calls in workers.** Codemode is a pi tool that runs JavaScript that calls other tools. Slate now supplies codemode to each worker alongside its normal tools. Workers can group independent calls in one script. Scripts use pi's shared queue. Slate blocks calls to inactive tools, nested codemode calls, and Slate's orchestration tools.

  Slate waits for admitted nested tool calls before completing an action. Worker summaries include a bounded list of nested tool outcomes, with failures first. If codemode cannot load, the worker continues without it and reports a warning.

- **Separate temporary folders for actions.** Each worker action in an open change gets its own temporary folder. Slate prevents the change from closing while an action still owns a folder. After successful worker shutdown, Slate removes only the exact empty action folder. It keeps nonempty folders and reports their paths. It never recursively deletes worker files.

- **Fewer routine questions and shorter output.** The orchestrator is the assistant that directs the work. It now judges risk assessments and routine review results without asking for separate approval of each judgment. You can inspect those assessments and direct changes. Slate presents a plan or design in full once, then shows only changes. Required design approvals and final acceptance remain explicit user decisions.

  Tool progress displays and completion messages are shorter. Relevant failures, risks, and required decisions remain visible. You can expand tool displays for more detail. The status line shows total cost without the cost-source breakdown.

- **Fresh sessions between tracks.** A track is one bounded part of a change. For changes with several tracks, Slate requires a handoff before each track. A handoff moves work to a fresh main session. The new session checks the saved plan before work starts. Every code track in such a change now requires explicit user acceptance before work continues.

- **Pull request descriptions follow project templates.** Slate no longer adds its own progress tables or delivery accounting to descriptions. It uses the project's pull request template. Without a project template, it uses short “Why” and “What changed” sections. Detailed workflow records remain in research logs.

## Fixes

- Invalid `maxConcurrent` values now produce a warning and use the default. Zero and negative values no longer leave all worker actions waiting indefinitely.
- Worker tool selections that use only modifiers such as `+read` or `-bash` now keep added tools in the correct selection form.
- Concurrent worker loading preserves the component identity required by codemode.
- Slate protects displayed external text from terminal control sequences. Stored records and underlying tool results remain unchanged.

## Breaking changes

1. **The tested pi integration moves to pi 1.4.0.** Slate now uses that version's shared script queue. Action: Upgrade to pi 1.4.0 before using this release. Do not treat the unrestricted peer dependency range as evidence that an older host works.

2. **Worker tool lists do not disable Slate's codemode tool.** Entries named `codemode`, `+codemode`, or `-codemode` cannot control it. Slate also withholds any selected worker extension that registers a tool named `codemode`. Action: Review custom worker tool policies. Resolve any extension name conflict before relying on that extension's tools.

3. **The default action concurrency increases from 4 to 8.** This can increase simultaneous model requests and tool work. Action: Set `"maxConcurrent": 4` in `slate.json` if you need the previous default limit.

## Compatibility

No `slate.json` key is added, removed, or renamed.

The startup workflow summary is now off when no preference exists. Existing explicit preferences keep their meaning. Run `/slate summary on` to enable automatic display at the next interactive startup or mode activation. Run `/slate summary` to show it immediately.

`maxConcurrent` accepts only whole numbers from 1 through `Number.MAX_SAFE_INTEGER`. Slate does not convert strings or round fractions. Invalid values warn and use 8.

Slate derives pi's `PI_CODEMODE_MAX_WORKERS` environment variable from `maxConcurrent` unless an external value exists. The variable limits script workers across the process. Child pi processes inherit the value but use separate pools. Set the variable explicitly when you need a different script-worker limit.

A tool that ignores cancellation can still keep an action open. Codemode does not provide a filesystem sandbox or undo completed tool effects.

Notification defaults, model-routing settings, the default compressor, and context-budget defaults remain unchanged. When `workflow.routingRecommendations` is enabled, Slate shows advice only when the current change's records support it.

An existing change keeps its recorded workflow unless you explicitly approve migration. Slate does not rename, rewrite, or delete saved change records for this upgrade.

Start a new pi session after changing `slate.json`.

## SDK compatibility

The pi software development kit (SDK) development pins change from 1.2.0 to 1.4.0 for `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`. The TypeBox pin remains 1.3.27.

The tested combination is pi 1.4.0 with TypeBox 1.3.27. Tests exercise the host script queue, real worker scripts, and concurrent worker loading. A successful continuous integration run covers the current release candidate with this pin.

The SDK peer dependency ranges remain `*`. These ranges do not establish compatibility with every pi version. The available tests do not establish the lowest working pi version.
