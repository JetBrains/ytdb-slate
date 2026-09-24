# Slate design principles

Distilled from the Random Labs technical report introducing the Slate
architecture ("thread weaving") — the open-beta release write-up of the
Slate agent (published as the npm package `@randomlabs/slate`); no stable
URL is recorded, so the distillation here is the in-repo source of truth
for its content. This document records the reasoning behind the
extension's design so maintainers — and the orchestrator itself, on
demand — can check changes and behavior against the original intent.

Note: module headers cite ids from design records that are not part of this
repository — the original implementation plan (ExecPlan: D3–D9, M1–M3), later
design rounds (higher-numbered D ids, and W ids for named warnings), and
per-round review findings, whose prefix says which review raised them:
AD (adversarial), AF (agent-failure), BG (blocker/bug), CN (concurrency),
CQ (code quality), DF (data fidelity), N (numeric), RG (regression),
RI (research integrity), SE (security), WB (worker boundary) and WS (worker
safety). The logical-model source files carry the approved project attribution and retrieval date. The retained research log holds the full private evidence record. This document is the in-repo source for the architecture rationale.

## 1. The problems Slate is built to solve

Three compounding problems in LLM agents — each tractable in isolation; the
difficulty is that they interact:

1. **Long-horizon tasks** — path-dependent tasks whose minimum successful
   step count exceeds what a minimal tool-calling loop can do. Solving them
   requires adequate working memory, a strategy/tactics balance, and the
   ability to integrate information discovered mid-task without losing the
   overall goal.
2. **Working memory and the "Dumb Zone"** — models cannot attend uniformly
   across the context window; retrieval quality degrades non-uniformly as
   context grows ("context rot"). The usable prefix is working memory; the
   degraded tail is the Dumb Zone. Context must be managed like scarce RAM.
3. **Strategy vs tactics** — strategy is open-ended planning toward the
   goal; tactics are learned local action sequences (run a command, extract
   X from file Y). The AlphaGo/AlphaZero lineage architected this split
   explicitly (value network = positional strategy, policy network = move
   tactics), and probing shows tactical concepts are learned before
   strategic ones. Software engineering spans the whole spectrum — a good
   harness lets the model strategize without drowning in tactical detail.

Supporting concepts:

- **Knowledge overhang** — knowledge a model holds latently but cannot
  access tactically without scaffolding (plans, chain-of-thought, harness
  structure). Corollary: the bottleneck in long-horizon agentic work is
  context management, not model intelligence.
- **Expressivity** — a harness is expressive when few output operations can
  reach many end states (a `sed`-only harness can read, write, and search;
  a `file_read`-only harness can never edit). Rigid task graphs lower
  expressivity.
- **Inductive bias** — models default to interfaces they were trained on.
  The harness builder's job is to make the desired behavior the natural
  behavior.

## 2. Why prior approaches fall short

No prior approach solves all of the above simultaneously; each trades one
or two problems for the others:

- **Compaction** (sliding windows, Claude Code compaction, Amp handoffs) —
  non-deterministically lossy: important information can vanish
  unpredictably.
- **Naive subagents** (Codex/Claude Code) — isolate context well, but
  synchronize by message passing: the parent only gets a response string,
  so information fails to cross the context boundary. Works mainly for
  exploratory search over immutable data.
- **Markdown plans** — force the model to strategize (tapping the knowledge
  overhang) but go stale. Three failure modes: underspecified plans,
  incomplete execution ("declaring victory early"), and forgetting to
  update the plan when new information arrives.
- **Direct task decomposition (task trees, gated steps)** — thorough and
  resistant to early stopping, but rigid: adapting to new information means
  rewriting the tree, and unintegrated subtask results get orphaned. Low
  expressivity.
- **RLM / recursive decomposition** — the right primitives (context by
  reference, natural decomposition through a familiar interface), but
  unbounded recursion needs a guard against over-decomposition, and REPL
  execution yields no intermediate feedback: the model commits to N steps
  blind and only learns the outcome at the end — no course correction in a
  mutating environment.
- **Strategize–delegate–compress stacks (Devin, Manus, Altera/PIANO)** —
  every compress-and-return boundary risks dropping critical state, and the
  strict planner/executor split adds inertia and reduces reactivity.
