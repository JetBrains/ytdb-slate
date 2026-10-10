# Slate design principles

Sections 1 to 3 and principles P1 to P10 adapt the Random Labs technical
report about the Slate architecture, called "thread weaving".
Notes marked as repo-local describe this extension and do not come from that report.

### Record key

Module headers cite design records that are not part of this repository.
The following key explains their identifiers:

| Identifier | Meaning |
| --- | --- |
| ExecPlan: D3–D9, M1–M3 | Records from the original implementation plan |
| Higher-numbered D identifiers | Later design rounds |
| W identifiers | Named warnings |
| AD | Adversarial review finding |
| AF | Agent-failure review finding |
| BG | Blocker or bug review finding |
| CN | Concurrency review finding |
| CQ | Code-quality review finding |
| DF | Data-fidelity review finding |
| N | Numeric review finding |
| RG | Regression review finding |
| RI | Review finding. The code citation does not identify the review round. |
| SE | Security review finding |
| WB | Worker-boundary review finding |
| WS | Worker-safety review finding |

Prefixes identify the review that raised a finding.
The `RI1` comment in `mode.ts` concerns how Slate reports a refused prompt.
The comment does not establish that RI means research integrity.
[review-rules.md](review-rules.md) uses RI for Reviewer I, the general implementation reviewer.
Use the record that raised a finding to identify its review round.

The logical-model source files carry the approved project attribution and retrieval date.
The retained research log holds the full private evidence record.
This document records the architecture rationale.

## 1. The problems Slate is built to solve

The report describes three interacting problems in agents based on large
language models (LLMs). Each problem is easier to address on its own.

1. **Long-horizon tasks.** These tasks need more steps than a minimal
   tool-calling loop can reliably complete. Later steps depend on earlier
   results. The agent must retain useful information and revise its plan
   without losing the overall goal.
2. **Working memory and the "Dumb Zone".** A model's context window holds
   the text available for its next response. The model does not use all of
   that text equally well. Retrieval quality can degrade as context grows.
   The report calls this degradation "context rot" and calls the degraded
   part of context the "Dumb Zone". The agent must manage how much context
   it retains.
3. **Strategy vs tactics.** Strategy is planning toward the overall goal.
   Tactics are local action sequences, such as running a command or reading
   a value from a file. The report uses AlphaGo and AlphaZero to illustrate
   the distinction between evaluating a position and choosing a move.
   Software work needs both planning and local execution. The harness,
   meaning the software that manages the model and its tools, must support both.

The report also uses three supporting concepts:

- **Knowledge overhang.** A model may hold knowledge that it cannot apply
  without help from plans, reasoning steps, or the harness structure.
  This motivates the report's emphasis on context management rather than
  model intelligence alone.
- **Expressivity.** An expressive harness lets a small set of operations
  produce many outcomes. For example, `sed` can read, write, and search.
  A harness with only `file_read` cannot edit. A fixed task graph limits
  the actions the agent can choose.
- **Inductive bias.** Models tend to use interfaces that resemble those
  they encountered during training. The harness should make the intended
  behavior easy to choose.

## 2. Why prior approaches fall short

The report identifies limits in earlier approaches. Each approach addresses
some problems but leaves others unresolved.

- **Compaction.** Replacing earlier context with a summary can lose
  important information unpredictably. The report discusses sliding
  windows, Claude Code compaction, and Amp handoffs.
- **Naive subagents.** A subagent is an agent that executes work for a
  parent agent. Subagents can isolate context well. A response string
  alone may omit facts the parent needs. The issue is the retained content,
  not the use of text: Slate also returns textual results.
- **Markdown plans.** Plans encourage strategy but can become stale.
  A plan may omit necessary detail. Execution may stop before the task is
  complete. The agent may also fail to update the plan after new findings.
- **Direct task decomposition.** Task trees and gated steps can encourage
  complete execution. A fixed tree is harder to adapt when new information
  arrives. The parent may also fail to integrate a subtask's result.
- **RLM / recursive decomposition.** Recursive language models (RLMs) can
  pass references to context and divide work through a familiar interface.
  Unbounded recursion can divide work too finely. A read-eval-print loop
  (REPL) that returns feedback only after a batch cannot guide the next
  step within that batch. This matters when the environment changes during work.
