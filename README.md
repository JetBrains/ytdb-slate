# ytdb-slate: multi-agent orchestration for the pi coding agent

[![CI status](https://github.com/JetBrains/ytdb-slate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JetBrains/ytdb-slate/actions/workflows/ci.yml)

Slate is a multi-agent orchestration extension for the [pi coding agent](https://pi.dev). You work in one interactive pi session, the main session. A bounded action is a focused task with a clear limit. A worker thread is an isolated pi session that researches, implements, or reviews changes. Slate sends bounded actions to separate worker threads. Each worker thread returns a short structured summary called an episode. A review workflow adds reviewers for risks that you approve or for work above a size threshold.

## What Slate does

- Gives each worker thread context for one action, not the full main-session history.
- Summarizes work at the action boundary. Summaries can omit details.
- Lets Slate adapt its plan after each result.
- Saves episodes for later worker threads to use by reference.
- Runs independent actions in parallel.

## Quick start

You need an installed and authenticated [pi coding agent](https://pi.dev/docs/latest/quickstart). From your project directory, install a pinned Slate version:

```bash
pi install -l npm:ytdb-slate@<version>
```

The `-l` option records the package in `.pi/settings.json`. Pi may ask you to trust the project before loading its settings and extensions. Pi skips pins during `pi update --extensions` and `pi update --all`. Review the shipped workflow documents before moving the pin.

Slate has not reached version 1.0. Releases that change only the last number, for example 0.11.0 and 0.11.3, are compatible. A release that changes the second number, for example 0.12.0, can break compatibility. Review the release notes before you update.

Start a new interactive pi session and let Slate delegate actions:

```text
/slate on
```

Try a request with a clear outcome:

```text
Add input validation to the account settings endpoint. First research the relevant code and tests. Show me the proposed plan and risks before implementation.
```

Slate asks for required decisions before editing code. It delegates work after workflow gates allow it. Slate shows a short workflow summary when orchestrator mode is on at interactive startup or when you turn it on. A saved `startupSummary: false` choice stops automatic display. The summary disappears when you send your first prompt to the model.

Run `/slate off` to stop Slate's delegation and remove the summary. `/slate summary off` also removes it. Toggling orchestrator mode off with `/slate` removes it too. Other slash commands leave it visible unless they reload or replace the session. `/reload`, `/new`, `/resume`, and `/fork` clear the panel when they reload or replace the session. Slate then shows it only when orchestrator mode is on and the saved choice allows automatic display. Run `/slate summary` to show it at any time. See [Commands](#commands).

## How Slate works

- **Main session and orchestrator:** the interactive pi session where you set goals and review results. In **orchestrator mode**, it delegates actions.
- **Bounded action:** focused work with a clear limit and expected result.
- **Worker thread:** an isolated pi session for one action. Follow-up work starts a new thread.
- **Episode:** a durable, structured summary of an action. It retains intent, actions, findings, artifacts, open issues, and handoff notes.

Through `context`, later worker threads can receive earlier episodes without full transcripts. A model summarizes completed work and failed partial work. A worker thread that fails without a response receives a fixed episode instead. Summaries can lose details. [Design principles](docs/design-principles.md) and [model routing](docs/model-routing.md) explain the limits.

Slate independently implements the thread-weaving architecture from the Random Labs technical report for `@randomlabs/slate`.

A track is one coherent, independently mergeable part of a change. Slate supplies a track-based development workflow in orchestrator mode. Project configuration can extend the workflow rules but cannot replace them. Eleven focus areas name specific risks. They cover
concurrency defects, data loss, security weaknesses, performance degradation,
test-quality defects, unreadable user-facing prose, licensing exposure,
non-local logic defects, consumer contract breaks, governing-rule defects, and
unreported failures.

The orchestrator records risks for the change and each track. You approve or reject each named proof. Approved proofs select design gates and reviewers. A track with a proved risk gets one general reviewer and its required specialists. An implementer's approximate track size above 100 added plus removed lines also adds the general reviewer unless the track changes only documents that neither ship as code nor run. Lockfiles, migration files, and generated output do not count. A track that the orchestrator estimates above 100 such lines needs a high-level design before implementation, including when it changes only documents. A track with neither review trigger gets no routine implementation reviewer. See [workflow](docs/track-workflow.md) and [focus areas](docs/blast-radius.md) for the rules. Optional draft pull requests cover the whole change. Only you merge them.

## Commands

| Command | Current behavior |
| --- | --- |
| `/slate on` | Turn on orchestrator mode. Slate removes tactical tools from the main session and expects delegation through worker threads. |
| `/slate off` | Turn off orchestrator mode and restore the earlier tool set. |
| `/slate` | Toggle orchestrator mode. |
| `/slate summary` | Show the workflow summary in any mode, even when automatic display is off. |
| `/slate summary off` | Stop automatic display and remove a visible summary. |
| `/slate summary on` | Allow automatic display when orchestrator mode is on. |
| `/slate effective` | Show the effective logical-model policy and remembered route selections. |
| `/slate handoff [focus]` | Prepare a new-session handoff, with an optional focus. |
| `/slate resume` | Clear a context-budget pause and accept user prompts again. |

## Configuration

Slate reads optional home configuration and trusted project configuration. The [configuration reference](docs/configuration.md) lists merge rules, options, examples, and document path warnings.

## Safety and trust

Slate limits which extensions worker threads can load and which project settings it reads. [Safety and trust](docs/safety-and-trust.md) explains worker extensions, provider registrations, and the project trust boundary.

## Roadmap

The main goal is that you can guide a change through its design without reading the code. Planned work:

1. Design documents that state exact guarantees and show why the design keeps them. Reviewers check the code against the approved design ([#402](https://github.com/JetBrains/ytdb-slate/issues/402), [#403](https://github.com/JetBrains/ytdb-slate/issues/403), [#404](https://github.com/JetBrains/ytdb-slate/issues/404)).
2. Recursive decomposition for large, long-running changes ([#361](https://github.com/JetBrains/ytdb-slate/issues/361)).
3. Better developer experience: asynchronous threads, a detailed cost breakdown, and a read-only view of thread execution.
4. Remote development through integration with pi-agent-dashboard ([#417](https://github.com/JetBrains/ytdb-slate/issues/417)).

See [`docs/roadmap.md`](docs/roadmap.md) for details.

## Shipped docs

These documents define workflow and reference behavior. Slate cites workflow documents by installed path in its numbered system-prompt rules.

- [`docs/blast-radius.md`](docs/blast-radius.md) defines focus areas, proofs, and review coverage.
- [`docs/configuration.md`](docs/configuration.md) defines settings, merge rules, and path warnings.
- [`docs/context-budget.md`](docs/context-budget.md) defines context limits, model overrides, and measured prompt sizes.
- [`docs/delivery-packages.md`](docs/delivery-packages.md) — the compact track and change package format, read only before package preparation
- [`docs/design-principles.md`](docs/design-principles.md) explains the architecture and its trade-offs.
- [`docs/model-routing.md`](docs/model-routing.md) defines logical-model routing, recovery, and accepted limits.
- [`docs/pr-publishing.md`](docs/pr-publishing.md) defines optional draft pull request publishing.
- [`docs/review-rules.md`](docs/review-rules.md) defines reviewer roles, evidence, and fix gates.
- [`docs/roadmap.md`](docs/roadmap.md) describes planned work.
- [`docs/safety-and-trust.md`](docs/safety-and-trust.md) defines worker extension, provider, and trust boundaries.
- [`docs/track-workflow.md`](docs/track-workflow.md) defines research, design, implementation, review, and delivery.
- [`docs/user-notes.md`](docs/user-notes.md) defines user note handling.
- [`docs/writing-guidance.md`](docs/writing-guidance.md) defines writing rules, reminders, status, prompt cost, and the checker.

Project additions extend the shipped rules without replacing them. `doctrineExtraPath` content follows the numbered rules. Slate reads that file again each time it builds the prompt. `orchestratorPromptDocs` and `workerPromptDocs` add prompt content. The orchestrator reads the `reviewPerspectivesPath` file only when needed to compose reviewers. See [configuration](docs/configuration.md) for path rules.

## Community

Join the [Slate Zulip community](https://youtrackdb.zulipchat.com/#narrow/channel/634235-slate) to share what you are building, ask for help, or discuss the project.

## License

Apache-2.0. See [LICENSE](LICENSE).