- **ReAct** — maximally reactive and expressive but has no context
  isolation, no compaction story, and no parallelism: the single context
  fills until quality degrades.

## 3. Slate's answer: threads, episodes, thread weaving

- **Thread** — one worker session that executes one bounded action and ends.
  A thread has an immutable thread type. The type records the action's purpose
  and can select Slate-owned guidance. Reviewer and adversarial threads receive
  the reviewer evidence charter.
- **Episode** — the compressed, structured record of the steps a thread
  took to complete one action: important results retained, tactical trace
  dropped. Episodes — not message passing — are the synchronization
  primitive. Because a bounded action has a natural completion boundary,
  compaction happens at meaningful moments instead of arbitrarily
  mid-stream. This is a tractable form of episodic memory.
- **Composability** — episodes are inputs: any thread can be initialized
  with prior episodes (from any thread), inheriting conclusions without
  inheriting full context. Context-by-reference routing is what
  distinguishes threads from subagents that return a single string.
- **Thread weaving** — the orchestrator dispatches, threads execute,
  episodes compose. Decomposition is implicit and adaptive: the
  orchestrator never commits to a static plan, but is forced to externalize
  work as bounded, compressible units. Frequent bounded synchronization
  gives per-episode feedback, so strategy updates mid-task instead of
  failing at the end.
- **OS framing** — the orchestrator is the kernel; threads are processes;
  episodes are process return values committed into the kernel's working
  memory; the context window is RAM — scarce and actively managed. Each
  thread return is a scheduled opportunity to decide what is retained,
  compressed, or discarded.

## 4. Operating principles

- **P1 — One dispatch, one bounded action.** An action is a tactic-sized
  unit: clear, completable, verifiable.
- **P2 — Episodes are the synchronization primitive.** No back-and-forth
  message passing between orchestrator and workers.
- **P3 — Compress at completion boundaries.** Compaction is built into the
  action lifecycle, not applied as emergency lossy surgery.
- **P4 — Compose context by reference.** Pass episode ids, not restated
  content; the episode store stays the source of truth.
- **P5 — Decompose implicitly and adaptively.** No upfront static plan;
  update strategy after every episode; failed episodes demand adaptation,
  not blind retry.
- **P6 — Make desired behavior the natural behavior.** In orchestrator
  mode, tactical tools are removed, so delegation is the only way to act.
- **P7 — Guard against over-decomposition.** Workers never receive
  Slate's dispatch tools (`thread`/`threads`/`episode`), so no worker can
  spawn a Slate thread — Slate's own recursion stays depth-1. That is a
  narrow load-time invariant, not a general delegation bound (see the
  recursion-guard note in §5).
- **P8 — Per-episode feedback beats blind N-step execution.** Bounded
  actions return before the next decision, so course correction is always
  possible.
- **P9 — Parallelize independent actions.** Independent work streams run as
  concurrent threads whose episodes are synthesized afterward.
- **P10 — Treat context as RAM.** Budget it; when the budget is exceeded,
  pause dispatching and hand off to a fresh session rather than degrading
  in the Dumb Zone.
  *(Repo-local note, not from the report.)* Slate's pause stops new USER work:
  the pi input hook refuses a new user prompt while Slate is paused. Worker
  dispatches stay open, so the paused orchestrator can save the project state
  in the research log before it writes the handoff brief. See
  [context-budget.md](context-budget.md).

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

## 5. Where each principle lives in the code

| Principle | Implementation |
|---|---|
| P1 bounded actions | `tools.ts` `thread` tool contract; doctrine rule 1 in `mode.ts` |
| P2 episodes as sync | `threads.ts` returns one episode for completed or failed work |
| P3 boundary compression | `episodes.ts` episode compression on action completion |
| P4 context by reference | `tools.ts` `context` parameter injects prior episodes by id |
| P5 adaptive decomposition | doctrine rule 6 in `mode.ts`; no plan structure imposed anywhere |
| P6 natural behavior | `mode.ts` `ORCHESTRATOR_TOOLS` restriction (read-only + slate tools) |
| P7 over-decomposition guard | `worker.ts` recursion guard — load-scoped barriers keep Slate's `thread`/`threads`/`episode` tools out of every worker (recursion-guard note below) |
| P8 per-episode feedback | `threads.ts` synchronous dispatch; episode returned to orchestrator |
| P9 parallelism | `threads.ts` `maxConcurrent` queueing; doctrine rule 2 in `mode.ts` |
| P10 context as RAM | `handoff.ts` context-budget auto-pause + fresh-session handoff |
| P11 proportional process | no code home; the shipped workflow documents apply it to gates, artifacts and review actions |
| P12 reader understanding | `writing-check.mjs` reports sentence-length findings; the writing guidance and review rules apply it to project prose |