- **Strategize–delegate–compress stacks.** These systems separate planning,
  delegated execution, and compression. The report discusses Devin, Manus,
  and Altera/PIANO. Compression can omit critical state. A strict separation
  between planner and executor can also delay adaptation.
- **ReAct.** This approach interleaves reasoning and actions in one
  context. The form discussed in the report provides neither separate
  worker contexts nor parallel execution. Its context can fill until
  response quality degrades.

## 3. Slate's answer: threads, episodes, thread weaving

- **Thread.** One worker session executes one bounded action and ends.
  A thread has an immutable thread type. The type records the action's
  purpose and can select Slate-owned guidance. Reviewer and adversarial
  threads receive the reviewer evidence charter, which defines the evidence
  a reviewer must provide.
- **Episode.** An episode is a compressed, structured record of one
  action's results and important steps. Slate compresses the results after
  the action settles. Pi, the coding-agent host, can also compact a worker's
  history during an action. Episode compression and in-action history compaction are separate
  operations.
- **Composability.** A new thread can receive prior episodes from any
  thread. The orchestrator passes episode identifiers through the `context`
  argument. Slate reads the stored episodes into the worker prompt.
  The worker receives the retained conclusions without the full conversation.
- **Thread weaving.** The orchestrator is the parent pi session that
  assigns work and integrates results. It dispatches bounded actions to
  workers and uses their episodes to decide what comes next. Decomposition
  can change as new information arrives. Each returned episode lets the
  orchestrator revise its strategy before choosing more work.
- **Context management.** Each returned episode is an opportunity to
  decide what to retain, compress, or discard. The orchestrator and workers
  have separate contexts. Slate budgets the orchestrator's context and can
  hand off work to a fresh session.

## 4. Operating principles

- **P1 — One dispatch, one bounded action.** Each action covers local work
  with a clear goal, a completion condition, and a way to verify the result.
- **P2 — Episodes are the synchronization primitive.** The orchestrator
  receives results as episodes rather than continuing a conversation with
  the same worker. Some failures return an error without an episode, as §5 explains.
- **P3 — Compress at completion boundaries.** Episode compression is part
  of the action lifecycle. Pi may also compact history during an action.
- **P4 — Compose context by reference.** Pass episode identifiers instead
  of restating their content. The episode store remains the source of truth.
- **P5 — Decompose implicitly and adaptively.** Do not treat an initial
  plan as fixed. Update strategy after every episode. Failed episodes demand
  adaptation, not blind retry.
- **P6 — Make desired behavior the natural behavior.** In orchestrator
  mode, the parent keeps read-only tools for orientation. File edits and
  commands require delegation to workers.
- **P7 — Guard against over-decomposition.** Workers never receive Slate's
  own tools: `thread`, `threads`, `episode`, and `slate_change`.
  A worker cannot spawn another Slate thread. This guarantee does not bound other forms of
  delegation. See the recursion-guard note in §5.
- **P8 — Per-episode feedback beats blind N-step execution.** Each returned
  episode gives the orchestrator feedback for choosing the next action.
- **P9 — Parallelize independent actions.** Run independent actions in
  concurrent threads. Integrate their episodes afterward.
- **P10 — Treat context as RAM.** The report compares context with limited
  random-access memory (RAM). Budget context and hand off to a fresh session
  when the budget is exceeded.

  *(Repo-local note, not from the report.)* Slate's pause stops new user work.
  The pi input hook refuses a new user prompt while Slate is paused.
  Worker dispatches remain available. The paused orchestrator can therefore
  save project state in the research log before it writes the handoff brief.
  See [context-budget.md](context-budget.md).

- **P11 — Proportional process.** *(Repo-local note, not from the report.)*
  The current change folder's research log is the sole permitted unconditional-artifact exception for
  authors of future rules. Every other future rule that adds process cost names
  the condition that engages it. The condition is a proved focus area, an
  artifact whose own existence a proved focus area decides, or specific
  evidence that does not appear in every track.

Repo-local note (not from the report): Principle P11 governs the count of
required gates, required artifacts and required review actions. A rule that
changes how an existing step is performed does not add cost under P11. A rule
that fires only when specific evidence appears is conditional, unless that
evidence appears in every track, in which case the rule is unconditional.
Prompt text and output quality floors are not process steps, and a published
size budget governs them instead. P11 constrains the authors of future rules.
It does not remove or condition current required artifacts, including the
per-track implementer report. Closing a change keeps its folder and records.
Only the user deletes that folder.

