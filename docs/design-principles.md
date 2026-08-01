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
safety). `extension/model-profiles.ts` additionally cites research TRACE keys
(`G1a`, `GM3`, `O4.2`, `A4b`, …) which ARE in-repo, in `research/`. This document
is the in-repo source for the architecture rationale.

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

- **Thread** — a persistent worker that executes ONE bounded action at a
  time, then pauses and hands control back. Threads are general workers
  serving the system's current intent, not purpose-specific personas. A
  thread accumulates context across its actions, acting as a reusable store
  for one work stream.
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

## 5. Where each principle lives in the code

| Principle | Implementation |
|---|---|
| P1 bounded actions | `tools.ts` `thread` tool contract; doctrine rule 1 in `mode.ts` |
| P2 episodes as sync | `threads.ts` dispatch lifecycle returns an episode per action |
| P3 boundary compression | `episodes.ts` episode compression on action completion |
| P4 context by reference | `tools.ts` `context` parameter injects prior episodes by id |
| P5 adaptive decomposition | doctrine rule 6 in `mode.ts`; no plan structure imposed anywhere |
| P6 natural behavior | `mode.ts` `ORCHESTRATOR_TOOLS` restriction (read-only + slate tools) |
| P7 over-decomposition guard | `worker.ts` recursion guard — load-scoped barriers keep Slate's `thread`/`threads`/`episode` tools out of every worker (recursion-guard note below) |
| P8 per-episode feedback | `threads.ts` synchronous dispatch; episode returned to orchestrator |
| P9 parallelism | `threads.ts` `maxConcurrent` queueing; doctrine rule 2 in `mode.ts` |
| P10 context as RAM | `handoff.ts` context-budget auto-pause + fresh-session handoff |

Repo-local note (not from the report): the `maxConcurrent` cap defaults
to 4. Its failure modes are asymmetric: excess dispatches wait for a
slot (actions on the same thread additionally serialize in dispatch
order), so a low cap costs only latency, while a cap above the
provider's effective rate limits turns rate-limit exhaustion into
FAILED episodes and raises the unattended cost burn rate. Over its
lifetime a slot covers a multi-turn worker conversation followed by its
episode-compression call. The default is sized to cover typical
parallel batches (recon fan-outs, a review wave of a few perspectives)
while staying safe on common consumer API tiers; wider fan-outs only
pay tail latency, and projects with higher-tier keys raise the cap in
`slate.json`.

Repo-local note (not from the report): **action-level model routing**
applies P10's discipline to a second scarce resource. P10 treats
CONTEXT as RAM; the optional `router.models` list treats SPEND the same
way — each dispatched action gets a model and an effort level chosen to
be up to the task and no more, instead of every action inheriting
whatever model the orchestrator happens to be running. It is also a P1
corollary: an action is only a bounded unit if what it may cost is
bounded too, and the closed model list plus a derived (never inflated)
effort level is what bounds it. The two disciplines even share
machinery — pi's compaction settings, which clamp the orchestrator's
context budget, also decide per dispatch whether a worker thread still
fits the model it is routed to, in which case the action moves to the
widest listed model rather than being blocked.

The feature is OFF until `router.models` lists something, and when it
is on the code ENFORCES less than the routing data ADVISES — a
distinction worth keeping straight when reasoning about the
architecture. The dispatch guards refuse an unlisted model, a level off
the target model's ladder and a level the provider rejects outright,
and they warn about an unmeasured level (refusing it only when
`router.allowUnmeasuredEffort` is false). The obligations carried by
the profile data — keeping review and gate actions on measured levels,
and honoring a REFUSE such as `anthropic/claude-fable-5`'s for
zero-data-retention work — are stated in the doctrine for the
orchestrator to honor and are NOT code-enforced guards. Mechanics, the
full guard list and the provenance of the routing data are in
`model-routing.md` in this directory.