Repo-local note (not from the report): the `maxConcurrent` cap defaults
to 4. Its failure modes are asymmetric: excess dispatches wait for a
slot, so a low cap costs only latency, while a cap above the
provider's effective rate limits turns rate-limit exhaustion into
FAILED episodes and raises the unattended cost burn rate. Over its
lifetime a slot covers a multi-turn worker conversation followed by its
episode-compression call. The default is sized to cover typical
parallel batches (recon fan-outs, a review wave of a few perspectives)
while staying safe on common consumer API tiers; wider fan-outs only
pay tail latency, and projects with higher-tier keys raise the cap in
`slate.json`.

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

Repo-local note (not from the report): the P7 guard was originally
absolute — workers loaded no extensions, so Slate's `thread` tool simply
never existed for them. The optional `workerExtensions` key (`slate.json`,
home or trusted project settings — see the README config reference) relaxes that: it
whitelists extensions the host session has ALREADY loaded and loads them
into every worker. The guard therefore no longer rests on "workers load
nothing" but on a narrower, more precise invariant: no worker can ever
obtain SLATE's dispatch tools (`thread`/`threads`/`episode`).

Three load-scoped barriers buy that invariant, all applied per LOAD UNIT
— the owning package directory when the extension is package-originated
and the package's declared entries provably match what the host loaded
(BG20, below), otherwise the extension's own entry file:

1. Only whitelisted units load, through pi's resource loader in allowlist
   mode; a worker's extension set is exactly the allowlist and no
   non-whitelisted module is ever imported (load errors surface as
   warnings). Candidates are only what the host session already loaded,
   enumerated from its tool registry — so an extension registering no
   tools is invisible, and a host started with extensions disabled yields
   an empty candidate set.
2. Any unit that contains Slate's own package root is dropped whatever the
   patterns say.
3. Any unit whose tools collide with Slate's `thread`/`threads`/`episode`
   or with pi's built-ins (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`)
   is dropped WHOLE — pi's registry lets an extension tool overwrite a
   same-named built-in, so a partial load could shadow the very tools the
   guard protects.

Exclusion has to happen at load time, at unit granularity, rather than by
loading everything and filtering the tool list afterwards: a
worker-loaded extension is not tools-only. Its event handlers, tools, and
flags all go live on load, so once a unit has loaded its side effects have
already run and dropping its tools afterwards would leave its handlers and
flags active. Dropping the whole unit before it loads is the only clean
cut — which is also why barrier 3 rejects a colliding unit entirely
instead of suppressing just the offending tool. (A package directory is
handed to pi whole — letting pi's own manifest resolution expand it, so
no-tool companion entries load alongside the tool-bearing ones — only when
the manifest's declared entries are ALL literal relative paths AND the
host loaded every one of them. A glob or override-form entry, or a host
running only a filtered subset, fails that equivalence check and drops the
unit to exactly the entry files the host loaded; that fallback loses the
package's no-tool companion entries, since an entry that registered no
tool cannot be shown to be running.)

The collision barrier runs before a unit loads against the tools in the
host registry. Slate scans the worker registry again after every selected
extension completes `session_start`. A tool registered during startup can
therefore remain eligible when the host selected it, but a startup tool
that shadows a Slate or pi built-in blocks the action. Slate's dispatch
tools do not depend on either scan. `createAgentSession` receives an
`excludeTools` denylist of `thread`, `threads`, and `episode`. Pi applies
the denylist after the allowlist and on every tool-registry refresh.

Slate owns the complete worker extension lifecycle. It waits for
`session_start` before the action. A startup handler failure blocks the
action and enters cleanup. Every terminal path shares one shutdown
operation per worker. That operation emits `session_shutdown` once and
then disposes the session even when a shutdown handler fails. Host cleanup
removes workers from the live set before it awaits their shutdown, so an
overlapping action cannot continue with a session in teardown.

