# 004 — Add remedies to actionable router warnings

**Status:** open, deferred from the **router warning visibility change**
(draft pull request 123) by the user review on **2026-08-06**.
**Type:** usability.

Make actionable model-router warnings tell the reader how to correct
the condition, rather than stopping after the diagnosis.

## Three warnings stop at the problem

A survey of the model-router warning set found three configuration
faults that name the rejected or dropped value but offer no corrective
action. Their neighbouring warnings now say what the reader can add,
remove or replace.

### Invalid entry during config sanitization

`sanitizeRouterConfig` emits:

> slate: ignoring the router.models entry `<value>`. Reason: `<defect>`.

This warning handles an individual non-string or otherwise invalid
entry while valid entries in the same array survive. The reader can
remove the entry or replace it with a canonical `provider/id` string.
The message names the defect, but it does not state either action.

### Malformed entry during direct resolution

`resolveModelRouter` defensively emits:

> slate: model router: ignoring the router.models entry `<value>`. It is not a canonical "provider/id" model spec. Reason: `<defect>`.

This path exists because the resolver can be called without the config
sanitizer. The reader can correct the spelling and shape to one
canonical `provider/id` value, or remove the entry from `router.models`.
The message explains the required shape but does not turn that
requirement into a remedy.

### Two entries claim the same profile

When an alias or case variant resolves to a profile already claimed by
an earlier entry, the resolver emits:

> slate: model router: `<entry>` and `<first entry>` name the same profiled model. Both resolve to the model profile `<profile id>`. Slate keeps the first entry and drops `<entry>`.

The reader can remove the dropped duplicate. If the spellings were
intentional alternatives, the reader must choose one spelling and keep
only that entry. The warning reports Slate's choice but does not ask the
reader to make the list unambiguous.

## Append one concrete action to each warning

Each warning should end with one short remedy sentence in the register
used by neighbouring configuration faults. Candidate directions are:

- invalid sanitized entry: `Remove this entry, or replace it with a canonical "provider/id" string.`
- malformed resolver entry: `Correct the entry to one canonical "provider/id" string, or remove it from router.models.`
- alias duplicate: `Remove the dropped duplicate and keep one spelling for this model.`

The exact text needs review against hostile values and message caps.
The remedy must not imply that correcting syntax makes a model
routable. A corrected model can still lack a shipped profile, a registry
entry or credentials, and those later checks own their own warnings.

### Worked example from the warning visibility change

The unknown-registry warning gained the pattern these three should
follow:

> slate: model router: `<model>` is not in pi's model registry. Slate drops it from routing. A dispatch to a model pi does not know could only produce a billed failure. Add the model to pi's model registry, or remove it from router.models.

The final sentence names both real actions without weakening the
reason for the drop. It also leaves the model list unchanged only when
the user can make pi register the model.

### Coupled pins and published fragments

Warning prose is not isolated copy. Rewording these strings moves
resolver-check expectations in `verification/resolver-checks.mjs` and
warning fragments published in `docs/model-routing.md`. The sanitizer
warning can also affect any checks that assert session-start config
faults. Each remedy change therefore requires one coordinated update
to production text, exact or fragment pins, hostile-input assertions
and the reference table.

That coupling is the cost of the issue. A wording-only patch can leave
the resolver correct while making a verification family fail, or it
can update a check while leaving published diagnostic text stale.

## Questions for a remedy policy

- **Must every warning carry a remedy?** Some model data notes describe
  research gaps no project action can close. A universal rule would
  force false advice onto those notes. The policy may need to apply
  only to configuration faults with a real user action.
- **Should removal be recommended when it is the only remedy?** A model
  absent from the shipped profile table cannot become routable through
  project configuration today. Saying `remove it from router.models`
  is accurate, but it may read as dismissing a model the user expected
  Slate to support.
- **How many alternatives belong in one warning?** Correcting an entry
  and removing it are distinct actions. Listing both is useful, but
  every extra clause consumes the warning's total length cap and can
  bury the primary diagnosis.
- **Should alias cleanup prescribe canonical spelling?** The resolver
  knows the profile id, but an alias can itself be a valid registry id.
  It may be safer to say `keep one spelling` than to claim that one
  spelling is universally canonical.
- **Where should remedies be tested?** Exact strings prevent accidental
  wording drift but make prose improvements expensive. Semantic pins
  can require the action words and target key while permitting harmless
  edits.

## Why the remedies were deferred

The router warning visibility change already reclassified every warning,
rewrote their prose, added filtering, and rebuilt the published warning
baseline. The user review for draft pull request 123 on 2026-08-06
deferred a second wording pass over configuration faults.

Adding these remedies would have moved production strings, resolver
pins and documentation fragments after that baseline had stabilised.
The unknown-registry remedy demonstrated the desired shape, but applying
the policy to the remaining warning set requires deciding where the
policy stops. That decision is broader than correcting one omitted
sentence.

The issue remains open because the three warnings are actionable now.
A reader should not have to infer from resolver internals whether to
repair, replace or remove the entry that Slate rejected.
