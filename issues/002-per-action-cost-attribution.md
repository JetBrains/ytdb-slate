# 002 — Per-action cost attribution

**Status:** open, deferred out of the initial router change by
**model-router decision D10** (see the decision-id note in this
directory's README). **Type:** observability.

Record and surface what each routed action cost, instead of only what
a thread cost in total.

## The problem

Cost is **aggregated, never attributed**. An action's own spend is
computed while it runs and shown in its live progress output, but it is
only summed into running totals — the orchestrator's own spend, worker
spend, and the carried-across-handoff figure — and it is not persisted
with the episode. When the action ends, the number is gone. A thread
that ran nine cheap mechanical actions and one expensive architectural
one leaves behind a contribution to one total that cannot be split
back apart.

That is adequate while a thread runs on one model for its whole life,
which is the behaviour at this commit: the aggregate is the cost of that
model doing that work, and the only lever is the thread's model.
Action-level routing breaks the assumption — once the dispatch path
consumes the router (Track 02), consecutive actions on the same thread
will run on different models at different effort levels, and the total
becomes a sum over a mix whose composition is recorded nowhere.
("Effort" is pi's thinking level: one ladder, two names — the research
directory's README states the equivalence.) Neither the episode record
nor the thread listing can then answer either of the two questions a
user will ask:

- **What did *this* action cost?** — the per-action question, needed to
  notice that one routing decision is responsible for most of a
  thread's spend.
- **Did routing save money?** — the aggregate question, which requires
  knowing what the same actions would have cost unrouted, and
  therefore requires per-action data to compare against.

Both are currently unanswerable, and the second is unanswerable even
in principle from what is stored today.

## What would have to change, conceptually

Cost becomes a property of the **episode** rather than only of the
thread. Every episode already is the durable record of one bounded
action; it should also record what that action consumed, next to the
routing decision that produced it:

- **Cost per episode**, recorded alongside the model and the effort
  level *actually used* — not the level requested. Failover, a
  worker-session model switch, and (once Track 02 lands) a routing
  decision or an effort downgrade all mean the request and the reality
  can differ, and it is the reality that bills. Compression cost
  belongs with it and should be visible as its own component, since it
  is charged to a different model than the action.
- **Surfaced in the episode header**, next to the existing
  compressor line, so the cost of an action is visible where the
  action's outcome is already read.
- **Surfaced in the thread listing**, so a thread's aggregate is
  decomposable into its actions without opening each episode — the
  listing is where a user goes when a thread looks expensive.
- **Aggregated for the orchestrator**, so routing rules can be
  evaluated against outcomes rather than argued about. The
  orchestrator is to make the routing decisions (Track 02); it would
  be the one participant unable to see their consequences.

Sequencing note: the recording is the load-bearing part. Once cost is
on the episode alongside the model and effort actually used, every
surface above is a rendering question. Design the record first.

## Why it matters specifically for this feature

Routing is justified almost entirely on cost: send the cheap
mechanical action to the cheap model, reserve the expensive model for
work that measurably needs it. That justification is a quantitative
claim about money.

**A cost-bounding feature that cannot measure its own savings is
unfalsifiable.** With aggregate-only accounting there is no observation
that could show the router made things worse, so there is also no
observation that shows it made things better — the feature can only
ever be believed or disbelieved. And the router has at least one known
mechanism for making things worse that this blindness would hide
directly: a mid-thread model switch cold-starts the prompt cache, and
long threads run overwhelmingly on cache reads, so routing one small
action to a cheaper model can cost more than staying warm on the
expensive one. That is a hazard the routing research names explicitly,
as a policy line in the routing table itself. Per-action cost is the
only way to catch it happening in practice rather than reasoning about
whether it might.

The same data is what would make the shipped profile table falsifiable
in use: prices in the table are traced observations, but whether a tier
assignment pays off on real actions is an empirical question that needs
per-action outcomes to answer.

## Open questions

Answer these before implementing; several change the record's shape, so
guessing them costs a migration:

- **What is the comparison baseline?** "Did routing save money?" needs
  a counterfactual — what the same actions would have cost unrouted.
  Re-pricing the observed token counts against another model's rates is
  arithmetic, but it ignores that a cheaper model may need more turns
  for the same action, which is the whole risk. Is a re-priced estimate
  honest enough to publish, or should the feature report only actual
  spend and leave the counterfactual to the reader?
- **Requested effort, actual effort, or both?** Recording only what
  billed loses the fact that a downgrade happened; recording both
  widens the record and needs a rule for what the listing shows.
- **Where does the number live — body or header?** The episode body is
  LLM-compressed and therefore lossy and unparseable; a cost figure
  belongs in deterministic metadata. That is a claim about the record's
  structure and should be settled explicitly rather than by whichever
  is easier to write.
- **How is "not recorded" rendered?** Episodes written before this
  lands have no cost, and a missing cost must never display as `$0.00`
  — that would understate a thread's spend in exactly the aggregate the
  feature exists to make trustworthy.
- **What about spend the accounting cannot see?** Provider-native tool
  billing from a whitelisted worker extension already escapes Slate's
  worker cost accounting. A per-action figure that silently omits it is
  precise and wrong; does the surface need an incompleteness marker?
- **Is a cost figure safe to show the orchestrator?** Feeding measured
  spend back into the model that chooses models is a feedback loop with
  no defined objective — it could as easily produce false economy on
  hard actions as savings. Is the aggregate for the user only, or for
  the doctrine too?

## Why it was deferred

Deferred because it touches the episode record — the durable artifact
every other part of Slate composes on — and widening that record is a
change with its own compatibility story: episodes already on disk have
no cost recorded, so every surface has to render "not recorded" as a
first-class state rather than as a zero. Doing that inside the initial
routing change would mix a persistence-format change into a review
that needs to be about routing decisions.

It is also deliberately second rather than first. The routing
mechanism can be reviewed on its rules and its safety properties
without cost telemetry; the telemetry cannot be designed well without
knowing which routing decisions actually get made and at what
granularity they need attributing. Building the measurement before the
thing it measures has settled risks measuring the wrong unit.

The accepted cost of deferring is stated plainly: until this lands,
the router's cost claims rest on the traced price table and reasoning,
not on observed spend. That is a real gap, and it is the reason this
issue exists rather than being folded into a later release note.
