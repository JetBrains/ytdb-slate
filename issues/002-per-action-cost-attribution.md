# 002 — Per-action cost attribution

**Status:** open, deferred out of the initial router change (decision
D10). **Type:** observability.

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

That was adequate while a thread ran on one model for its whole life:
the aggregate was the cost of that model doing that work, and the only
lever was the thread's model. Action-level routing breaks the
assumption. Now consecutive actions on the same thread can run on
different models at different effort levels, so the total is a sum over
a mix whose composition is recorded nowhere. Nothing in the episode
record or the thread listing answers either of the two questions a user
will actually ask:

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
  worker-session model switch, and an effort downgrade all mean the
  request and the reality can differ, and it is the reality that
  bills. Compression cost belongs with it and should be visible as
  its own component, since it is charged to a different model than the
  action.
- **Surfaced in the episode header**, next to the existing
  compressor line, so the cost of an action is visible where the
  action's outcome is already read.
- **Surfaced in the thread listing**, so a thread's aggregate is
  decomposable into its actions without opening each episode — the
  listing is where a user goes when a thread looks expensive.
- **Aggregated for the orchestrator**, so the routing rules can be
  evaluated against outcomes rather than argued about. The
  orchestrator makes the routing decisions; it is the one participant
  currently unable to see their consequences.

Sequencing note: the recording is the load-bearing part. Once cost is
on the episode alongside the model and effort actually used, every
surface above is a rendering question. Design the record first.

## Why it matters specifically for this feature

Routing is justified almost entirely on cost: send the cheap
mechanical action to the cheap model, reserve the expensive model for
work that measurably needs it. That justification is a quantitative
claim about money.

**A cost-bounding feature that cannot measure its own savings is
unfalsifiable.** With aggregate-only accounting there is no
observation that could show the router made things worse, so there is
also no observation that shows it made things better — the feature can
only ever be believed or disbelieved. And the router has at least one
known mechanism for making things worse that this blindness hides
directly: a mid-thread model switch cold-starts the prompt cache, and
long threads run overwhelmingly on cache reads, so routing one small
action to a cheaper model can cost more than staying warm on the
expensive one. That is a hazard the routing research names explicitly,
as a policy line in the routing table itself. Per-action cost is the
only way to catch it happening in practice rather than reasoning about
whether it might.

The same data is what would make the shipped profile table
falsifiable in use: prices in the table are traced observations, but
whether a tier assignment pays off on real actions is an empirical
question that needs per-action outcomes to answer.

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