P11 also governs user interaction. Questions follow unresolved decisions, not
the number of workflow steps, records, or tracks. Applicable evidence and prior
explicit answers reduce repeated questions. They do not remove reassessment,
required reviews, ordered gates, user authority, or final acceptance.

- **P12 — Reader understanding decides the form.** *(Repo-local note, not from the report.)*
  Write so that a reader whose first language is not English, and who knows
  nothing about the project, understands the text on one reading. Sentence
  length is a house-style signal. Slate reports long sentences as findings
  without treating them as verdicts. Split a long sentence while keeping the
  logical connection explicit. Name the subject instead of using a bare
  reference. Accept the repeated subject and its word cost. Avoid disconnected
  fragments. The configured limit controls the sentence-length finding.

### Built-in focus-area authoring

- **P13 — Research and define built-in focus areas by risk.** *(Repo-local note, not from the report.)* When proposing a new built-in focus area and its reviewer, apply these rules:

  0. Research external sources before defining the area or writing reviewer questions. Standards, research papers, and established engineering guides are possible sources. Keep a corpus of findings, meaning a collection of source summaries, in the proposing tracker issue or pull request. Do not ship the corpus. Each entry links its source and states its support for the area and its applicability limits. State what the source does not prove. Copy no source text. Use the corpus as evidence for judgment in rules 1, 2, 3, and 6. The user still approves the area.
  1. Define the risk by the outcome it prevents and the condition that engages it. The size of a change, its file count, and a complexity score never engage an area. A requirement can still state a size limit as part of the risk, for example a size budget for one path.
  2. State a boundary with every existing area. Explain which outcome belongs where and when both areas engage.
  3. Explain all four proof parts for the area: defect class, place, material consequence of omitting its reviewer, and review contribution. The contribution identifies useful review evidence and why planned implementation checks cannot settle the risk.
  4. Choose DESIGN-TRIGGERING, which requires a high-level design, or REVIEWER-ONLY, which adds a reviewer only. Give the reason.
  5. Run the new reviewer only through a proved area, applying P11. A proved area has user approval of its four-part proof.
  6. Create one perspective file with a one-sentence definition, charter, design-quality questions, and examples of useful evidence, in that order. Cover every design concern inside the area without a fixed question count. Evidence examples are not required checks or artifacts.
  7. Keep every rule and question applicable to any project using Slate.
  8. Update the code list of review perspectives, finding prefix, both focus-area tables, class list, structure and agreement checks, and published size figure. Keep all of them consistent.
  9. Put a project-only rule in a project-added charter through `reviewPerspectivesPath`, not a built-in area.

## 5. Where each principle lives in the code

| Principle | Implementation |
|---|---|
| P1 bounded actions | `tools.ts` defines the `thread` tool contract. Doctrine rule 1 in `mode.ts` requires bounded actions. |
| P2 episodes as sync | `threads.ts` returns an episode for completed work and many failures. Admission, cancellation, and storage failures can return errors without episodes. |
| P3 boundary compression | `episodes.ts` compresses results after the action settles. Pi can also compact history during execution. |
| P4 context by reference | `tools.ts` accepts episode identifiers in `context`. `ThreadManager.buildPrompt` in `threads.ts` loads their stored content. |
| P5 adaptive decomposition | Doctrine rule 6 in `mode.ts` requires strategy updates after episodes. |
| P6 natural behavior | `mode.ts` restricts `ORCHESTRATOR_TOOLS` to read-only tools and Slate tools. |
| P7 over-decomposition guard | `worker-extensions.ts` rejects unsafe load units. `worker.ts` adds collision checks and denies Slate's own tools. See the recursion-guard note below. |
| P8 per-episode feedback | `threads.ts` provides asynchronous dispatch. The `thread` tool in `tools.ts` awaits it and returns the episode. |
| P9 parallelism | `threads.ts` queues actions through `maxConcurrent`. Doctrine rule 2 in `mode.ts` requires parallel dispatch. |
| P10 context as RAM | `handoff.ts` pauses at the context budget and supports handoff to a fresh session. |
| P11 proportional process | The shipped workflow documents apply it to gates, artifacts, and review actions. It has no code home. |
| P12 reader understanding | `writing-check.mjs` reports sentence-length findings. The writing guidance and review rules apply it to project prose. |
| P13 risk-based focus-area authorship | no runtime code home for author research or approval. Focus definitions, reviewer content, the code roster, and structure and agreement checks apply the rule. |