Repo-local note (not from the report): the P7 guard was originally
absolute — workers loaded no extensions, so Slate's `thread` tool simply
never existed for them. The optional `workerExtensions` key (`slate.json`,
trusted projects only — see the README config reference) relaxes that: it
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

That collision barrier is best-effort and load-time only: it runs before a
unit loads, against its tools as the HOST registry reports them, and once
more after the load, against the tools the units actually registered — a
post-load collision fails the dispatch CLOSED rather than opening the
worker. Neither pass can see a tool an extension registers only LATER, on
the worker's first turn (a `before_agent_start` handler, say). Slate's own
dispatch tools do not depend on that scan: `createAgentSession` is given
an `excludeTools` denylist of `thread`/`threads`/`episode` that pi applies
AFTER the tool allowlist and re-applies on every tool-registry refresh, so
they can never be active in a worker no matter when or by whom they are
registered — a deferred registration included. A deferred registration
that shadows a pi BUILT-IN (`read`, `bash`, …) has no such gap-closer —
the worker needs the real built-in — so it stays outside Slate's control,
exactly as available to any extension the host session runs. The guard
bounds Slate's dispatch tools, not every tool an extension might register
at runtime.

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
- Worker sessions never fire the session-start event, so an extension
  whose model-scoped tool manager depends on it stays unsynced and may
  offer a tool the worker's model cannot serve — the call simply fails and
  the episode records it.
- Third-party extensions may ignore the abort signal, so their network
  activity can outlive an abort or a context-budget pause.
- Host and worker copies of the same extension share module-level state
  through pi's process-global module cache.
- Provider-native tool billing may escape Slate's worker cost accounting.

## 6. Runtime knowledge: what the orchestrator knows, and when

The orchestrator's knowledge of these principles is two-tier, following
the load-on-demand discipline the extension itself prescribes:

- **Tier 1 — always loaded.** The doctrine in `mode.ts` is the operational
  distillation of P1–P10, the review discipline defined in
  `review-rules.md`, and a pointer to the track-based workflow protocol
  that ships with this package (`track-workflow.md` in this directory),
  appended to the system prompt every turn while orchestrator mode is
  on. With both of its conditional features off, that block — heading
  plus ten fixed rules — measures **2,103 characters / 38 lines**. Two
  CONDITIONAL tail rules grow it when their features are configured:
  worker-extension awareness (one entry per whitelisted extension and
  tool) and action-level routing, whose live model table is **1,819
  characters** for a six-model list — about 963 characters for one model
  plus roughly 150–185 per additional one — taking the whole doctrine to
  **3,922 characters / 56 lines**. As a rough estimate at 4 characters
  per token (no tokenizer was run here, and a dense table is worse than
  prose by that measure) that is ≈525 tokens with both features off and
  ≈980 tokens with routing on for six models — so "a few hundred tokens"
  holds only for the fixed rules, and a configured router roughly
  doubles the always-loaded block. It still covers everything routine
  dispatching needs, and `context-budget.md` puts those figures against
  the orchestrator's token budget.
- **Tier 2 — on demand.** This document. The doctrine carries a short
  pointer to it (doctrine rule 10); the orchestrator reads it only when
  reasoning about the architecture itself — explaining slate, modifying
  the extension, or making a non-obvious routing/compaction decision.

The same discipline applies to consuming-project role guidance:
`prompt-docs.ts` injects per-role guideline docs (orchestrator via
`before_agent_start`, workers via `appendSystemPrompt`). Defaults are
compiled into `prompt-docs.ts`; a consuming project supplies its own
documents through the optional `slate.json` keys `orchestratorPromptDocs`
/ `workerPromptDocs`. Each role's always-loaded surface carries only its
own rules; the rest stays on demand.

Injecting this full document every turn would be self-defeating: it would
spend the working memory the architecture exists to protect, and most of
its content (prior-approach analysis, background concepts) is rationale,
not operational instruction. Keeping rationale on demand and rules always
loaded is itself an application of P10.
