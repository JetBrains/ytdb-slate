# ytdb-slate: design-first feature development for the pi coding agent

[![CI status](https://github.com/JetBrains/ytdb-slate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JetBrains/ytdb-slate/actions/workflows/ci.yml)

Slate is an extension for the [pi coding agent](https://pi.dev) for features that need deep domain knowledge, such as database or system code. You describe what a change must do. Slate researches the code and published approaches, proposes a design, implements the change, and reviews the result. You judge designs and results. You keep control without reading every line. Judging each design helps deepen your expertise.

Slate comes from the [YouTrackDB](https://github.com/JetBrains/youtrackdb) team, which develops all YouTrackDB features with Slate. Slate helps new contributors with strong reasoning skills build database features quickly and at high quality, without deep database experience. Developers outside YouTrackDB also use Slate.

## Who does what

| You | Slate |
| --- | --- |
| State the intent and limits of a change. | Researches the code and published approaches. |
| Judge the design, logic and risks. | Proposes designs and names proved risks. |
| Answer product and permission questions. | Implements the change in focused steps. |
| Accept the final result. | Adds reviewers for risky or large changes and reports their findings. |

## Quick start

Use pi 1.5.2 or later. Older pi can load Slate but is unsupported. Slate has no runtime version warning. Install and authenticate [pi](https://pi.dev/docs/latest/quickstart), then pin Slate in your project:

```bash
pi install -l npm:ytdb-slate@<version>
```

The `-l` option records the package in `.pi/settings.json`. Pi may ask you to trust the project. Pi skips pins during `pi update --extensions` and `pi update --all`. Review the shipped workflow documents before moving the pin.

Before 1.0, releases changing only the last number are compatible, such as 0.11.0 and 0.11.3. Changing the second number can break compatibility. Review release notes before updating.

Start a new interactive pi session:

```text
/slate on
```

Try a request:

```text
Add input validation to the account settings endpoint. First research the relevant code and tests. Show me the proposed plan and risks before implementation.
```

## How a change works

Slate researches, assesses risks, and asks for required decisions before editing code. You judge designs and review results. You accept the whole change before merging.

See [workflow](docs/track-workflow.md), [nested planning](docs/recursive-workflow.md), and [publishing guidance](docs/pr-publishing.md) for rules.

## How Slate differs from spec-driven development

Spec-driven development (SDD) puts a written specification at the center of the work. Some developers worry that this becomes a waterfall process, where all design ends before anyone writes code. Slate also uses written designs, but it works in small, checked steps:

- **Research first.** Slate studies existing code and published approaches before proposing a design. You judge the proposal.
- **Design and code advance together.** A track is a reviewable part of a change. About 400 changed lines per track is a guideline, not a limit. In a change with several tracks, you accept each track when it is complete. You also accept the whole change at the end.
- **Design can change.** When implementation must change a guarantee or an assumption of the approved design, Slate shows you the change and asks for your approval.
- **Review depth follows risk.** Slate adds reviewers for proved risks, such as data loss or concurrency defects. Small changes without proved risks get fewer steps. See [review rules](docs/review-rules.md).

Eleven focus areas name specific risks. They cover
concurrency defects, data loss, security weaknesses, performance degradation,
test-quality defects, unreadable user-facing prose, licensing exposure,
non-local logic defects, consumer contract breaks, governing-rule defects, and
unreported failures.

See [focus areas](docs/blast-radius.md).

## What users say

> ytdb-slate pi extension which rises my development expertise to the whole new level. I am not bad developer, but I don't have a lot of experience with db development and system programming. With slate I was able to be as productive as expert in this area. Slate takes all the complexity and deep knowledge needed and only leaves the good reasoning and logic to me. So, basically, every human with a good reasoning skills and some background understanding of computers and networks could become a pro system developer. I truly believe slate is a new revolution in the software development.

— YouTrackDB developer

## When plain pi is enough

Use plain pi for small, well-understood edits. Slate uses more model calls than plain pi, so it costs more. Designs and reviews do not guarantee correct code. You still judge the evidence.

## Product principles

- **Control without reading every line.** Judge designs, proved risks and review results instead of relying only on code inspection.
- **Quality before cost, within limits.** Slate spends more model work on quality, up to a reasonable limit.
- **Cost in proportion to the change.** Small changes without proved risks need fewer steps than large or risky changes.

## How Slate works

Slate uses multi-agent orchestration:

- **Main session:** your interactive pi session. In orchestrator mode, it delegates work.
- **Bounded action:** focused work with a clear limit and expected result.
- **Worker thread:** an isolated pi session for one action.
- **Episode:** a durable, structured summary of an action.

Slate sends bounded actions to worker threads. The orchestrator manages worker threads, keeps steps focused, adapts after results, and runs independent actions in parallel. Later worker threads receive episodes by reference through `context`, without full transcripts. Summaries can lose details.

Slate independently implements the thread-weaving architecture from the Random Labs technical report for `@randomlabs/slate`. See [design principles](docs/design-principles.md) and [model routing](docs/model-routing.md).

## Commands

| Command | Current behavior |
| --- | --- |
| `/slate on` | Turn on orchestrator mode. Slate removes tactical tools from the main session and expects delegation through worker threads. |
| `/slate off` | Turn off orchestrator mode and restore the earlier tool set. |
| `/slate` | Toggle orchestrator mode. |
| `/slate summary` | Show the workflow summary in any mode, even when automatic display is off. |
| `/slate summary off` | Stop automatic display and remove a visible summary. |
| `/slate summary on` | Save automatic display for the next startup or mode activation. |
| `/slate effective` | Show the effective logical-model policy and remembered route selections. |
| `/slate handoff [focus]` | Prepare a new-session handoff, with an optional focus. |
| `/slate resume` | Clear a context-budget pause and accept user prompts again. |

## Configuration

Slate reads optional home configuration and trusted project configuration. The [configuration reference](docs/configuration.md) lists merge rules, options, examples, and document path warnings.

Slate attempts notifications after a main-session run settles or an extension dialog stays open for input. Terminal, desktop and bell delivery default to on. Phone push through ntfy, a notification server, needs home setup. Text defaults to the event type. See [notification setup](docs/configuration.md#notifications) for timing and limits.

## Safety and trust

Slate limits which extensions worker threads can load and which project settings it reads. [Safety and trust](docs/safety-and-trust.md) explains worker extensions, provider registrations, and the project trust boundary.

## Roadmap

The planned vision has two levels between requirements and code. A high-level design states what must be true and why. A low-level design shows how the code works through:

- **Baseline map:** explains how the current code works before a change.
- **Implementation map:** explains what the delivered code does.
- **Neutral pseudocode:** describes logic without a specific programming language.

Maps are under development. Other plans:

1. Exact design guarantees, reasoning, and review against the approved design ([#402](https://github.com/JetBrains/ytdb-slate/issues/402), [#403](https://github.com/JetBrains/ytdb-slate/issues/403), [#404](https://github.com/JetBrains/ytdb-slate/issues/404)).
2. Asynchronous threads, a detailed cost breakdown, and a read-only view of thread execution.
3. Remote development on your infrastructure through one browser application, from a laptop, desktop or phone, with notifications when an agent needs attention.

See [roadmap](docs/roadmap.md) for details.

## Shipped docs

These documents define workflow and reference behavior. Slate uses installed paths for workflow citations in its numbered system-prompt rules. The filenames `change-records.md` and `recursive-workflow.md` resolve beside the Lifecycle document, `track-workflow.md`.

- [`docs/blast-radius.md`](docs/blast-radius.md) defines focus areas, proofs, and review coverage.
- [`docs/change-records.md`](docs/change-records.md) defines identifiers, code ranges, design markers, and safe writes to change records.
- [`docs/configuration.md`](docs/configuration.md) defines settings, merge rules, and path warnings.
- [`docs/context-budget.md`](docs/context-budget.md) defines context limits, model overrides, and measured prompt sizes.
- [`docs/delivery-packages.md`](docs/delivery-packages.md) — the compact track and change package format, read only before package preparation
- [`docs/design-principles.md`](docs/design-principles.md) explains the architecture and its trade-offs.
- [`docs/model-routing.md`](docs/model-routing.md) defines logical-model routing, recovery, and accepted limits.
- [`docs/pr-publishing.md`](docs/pr-publishing.md) defines optional draft pull request publishing.
- [`docs/recursive-workflow.md`](docs/recursive-workflow.md) defines nested planning, repair children, and whole-subtree acceptance.
- [`docs/review-rules.md`](docs/review-rules.md) defines reviewer roles, evidence, and fix gates.
- [`docs/roadmap.md`](docs/roadmap.md) describes current larger-change guidance and planned work.
- [`docs/safety-and-trust.md`](docs/safety-and-trust.md) defines worker extension, provider, and trust boundaries.
- [`docs/track-workflow.md`](docs/track-workflow.md) defines research, design, implementation, review, and delivery.
- [`docs/user-notes.md`](docs/user-notes.md) defines user note handling.
- [`docs/writing-guidance.md`](docs/writing-guidance.md) defines writing rules, reminders, status, prompt cost, and the checker.

Project additions extend the shipped rules without replacing them. `doctrineExtraPath` content follows the numbered rules. Slate reads that file again each time it builds the prompt. `orchestratorPromptDocs` and `workerPromptDocs` add prompt content. The orchestrator reads the `reviewPerspectivesPath` file only when needed to compose reviewers. See [configuration](docs/configuration.md) for path rules.

## Community

Join the [Slate Zulip community](https://youtrackdb.zulipchat.com/#narrow/channel/634235-slate) to share what you are building, ask for help, or discuss the project.

## License

Apache-2.0. See [LICENSE](LICENSE).