The orchestrator does NOT get the whitelisted tools; orchestrator mode
keeps its restricted set. Instead its doctrine gains a rule listing each
whitelisted extension with its tool names and descriptions, so it knows
what it can delegate. That doctrine rule and the worker allowlists come
from a single memoized resolution per session, so the two cannot drift.

The invariant bought is exactly that: no worker gets Slate's dispatch
tools. It is NOT a general recursion or delegation bound, and the accepted
risks that follow are the operator's to weigh:

- A whitelisted extension that registers its OWN sub-agent or delegation
  tool under any other name gives workers unbounded delegation that Slate
  can neither detect nor bound, outside Slate's episode and cost
  accounting. Whitelisting such an extension is a deliberate operator
  decision.
- Inside a worker a whitelisted extension has the same filesystem and
  credential reach it has in the host; Slate's read-only settings snapshot
  blocks pi-settings writes and nothing else.
- A startup handler can fail. Slate reports the failure, blocks the action,
  and still runs shutdown and disposal.
- Third-party extensions may ignore the abort signal, so their network
  activity can outlive an abort or a context-budget pause.
- Host and worker copies of the same extension share module-level state
  through pi's process-global module cache.
- Provider-native tool billing may escape Slate's worker cost accounting.

Provider registration uses a separate startup boundary from the `workerExtensions` tool allowlist. After pi constructs a worker and realizes its own extension registrations, Slate copies each host extension provider registration whose provider id is absent from the worker registration union. Native and config registrations share one identity for this comparison. A worker registration therefore wins across both forms. Built-in providers are not members of that union, so a host extension can still redirect a built-in provider.

The worker keeps its own model runtime. Sharing the host runtime would couple later mutations and lifetime to the host. Copying before worker construction would compare against an incomplete worker roster. Slate instead copies registrations after construction and before route authentication or a request. A failed copy disposes the session and follows the existing failed-episode path. The check proves registration and composition only. It does not authenticate every inherited provider because an unused provider can be intentionally unconfigured.

This boundary reuses provider functions and can share nested config objects, native provider objects, credential files, authentication callbacks, and third-party module state. It does not copy host provider event handlers. It also does not synchronize host changes after startup. A later partial worker registration can merge with inherited config under pi rules. The merged result can retain inherited credentials while changing an endpoint. The design accepts this risk and adds no late-registration interceptor. Provider extensions that require host event handlers or isolated internal state need their own worker support.

## 6. Runtime knowledge: what the orchestrator knows, and when

The orchestrator's knowledge of these principles is two-tier, following
the load-on-demand discipline the extension itself prescribes:

- **Tier 1 — always loaded.** The doctrine in `mode.ts` is the operational
  distillation of P1–P10, the review discipline defined in
  `review-rules.md`, and a pointer to the focus-area workflow
  that ships with this package (`track-workflow.md` in this directory),
  appended to the system prompt every turn while orchestrator mode is on.

  The size of this always-loaded block matters to the tiering argument. The
  project uses measurements, not assertions. `context-budget.md` owns the
  measurements and the configuration table.

  The logical-model rule has one row for each ordinary logical model. Its raw count depends on the installed documentation path. `context-budget.md` publishes portable production renders and separates runtime rejection boundaries from regression baselines.
- **Tier 2 — on demand.** This document. The doctrine carries a short
  pointer to it (doctrine rule 10); the orchestrator reads it only when
  reasoning about the architecture itself — explaining slate, modifying
  the extension, or making a non-obvious routing/compaction decision.

The same discipline applies to worker guidance. Slate adds its compact
reviewer evidence charter only to reviewer and adversarial thread types.
`prompt-docs.ts` injects configured role guidance (orchestrator via
`before_agent_start`, workers via `appendSystemPrompt`). Defaults are
compiled into `prompt-docs.ts`. Home or trusted project settings supply
documents through the optional `slate.json` keys `orchestratorPromptDocs`
and `workerPromptDocs`. The loader resolves home paths from the agent directory
and project paths from the project root. Each role's always-loaded surface carries only its
own rules; the rest stays on demand.

Injecting this full document every turn would be self-defeating: it would
spend the working memory the architecture exists to protect, and most of
its content (prior-approach analysis, background concepts) is rationale,
not operational instruction. Keeping rationale on demand and rules always
loaded is itself an application of P10.