Repo-local note (not from the report): `maxConcurrent` defaults to 4.
The cap must be at least 1. Slate does not enforce that condition.
A value of 0 or less leaves dispatches waiting indefinitely.

With a positive cap, excess actions wait for a slot.
The slot covers the worker conversation and episode compression.
A low positive cap increases wait time. A high cap can exceed provider
rate limits and cause failed episodes or increase provider spend.

The default aims to support small parallel batches, such as research actions
or several reviewers. It does not guarantee safety under provider rate limits.
Projects can adjust the cap in `slate.json` for their workload and provider limits.

Repo-local note (not from the report): **logical-model routing and recovery**
applies P10 discipline to provider spend. Each bounded action names a provider-free
logical model and a reason. The immutable parent-session policy fixes effort, exact
physical permissions, ratings, guidance, cautions, and common recovery order. Pi
owns discovery, authentication, and execution. Slate owns no provider alias rule.

The policy separates enforced facts from orchestrator judgment. Code enforces exact
permissions, complete definitions, fixed effort, trust, critical-error blocking,
and bounded recovery. The orchestrator judges action fit and advisory guidance. A
track with no proved focus area uses the same ordinary selection rule.
`model-routing.md` owns the complete configuration and recovery contract.

Repo-local note (not from the report): the P7 recursion guard denies
Slate's own tools to every worker. The optional `workerExtensions`
key selects host extensions to load into workers. Home or trusted project
settings supply the key in `slate.json`.
See the [configuration reference](configuration.md).
Slate also loads its internal worker reminder component, even when the
extension allowlist is empty. The component supplies no dispatch tools.

Selection applies to a **load unit**, meaning one entry file or one package
directory that pi loads as a whole. Slate uses a package directory only
when the declared entries match the entries observed in the host registry.
Otherwise, Slate selects individual entry files. Three load-time barriers
limit which host extensions can load:

1. Only allowlisted host units load through pi's resource loader.
   Automatic extension discovery is disabled. The internal reminder loads
   separately as a Slate-owned factory. Loader errors produce warnings.
   Candidates come from extensions represented in the host tool registry.
   An extension with no registered tools is not a candidate on its own.
   A host with no loaded extensions supplies no candidates.
2. Slate rejects units that its path or package-identity checks identify
   as Slate itself. Those checks run regardless of the selection patterns.
