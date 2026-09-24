# ytdb-slate: Agent orchestration for the pi coding agent

[![CI status](https://github.com/JetBrains/ytdb-slate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JetBrains/ytdb-slate/actions/workflows/ci.yml)

**Slate is a thread-weaving orchestration extension for the [pi coding agent](https://pi.dev).** It helps you guide long coding tasks while focused worker sessions research, implement, and review bounded parts of the work.

You stay in the main session and decide what to build. Slate manages context, delegates actions, preserves useful results, and applies a risk-based development workflow.

- [Start using Slate](#start-using-slate)
- [Understand how Slate works](#how-slate-works)
- [See the roadmap](#where-slate-is-going)
- [Configure Slate](#configuration)
- [Read the safety boundaries](#safety-and-trust)
- [Open the complete reference](#shipped-docs)

## Start using Slate

You need an installed and authenticated [pi coding agent](https://pi.dev/docs/latest/quickstart). From your project directory, install a pinned Slate version into the project:

```bash
pi install -l npm:ytdb-slate@<version>
```

The `-l` option records the package in `.pi/settings.json`. Pi may ask you to trust the project before it loads project settings and extensions.

Pinned package specifications such as `@<version>` are deliberately skipped by `pi update --extensions` and `pi update --all`. Moving the pin is a conscious project change. Review Slate's shipped workflow documents before you update it.

Start a new interactive pi session, then turn on orchestrator mode:

```text
/slate on
```

Try a request that gives Slate a clear outcome and leaves planning open:

```text
Add input validation to the account settings endpoint. First research the relevant code and tests. Show me the proposed tracks and risks before implementation.
```

Slate will ask for required decisions before it edits code. It will delegate implementation work to worker threads after the workflow gates allow that work.

To leave orchestrator mode, run `/slate off`. Running `/slate` with no argument toggles the mode. See [Everyday commands](#everyday-commands) for handoff, resume, and routing commands.

## How Slate works

Slate uses four terms throughout this README:

- **Main session:** the interactive pi session where you set goals, answer questions, and review results. In orchestrator mode, this session acts as the **orchestrator**.
- **Bounded action:** one focused unit of work with a clear limit and expected result.
- **Worker thread:** a new isolated pi session that performs one bounded action. A follow-up action uses another new worker thread.
- **Episode:** a durable, structured summary of one worker action. It retains intent, actions, findings, artifacts, open issues, and handoff notes.

The orchestrator dispatches bounded actions and adapts after each episode. A large language model compresses successful work and failed partial work into the episode. A failure without a worker response uses a fixed episode and no compression call.

Later actions can receive earlier episode identifiers through `context`. Slate loads those episodes into the new worker prompt. The main session can therefore compose prior results without re-reading every raw worker transcript.

### What Slate adds

- **Context isolation.** Each worker receives the context for one action instead of the full history of the main session.
- **Compaction at an action boundary.** Compression happens when the action ends. Compression remains model-performed and lossy, but the boundary is deliberate rather than forced by a full context window.
- **Adaptive planning.** Control returns to the orchestrator after each episode. New evidence can change the next action.
- **Composable results.** Episodes are durable records that later worker threads can use by reference.
- **Parallel work.** Independent bounded actions can run in parallel while each action keeps its own worker context.
- **Risk-based review.** User-approved risk proofs select workflow gates and agent reviewers instead of applying every review to every change.

Slate follows the thread-weaving architecture introduced by the Random Labs technical report for its `@randomlabs/slate` agent. ytdb-slate is an independent implementation of that architecture for pi.

The full rationale is in [`docs/design-principles.md`](docs/design-principles.md). If this summary and that document disagree, the document wins.

## Where Slate is going

> **Planned work:** The two priorities below describe future changes. They are not current Slate features.

Spend more time deciding what to build, and less time checking code or managing agents. We are working toward that goal with two priorities:

1. **Guide changes through design, not code.** Review the design without having to read the code yourself. We plan to add design documents at several levels, from system goals to component details, and keep them updated as work progresses. Agents will still review code quality and check that changes follow your approved design.
   Follow [#361](https://github.com/JetBrains/ytdb-slate/issues/361), [#402](https://github.com/JetBrains/ytdb-slate/issues/402), [#403](https://github.com/JetBrains/ytdb-slate/issues/403), and [#404](https://github.com/JetBrains/ytdb-slate/issues/404).

2. **Keep working while agents run.** Asynchronous threads will let the main session continue without waiting for each result. A redesigned terminal interface will make it easier to follow and control their work. Clear, accurate usage and cost reports will show where your resources go.
   Follow [#269](https://github.com/JetBrains/ytdb-slate/issues/269), [#296](https://github.com/JetBrains/ytdb-slate/issues/296), [#212](https://github.com/JetBrains/ytdb-slate/issues/212), and [#38](https://github.com/JetBrains/ytdb-slate/issues/38).

## Current workflow and behavior

### Feature development workflow

In orchestrator mode, Slate injects a mandatory track-based development workflow. Project configuration can extend it through `doctrineExtraPath`. Configuration cannot replace it.

Eleven focus areas name specific risks. They cover
concurrency defects, data loss, security weaknesses, performance degradation,
test-quality defects, unreadable user-facing prose, licensing exposure,
non-local logic defects, consumer contract breaks, governing-rule defects, and
unreported failures.

During planning, the orchestrator writes an independent risk record for the change and for every track. Each record has one line for every focus area. A `NAMED` line carries a four-part proof. User approval makes that area proved. User rejection makes it `SKIPPED`. Only proved areas add gates or routine implementation reviewers. A track with at least one proved area gets one general Reviewer I plus every required area specialist. A track with no proved area gets no routine implementation reviewer.

The workflow follows these steps:

1. **Plan and confirm.** The orchestrator proposes all eleven focus lines. The user alone approves or rejects each `NAMED` proof.
2. **Design.** A proved `DESIGN-TRIGGERING` area requires a high-level design. The user validates it before focus reconfirmation and one adversarial design review per proved `DESIGN-TRIGGERING` area. Final design approval follows.
3. **Implement tracks.** Each track is one coherent, independently mergeable unit with its own focus set. About 400 added plus removed lines is a planning guideline. The orchestrator estimates before splitting work. The implementer estimates during work and stops at a coherent boundary near the guideline. A small overrun may finish the nearest coherent unit and must include its reason. Lockfiles, migration files, and generated output do not count.
4. **Review and deliver.** When a track has a proved area, one Reviewer I and every required area specialist inspect it in separate review actions. A zero-area track reports routine implementation review as `NOT REQUIRED`. Tracks with a proved `DESIGN-TRIGGERING` area require blocking user acceptance. Other tracks do not. For multi-track changes, a marker follows required machine gates, the packet, and resolution of blocking user notes. Final change acceptance is always blocking.

Draft pull request publishing activates only when `workflow.draftPRs` is `true`. The orchestrator creates one umbrella draft pull request for the whole change. Only the user merges it.

This summary provides orientation only. The [shipped workflow documents](#shipped-docs) are normative.

### Logical-model routing and recovery

Every `thread` call names a provider-free logical `model` and a short `reason`. The active policy fixes effort, exact physical routes, capability and cost ratings, guidance, cautions, and bounded recovery order. Slate resolves one immutable policy when the parent session starts. Dispatch, compression, main-session recovery, doctrine, and `/slate effective` share it.

The shipped ordinary pool has six definitions. A trusted project can replace membership, add complete definitions, replace selected fields, and exclude members. The independent compressor list defaults to Sonnet at `medium`. Untrusted projects use home preferences over the shipped policy and consume no project router data. Critical errors block logical work. Legacy physical-router keys produce named warnings and receive no automatic migration.

Pi retries the active physical route first. Slate advances only after Pi reports known retry exhaustion. Recovery tries another permitted provider for the same logical model before it moves through the ordinary or compressor order. Unknown outcomes and cancellation stop recovery. One operation owns recovery. An overlapping operation receives a visible busy refusal. Slate does not queue or replay it.

Pi 0.85.1 model and effort switches are session-only unless persistence is requested. Slate retains its saved-default compatibility guard for explicit persistence and older behavior. Slate retains bounded completed worker output when compression fails or is cancelled. A failed episode write can prevent an episode. A failed final state save can leave episode bytes without a proved durable reference. Both failures remain visible.

A remembered later compressor starts later actions at that entry and does not move backward until preference reset. This is an accepted limitation. `extension/index.ts` is the supported package entry. Logical-runtime exports and retry-evidence exports are internal and unstable. Retry-evidence exports classify provider retry outcomes. [`docs/model-routing.md`](docs/model-routing.md) defines the complete contract.

### Writing guidance

Writing guidance and checker findings are active in orchestrator mode when the project is trusted or a home configuration file exists. Slate adds one doctrine rule for writing and another for design discipline. It also adds a status value such as `writing 2 fail, 3 style / 10 turns` in interactive sessions. The value reports model-visible findings in the latest ten measured prose turns. Each worker with permitted Slate settings gets guidance on reader understanding, semicolons and contractions. Worker guidance also says to describe only the current state in the README, docs, code comments and the project agent instruction file. Change records may describe removals.

The guidance has prompt cost. Each orchestrator system prompt contains both doctrine rules. You pay for this text on every turn. Each worker with permitted Slate settings also gets the preamble addition.

The shipped command checks plain files, JSON Lines records, and unified diffs. See [`docs/writing-guidance.md`](docs/writing-guidance.md) for its rules, limits, output, and command examples.

Slate sends hidden reminders after completed turns. The default cadence is four completed turns. A model-visible finding can trigger an immediate reminder when that option is enabled. The reminder carries the writing and conversation title, three retained style rules, ten writing requirements, and seven design requirements. A findings section appears only when the latest measured turn carries a model-visible finding. The ten writing requirements exclude research logs, worker task text and this project's agent instruction file. The separate current-state documentation rule covers the agent instruction file.

## Everyday commands

| Command | Current behavior |
| --- | --- |
| `/slate on` | Turn on orchestrator mode. Slate removes tactical tools from the main session and expects delegation through worker threads. |
| `/slate off` | Turn off orchestrator mode and restore the earlier tool set. |
| `/slate` | Toggle orchestrator mode. |
| `/slate effective` | Show the effective logical-model policy and remembered route selections. |
| `/slate handoff [focus]` | Prepare a new-session handoff, with an optional focus. |
| `/slate resume` | Clear a context-budget pause and accept user prompts again. |

## Community

Join the [Slate Zulip community](https://youtrackdb.zulipchat.com/#narrow/channel/634235-slate) to share what you are building, ask for help, or discuss the project.

## Configuration

Slate reads optional home configuration and trusted project configuration. [Configuration reference](docs/configuration.md) lists the merge rules, every option, examples, and document path warnings.

## Safety and trust

Slate limits which extensions workers can load and which project settings it reads. [Safety and trust](docs/safety-and-trust.md) explains worker extensions, provider registrations, and the project trust boundary.

## Shipped docs

This section is the complete reference document roster.

In orchestrator mode, Slate appends a short **doctrine**, which is a block of numbered rules, to the orchestrator system prompt each turn. The doctrine does not embed the workflow documents. It cites them by absolute path inside the installed package, and the orchestrator reads them when needed.

The embedded paths make the block size depend on your install location. [`docs/context-budget.md`](docs/context-budget.md) gives measured sizes with and without optional rules. It also gives the arithmetic for your own installation.

- [`docs/blast-radius.md`](docs/blast-radius.md) defines the eleven focus areas, proof requirements, track constraints, and review coverage.
- [`docs/context-budget.md`](docs/context-budget.md) defines `contextBudget` defaults, per-model overrides, the window clamp, and pricing rationale. It is reference documentation and is not cited by the doctrine.
- [`docs/configuration.md`](docs/configuration.md) defines configuration files, merge rules, options, examples, and document path warnings.
- [`docs/delivery-packages.md`](docs/delivery-packages.md) — the compact track and change package format, read only before package preparation
- [`docs/design-principles.md`](docs/design-principles.md) gives Slate's design rationale.
- [`docs/model-routing.md`](docs/model-routing.md) defines the logical-model policy, exact defaults, configuration, common recovery, history, and accepted limitations. The doctrine cites its absolute path for trusted sessions.
- [`docs/pr-publishing.md`](docs/pr-publishing.md) defines one umbrella draft pull request for the whole change. The doctrine cites it only when `workflow.draftPRs` is `true`.
- [`docs/review-rules.md`](docs/review-rules.md) defines reviewer composition, the combined test-quality role, evidence standards, findings, and fix gates.
- [`docs/safety-and-trust.md`](docs/safety-and-trust.md) defines worker extension and provider behavior, and the project trust boundary.
- [`docs/track-workflow.md`](docs/track-workflow.md) defines the focus-area lifecycle for research, design, implementation, review, and delivery.
- [`docs/user-notes.md`](docs/user-notes.md) defines how Slate records, classifies, and resolves user notes during development.
- [`docs/writing-guidance.md`](docs/writing-guidance.md) defines the writing convention, ignored writing keys, status line, and checker command.

Project-specific additions extend the shipped doctrine. They do not replace it:

- **Content injection:** `doctrineExtraPath` appends content to the doctrine and is read again at each prompt assembly. `orchestratorPromptDocs` and `workerPromptDocs` append content to their respective system prompts.
- **Pointer:** `reviewPerspectivesPath` is cited by path from the doctrine's review rule and read when needed, like the shipped documents.

## License

Apache-2.0. See [LICENSE](LICENSE).
