Track 12: simplify durable handoff under D363

## High-level design changes

Decision D363 supersedes the narrower D361 and D362 handoff model.

The caller owns coordination between processes that access one durable Slate session.

Slate no longer assigns or enforces same-session writer ownership.

Slate no longer preserves overlapping writes or resolves their conflicts.

Slate no longer detects resumed source activity or enforces one writer.

Saved terminal status remains historical information and cannot block later access.

Handoff completion now has three steps.

Slate saves recipient state, reads it back, and structurally validates the saved state.

Completion reports information and grants no ownership.

A recovery attempt assumes the caller stopped every same-session process.

Different durable sessions remain isolated by identity, name, project, and namespace.

Malformed or incomplete saved data still causes refusal without repair or reinterpretation.

Normal Pi startup still cannot invoke Track 12 handoff behavior.

## Reasons

Earlier implementations added authority decisions, recipient admissions, revision conflicts, and ownership transfer.

Those mechanisms coordinated same-session processes and contradicted D363.

They also created authority staging, witness, and conflict machinery that Track 12 no longer needs.

A single saved state file already provides structural all-or-nothing publication through rename.

Caller-controlled exclusive access makes sequential retry sufficient after interruption.

The stable namespace remains the only location for canonical Slate state.

## Commit low-level design

`extension/session-record.ts` keeps the durable namespace and strict structural decoder.

Its state contains runtime data, historical lifecycle status, informational generation, and last-writer provenance.

Generation and last-writer provenance grant no access and reject no valid writer.

A state save decodes a detached candidate, writes one private staged file, and renames it over `state.json`.

The save then reads the namespace back through the strict structural validator.

The write path performs no generation comparison, ownership check, terminal gate, or same-session conflict decision.

A valid competing write may win before read-back without causing a conflict refusal.

Metadata identity, project identity, current directory, path containment, record schema, encoding, and size checks remain enforced.

`extension/durable-handoff.ts` accepts only a stable namespace reference and recipient state.

It validates the namespace, saves recipient state, reads the result back, and returns completion information.

Recovery runs the same operation later under caller-controlled exclusive access.

The handoff code has no recipient exclusion callback, admission record, witness, decision chain, or ownership transfer.

`extension/runtime-authority.ts` writes Pi bindings with policy, identity, and name only.

A Pi binding locates one namespace and grants no writer status.

`extension/state.ts` accepts valid state regardless of writer provenance, generation order, or lifecycle status.

It still rejects a mismatched durable-session identity, project, directory, malformed state, or unsafe artifact reference.

The in-process mutation permit remains a local memory guard.

It does not synchronize separate processes.

The Track 12 portability job runs the complete save and read-back path on macOS and Windows.

Focused tests cover structural refusal, different-session isolation, sequential retry, and terminated-process recovery.

They also prove that writer changes, terminal history, and valid overlapping writes cause no removed enforcement.

Normal startup does not import the durable handoff modules.