3. Slate rejects the whole unit if any registered tool name collides with
   `thread`, `threads`, `episode`, or `slate_change`, or with a pi built-in tool.
   The built-ins are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`.
   Pi allows an extension tool to replace a same-named built-in.

Exclusion happens before loading the unit. Loading an extension activates
its event handlers, tools, and flags. Filtering its tools afterward would
leave its handlers and flags active. Slate therefore rejects a colliding
unit rather than suppressing only the colliding tool.

The package-directory check is recorded as BG20.
Every declared entry must be a nonempty literal path, not a glob or override pattern.
The host tool registry must contain every resolved entry path.
Pi then resolves the package manifest and loads the directory as a whole.

A glob, an override-form entry, or a filtered host subset fails the check.
The fallback uses the entry files observed in the host tool registry.
The fallback cannot include companion entries that register no tools,
because the registry does not establish that the host loaded them.

The collision barrier runs before a unit loads against the tools in the
host registry. Slate scans the worker registry again after every selected
extension completes `session_start`. A tool registered during startup can
remain eligible if the host selected it. A startup tool that replaces a
Slate or pi built-in blocks the action.

The exclusion of Slate's own tools does not depend on either scan.
`createAgentSession` receives an `excludeTools` denylist of
`thread`, `threads`, `episode`, and `slate_change`.
Pi applies the denylist after the allowlist and on every tool-registry refresh.

Slate owns the complete worker extension lifecycle. It waits for
`session_start` before the action. A startup handler failure blocks the
action and enters cleanup. Every terminal path shares one shutdown
operation per worker. That operation emits `session_shutdown` once and
then disposes the session even when a shutdown handler fails. Host cleanup
removes workers from the live set before it awaits their shutdown, so an
overlapping action cannot continue with a session in teardown.

Orchestrator mode keeps its restricted tool set. Selecting a worker
extension does not add that extension's tools to the orchestrator.
The doctrine instead lists selected extensions with their tool names and
descriptions. The orchestrator can use the list to choose delegated work.
The doctrine and worker allowlists use one cached resolution per session.

The guarantee is narrow: no worker receives Slate's own tools.
The guard does not bound all recursion or delegation. Operators must assess
these accepted risks:

- An allowlisted extension may supply a subagent or delegation tool under
  another name. Slate cannot detect or bound that delegation. The delegated
  work falls outside Slate's episode and cost accounting. Selecting such an
  extension is an operator decision.
- An allowlisted extension has the same filesystem and credential access
  in a worker as in the host. Slate's read-only settings snapshot blocks
  pi-settings writes. It provides no broader filesystem or credential isolation.
- A startup handler can fail. Slate reports the failure, blocks the action,
  and still runs shutdown and disposal.
- Third-party extensions may ignore the abort signal, so their network
  activity can outlive an abort or a context-budget pause.
- Host and worker copies of the same extension share module-level state
  through pi's process-global module cache.
- Provider-native tool billing may escape Slate's worker cost accounting.

Provider registration determines which model providers a session can use.
It has a separate startup boundary from the `workerExtensions` tool allowlist.
Pi first constructs the worker and applies its own extension registrations.
Slate then copies host extension provider registrations whose identifiers
are absent from the worker's registered-provider list.

The list includes both native provider objects and provider configuration
registrations. Both forms use the same provider identifier.
An existing worker registration therefore takes precedence over either host form.
The list excludes built-in providers. A host extension can therefore
redirect a built-in provider.

The worker keeps its own model runtime, which manages its models and providers.
Sharing the host runtime would tie later changes and its lifetime to the host.
Copying before worker construction would compare against an incomplete list.
Slate copies registrations after construction and before route authentication
or a request.

A failed copy shuts down the session and fails the action.
The copy check verifies registration and composition, not authentication
for every inherited provider. An unused provider can be intentionally unconfigured.

The copy reuses provider functions. It can also share nested configuration
objects, native provider objects, credential files, authentication callbacks,
and third-party module state. It does not copy host provider event handlers
or synchronize host changes after startup.

A later partial worker registration can merge with inherited configuration
under pi rules. The result can retain inherited credentials while changing
the endpoint. Slate accepts this risk and does not intercept late registrations.
Provider extensions that need host event handlers or isolated internal state
must supply their own worker support.

## 6. Runtime knowledge: what the orchestrator knows, and when

Slate separates guidance that the orchestrator always receives from
rationale that it reads on demand:

- **Tier 1 — always loaded.** The doctrine is the operational guidance
  assembled in `mode.ts`. Slate appends it to the system prompt each turn
  while orchestrator mode is on. The doctrine summarizes P1 to P10 and the
  review discipline in `review-rules.md`. It also points to the shipped
  workflow in `track-workflow.md`.

  When Slate configuration is permitted, the doctrine also includes rules
  for logical models, writing, and design. Configuration is permitted for
  trusted projects or when the loader supplies home-only configuration.
  An untrusted project cannot supply these settings.

  [context-budget.md](context-budget.md) records the doctrine measurements
  and configuration table. The logical-model rule has one row for each
  ordinary logical model. Its raw character count depends on the installed
  documentation path. The budget document publishes portable character
  counts that omit the installed directory prefix. It distinguishes runtime
  rejection limits from regression baselines used by verification checks.
- **Tier 2 — on demand.** Doctrine rule 10 points to this document.
  The rule instructs the orchestrator to read it when explaining or changing
  Slate, or when making an unusual routing or compaction decision.
  The rule says to skip the read if the document is already in context.
  This is an instruction, not an enforced restriction on file reads.

Worker guidance follows the same separation. `worker.ts` supplies the
built-in worker preamble. Slate adds the reviewer evidence charter only to
reviewer and adversarial thread types. Workers with permitted Slate
configuration also receive writing guidance.

The `prompt-docs.ts` loader reads optional role documents. Both document
lists default to empty. `mode.ts` adds orchestrator documents through
`before_agent_start`. `worker.ts` adds worker documents through
`appendSystemPrompt`.

Home or trusted project settings supply the `orchestratorPromptDocs` and
`workerPromptDocs` keys in `slate.json`.
The configuration loader resolves home paths from the agent directory and
project paths from the project root. Each role receives its own configured documents.

Loading this full document every turn would consume context for background
analysis rather than operational instructions. Keeping rationale on demand
and rules always loaded applies P10.
