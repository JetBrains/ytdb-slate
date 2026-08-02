# 001 — User-supplied model profiles (`router.profilesPath`)

**Status:** open, deferred out of the initial router change by
**model-router decision D7** (see the decision-id note in this
directory's README). **Type:** feature.

Let a project add model profiles, or override shipped ones, from its
own configuration — so a model the shipped table has never heard of
can still be routed.

## The problem

Only a model with a profile can become a routing candidate. An
unprofiled entry in the configured model list is warned about by name
and dropped: the router will not invent a tier, a price, or an effort
ladder for a model it has no traced evidence about, because a guessed
profile is exactly the failure mode the research provenance exists to
prevent. ("Effort" here is pi's thinking level: one ladder, two names —
the research directory's README states the equivalence.)

That exclusion already happens at this commit, in the resolver. What it
costs only becomes visible once the dispatch path consumes the resolver
(Track 02), and the cost is a release-cadence coupling: a model
released the day after a Slate release will be unroutable until a Slate
release ships a profile for it, no matter how well the user knows that
model. The user can still name such a model by hand at the session
level, but it will not be able to participate in routing — the feature
would silently not apply to the newest and often most interesting model
on the user's account. Worse, the same holds for models that will never
be in the shipped table at all: an internal, self-hosted, or preview
model that a project has real access to and real measurements for.

So the router's most conservative property — refuse to route what you
cannot trace — becomes its sharpest usability edge, and the user has no
way to supply the tracing themselves.

## Precedent to follow

Slate already has an established pattern for "the project extends
shipped data with its own file", and this should be the third instance
of it rather than a new mechanism:

- `doctrineExtraPath` — project markdown appended to the shipped
  doctrine. Extends, never replaces.
- `reviewPerspectivesPath` — project review charters, each declaring
  its own finding-ID prefix, cited alongside the shipped review rules.

Both are single config keys naming one project file; both are honored
**only in trusted projects**; both fail silently when the file is
missing; and both are additive by construction — the shipped content
is never removed, only layered on. A profiles key should inherit all
of that, including the trust gate: a profile steers which model gets
which of the user's tokens, so it belongs in the same trust class as
the keys that already steer models, prompts, and tool lists.

## Shape of the solution

A `router.profilesPath` key — a third key in the existing `router`
config block, beside `models` and `allowUnmeasuredEffort` — naming one
project file of model profiles, in the same field vocabulary the shipped
table uses. Merge semantics by model reference: an entry for a model the
shipped table does not know **adds** a profile and makes that model
routable; an entry for a model the shipped table does know **overrides**
it, wholly rather than field-by-field, so a user-supplied profile is
never a half-shipped, half-local hybrid nobody can reason about. Read
once, at session start, like the rest of the router's configuration.
Malformed entries dropped individually with a warning, the rest of the
file still applied — the same forgiveness the failover map already
gives.

## Open questions

These are the reason it is not a small change, and they need answers
before implementation, not during. Several are validation questions
about data with no provenance:

- **A user-supplied profile carries no provenance.** Every shipped
  number traces to a source section in the research corpus. A profile
  from a project file traces to nothing checkable. How much trust does
  it get — can it drive a tier boundary, or is it admissible only as
  "routable at this price with this effort ladder"?
- **It carries no `asOf`.** The shipped table's staleness is legible
  because it is dated. Should the key require a date per entry, or per
  file, and what should the router do with an entry whose date is
  older than the shipped table's?
- **Must local data be distinguishable from shipped data?** Two
  surfaces would care. In the resolver's **warnings**, a user debugging
  an odd route needs to know whether the profile that produced it came
  from the package or from their own file — an unmarked override is a
  silent action-at-a-distance bug. In the **doctrine section** Track 02
  is to inject, the orchestrator will be reasoning about the profile
  rows as evidence; if local and shipped rows are indistinguishable
  there, the doctrine's own evidence discipline is quietly weakened, and
  the model cannot express appropriate scepticism about a row it should
  be sceptical of.
- **What is the override blast radius?** Overriding a shipped profile
  can move a tier boundary and therefore change routes for models the
  user never mentioned. Is that acceptable silently, reportable, or
  should tier-driving fields be non-overridable?
- **Validation depth.** Rejecting only malformed shape is cheap and
  admits nonsense (a negative price, an effort level the model does
  not have). Rejecting nonsense means the router encodes opinions
  about plausible values, which is its own kind of guessing.

## Why it was deferred

Deferred, because the initial change has to establish that action-level
routing works at all, and it cannot do that and settle the trust model
for untraced profile data in the same review. The questions above are
about **how much authority unverified data gets** — the same question
the research provenance answers for shipped data, asked again of a
source with no audit trail. Landing a config key first and deciding its
trust semantics later would ship exactly the ungrounded-numbers failure
the tracing rule was written to prevent.

Not dropped, because the release-cadence coupling is real and
permanent: it does not shrink as the shipped table grows, since the gap
is always at the newest model. A router that cannot be taught about a
model the user already has is a router with an expiry date.
