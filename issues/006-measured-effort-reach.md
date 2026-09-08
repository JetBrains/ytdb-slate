# 006 — Restore measured-effort reach

**Status:** open, deferred from the **reviewer-model-default deletion** by
**reviewer-model-default deletion decision D1**. **Type:** routing doctrine.

The measured-effort obligation does not reach every action in every project.
The action router is Slate's per-action model and effort selection mechanism.
Its doctrine tells the orchestrator to keep review and gate actions on measured
effort levels. The reminder is inside the action-routing rule in
`extension/mode.ts`, in `buildRoutingRule`. That function returns no rule when
the router is not on or when its candidate list is empty. The resolver in
`extension/model-router.ts`, in `resolveModelRouter` after candidate validation,
returns an off resolution when every configured candidate has an unusable
specification. The trusted-project gate is applied at the injection point in
`extension/mode.ts`. An untrusted project therefore receives no routing rule
even when its configuration has candidates.

The resolver check `doctrine-router-off` asserts that every router-off shape is
byte-identical to the default doctrine. It also asserts that the result has no
routing fragments such as `Pick the first candidate`, `route for`, `avoid`, or
`per Mtok` (`verification/resolver-checks.mjs`, section
`doctrine-router-off`). The check `doctrine-untrusted` separately asserts that
an untrusted project with a configured router receives no routing rule
(`verification/resolver-checks.mjs`, section `doctrine-untrusted`).

The deferred reviewer-model-default deletion removes both model-selection and
effort-selection guidance from `docs/review-rules.md`. After that deletion,
the measured-effort obligation remains in `docs/model-routing.md`, under the
measured-level rule. It also remains in the conditional routing rule rendered
by `extension/mode.ts`. The rule is present only for a trusted project with an
active router and a non-empty usable candidate list.

The routing rule tells the orchestrator to read `docs/model-routing.md` only
for an unusual routing decision and to skip it when it is already in context
(`extension/mode.ts`, `buildRoutingRule`). A project with no configured
candidate list therefore has no text that reliably delivers the obligation.
The document exists, but the doctrine does not direct the orchestrator to read
it in that configuration.

The obligation still has a practical effect when the router is off. Slate
builds a synthesised one-candidate resolution from the shipped profile source
in `extension/route.ts`, through the profile source supplied by
`extension/threads.ts` in `routerOffProfiles`. An unmeasured but ladder-valid
effort can then produce a warning and an unmeasured marker. The episode header
renders that marker as `(unmeasured level)` in `extension/episodes.ts`.
The resolver check `route-evidence-gap` covers the warning, the marker, and the
optional refusal when `allowUnmeasuredEffort` is false. This behaviour records
the gap after the action is chosen. It does not deliver the review and gate
obligation before dispatch.

No automated check asserts the deleted wording, the remaining wording, or the
presence of the reminder in the rendered prompt. The existing doctrine checks
assert other properties. `doctrine-router-off` asserts byte-identical
router-off output and the absence of routing fragments. `doctrine-untrusted`
asserts the trust gate. `doctrine-inject` checks that hostile candidate data
cannot forge doctrine structure. `doctrine-budget` checks portable size
limits for rendered doctrine. `route-evidence-gap` checks dispatch warnings,
markers, and refusal behaviour rather than prompt wording.

## Candidate changes

These are candidate shapes, not decisions for this issue:

- Render the measured-effort obligation outside the action-routing rule. This
  would give a router-off session the reminder too.
- Restate the obligation in a document that the doctrine always tells the
  orchestrator to read.
- Accept the gap and state this limit in `docs/model-routing.md`.

A future implementation must choose a shape that preserves trusted-project
boundaries and keeps the doctrine understandable.

## Open questions for a future implementer

- Is the obligation meaningful in a project with no configured candidate list?
- Where should unconditional text live, given the published doctrine size
  budget and the per-turn cost of prompt bytes?
- Can a check assert that the reminder is present without fixing wording that
  authors should be free to improve?
- Should an untrusted project receive any measured-effort guidance?

## Why this was deferred

The user chose to keep the doctrine change limited to deletions. The routing
rules therefore keep one consistent behaviour. The user accepted this reach
gap knowingly.

The deferring change is the **reviewer-model-default deletion**. Its decision
is **reviewer-model-default deletion decision D1**. This decision id is scoped
to that change, as required by `issues/README.md`.

A fix would change doctrine rendering or add prompt text. It needs its own
size grade, design, and approval. This issue records that follow-up instead.
