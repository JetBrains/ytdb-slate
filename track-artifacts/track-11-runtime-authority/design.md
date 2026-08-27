## Goal

Track 11 connects Slate runtime state to the external storage foundation from Track 10.

A Pi session is a Pi-owned conversation runtime and transcript. A persistent Pi session has a persistent Pi session file.

A Slate session is one logical change with one stable Slate name and identifier. The Slate session can later span sequential Pi sessions through explicit adoption.

An external namespace is the durable Slate record outside the canonical current directory. The external namespace is the sole authority for new-policy Slate state.

Canonical Slate state means Slate-owned runtime records and artifacts for the logical change. Pi owns the main Pi transcript and its conversation history.

Persisted Slate evidence is plain data read from Pi or external JSON storage.

A Pi binding record is a non-authoritative association inside a persistent Pi session. The record identifies that Pi session's external namespace.

The Pi binding record holds no competing canonical Slate state. The record also grants no adoption, discovery, or writer-transfer authority.

The canonical current directory is the project work context and continuation guard. The directory does not identify a Slate session or select its namespace.

```text
+-----------------------------+
| Persistent Pi session       |
|                             |
| Pi transcript: authoritative|
| for the conversation        |
|                             |
| Pi binding record:          |
| non-authoritative reference |
+--------------+--------------+
               |
               | identifies
               v
+-----------------------------+
| External namespace          |
|                             |
| Sole authority for the      |
| new-policy Slate session    |
| and its canonical state     |
+--------------+--------------+
               |
               | guarded project work
               v
+-----------------------------+
| Canonical current directory |
| Work context, not identity  |
+-----------------------------+
```

Track 11 delays fresh binding. A fresh Pi session starts without a Slate session, external namespace, or Pi binding record.

The first operation that changes canonical Slate state creates the new relationship. Slate commits the external record before it records the Pi association.

Track 11 restores a bound Slate session from its external namespace. Pi-held data can identify the namespace but cannot replace its state.

Track 11 preserves the historical policy boundary. Legacy Pi-authoritative sessions remain legacy and receive no automatic migration.

## Acceptance criteria

- A fresh persistent Pi session starts without creating a Slate identity, namespace, or Pi binding record.
- A Pi conversation without a canonical Slate mutation remains unbound.
- A read-only Slate action does not bind a fresh Pi session.
- The first canonical Slate mutation creates one new-policy Slate session and one external namespace.
- Slate commits the authoritative external state before it records the Pi association.
- A successful binding keeps one stable Slate name and identifier.
- A persistent Pi session has at most one unambiguous new-policy Slate binding.
- The Pi binding record identifies the namespace but contains no competing canonical Slate state.
- A valid binding restores canonical Slate state only from the external namespace.
- External content, revision, and status always override cached or repeated Pi details.
- Every state-changing operation revalidates the authoritative namespace before it changes state.
- A stale external revision causes refusal instead of a last-writer-wins update.
- A missing, corrupt, linked, mismatched, or foreign namespace causes a visible refusal.
- Slate does not repair such a namespace from Pi-held Slate data.
- Slate does not create a replacement namespace after a restoration failure.
- A current-directory or corpus-project mismatch blocks writable restoration.
- An external terminal status blocks generic runtime mutations.
- Track 11 does not add the terminal commands or terminal workflow.
- Conflicting Pi binding claims cause refusal instead of silent selection.
- A copied or inherited Pi binding record does not authorize a second writer.
- A Pi fork does not perform adoption or writer transfer.
- A failed external mutation leaves canonical state at the last committed external revision.
- A failed external mutation does not leave rejected state active in runtime memory.
- A failed external mutation does not append a successful Pi binding update.
- A Pi binding write failure never rolls back an external commit.
- A Pi binding write failure produces a clear partial-success report.
- A Pi binding write failure creates no Pi-held fallback authority.
- A session or transcript-branch switch discards state from the previously selected context.
- Restoration completes before Slate exposes state for the newly selected context.
- Failed restoration exposes no state from a previous Pi session or transcript branch.
- Transcript-branch movement cannot silently create a second binding for one Pi session.
- Several Pi sessions can use the same canonical current directory without sharing Slate state.
- Each independent Pi session binds to its own distinct external namespace.
- Slate never selects a namespace from the current directory alone.
- Slate does not merge, inject, or overwrite sibling session data.
- Valid legacy Pi state continues under its historical Pi-authoritative behavior.
- Any legacy Slate-state evidence prevents automatic new-policy binding on that lineage.
- Invalid legacy evidence does not make the Pi session appear fresh.
- New-policy runtime behavior does not write full canonical Slate snapshots back into Pi.
- Mixed or ambiguous legacy and new-policy authority causes a visible refusal.
- An ephemeral Pi session receives no automatic-continuation guarantee.

- A Pi context is the active Pi session and branch selection for one action.
- Concurrent first mutations from one unbound Pi session yield one authoritative namespace.
- The losing action cannot update the Pi binding record or visible runtime state.
- An external revision conflict means an attempted commit no longer follows the current authoritative revision.
- Slate never exposes rejected or stale runtime state as current after an external revision conflict.
- Slate restores validated external state before work continues after an external revision conflict.
- Slate becomes unavailable when that restoration cannot establish current external state.
- Work started in an old Pi context cannot alter the active context after a session or branch switch.
- Results from old-context work remain confined to their originating Slate session.
- Malformed legacy Slate evidence causes refusal.
- Slate does not restore an older snapshot from malformed legacy Slate evidence.
- Slate does not treat a branch with malformed legacy Slate evidence as fresh.
- Slate does not migrate malformed legacy Slate evidence.

## Approach

### Keep the authority boundary explicit

Treat the external namespace as the complete authority for each new-policy Slate session. Read canonical runtime state and artifact references from that namespace.

Use the Pi binding record only to locate the expected namespace. Validate the association against the external record before use.

Treat every value repeated in Pi as advisory. The external namespace decides its current revision, status, identity, and content.

Keep Pi authority limited to the main Pi transcript. Keep Slate authority limited to the external namespace.

### Delay fresh binding until real Slate work

Start a fresh Pi session in an unbound state. Do not mint a Slate identity during ordinary startup.

Keep the session unbound during ordinary Pi conversation and read-only Slate use. Define a state-changing operation as an action that changes canonical Slate state.

On the first state-changing operation, create one new-policy Slate session. Publish its initial authoritative state in the external namespace.

Record the Pi association only after the external publication succeeds. The new external namespace survives any later Pi binding failure.

Do not treat legacy evidence, conflicting binding evidence, or a prior off-branch binding as fresh state. Refuse ambiguous authority instead.

### Make every new-policy save external first

Revalidate the bound namespace before each state-changing operation. Confirm the expected identity, project, current directory, status, and current revision.

Commit accepted Slate state to the external namespace. Update the non-authoritative Pi binding record only after that commit.

Never use a Pi snapshot as a recovery source for new-policy state. Never choose Pi data over a newer external revision.

Keep failed candidates out of active runtime state. A refused save leaves the runtime aligned with the last accepted external state.

Preserve externally committed data when the later Pi write fails. Report that the Slate update succeeded but automatic restoration may be impaired.

Honor an existing external terminal status during every mutation check. Leave creation of terminal outcomes to Track 14.

### Restore from one validated relationship

Use the selected Pi context to find its Pi binding record. Require one clear and authorized relationship to one external namespace.

Validate the external namespace before exposing restored state. Refuse missing, damaged, mismatched, terminal-for-write, or unauthorized records.

Load canonical state only from the validated external namespace. Ignore Pi-held canonical snapshots on a new-policy lineage.

Treat session replacement and transcript-branch movement as restoration boundaries. Clear state from the old context before the new context becomes usable.

Keep the old state unavailable when new restoration fails. Do not repair the failure by minting another namespace.

Do not let copied Pi state transfer writer ownership. Explicit adoption will provide the only supported transfer path in Track 12.

### Preserve legacy sessions without migration

Classify historical Slate evidence before fresh binding. A legacy lineage remains under its existing Pi-authoritative policy.

Keep valid legacy restore and save behavior compatible. Do not create a new-policy namespace or Pi binding record for that lineage.

Treat malformed legacy evidence as historical lineage evidence. Apply legacy safety behavior without converting the session into a fresh lineage.

Refuse mixed authority when Slate cannot identify one historical policy. Do not resolve the conflict through automatic migration.

### Isolate same-directory sessions

Bind each independent persistent Pi session to its own Slate session and external namespace. Use stable Slate identity, not directory identity.

Allow several independent sessions to share one canonical current directory. Keep every session's runtime state and artifacts in its own namespace.

Revalidate the canonical current directory as a continuation guard. Do not search by directory to select or merge namespaces.

Keep sibling data outside the active session's working context. Leave advisory sibling discovery to Track 13.


### Race and refusal outcomes

Slate chooses one winner when concurrent first mutations compete from the same unbound Pi session. Only that winner establishes the namespace association and visible runtime state. A losing action leaves the active state unchanged.

An external revision conflict starts restoration from authoritative external state. Work continues only after Slate validates that restored state. Slate becomes unavailable when validation cannot establish the current revision.

Each action stays associated with the Pi context where it began. An old-context completion cannot install state into the active context. Its result remains within the originating Slate session.

Legacy restoration accepts only valid Slate evidence. Malformed evidence causes refusal without fallback to an older snapshot. Slate neither starts fresh nor migrates that evidence.

## Risks

- External namespace damage can remove the only authoritative Slate record.
- Strict refusal can reduce availability when a binding or namespace is damaged.
- A Pi binding failure can leave committed Slate state without automatic restoration.
- Pi can delay persistence of a Pi binding record in a newly created session file.
- An abrupt process exit can therefore lose the automatic association after an external commit.
- A stale in-memory candidate can diverge from external state if failure handling regresses.
- A session switch can leak prior state if Slate exposes data before validation completes.
- A copied Pi file can present a plausible but unauthorized Pi binding record.
- Legacy and new-policy sessions increase compatibility and diagnostic complexity.
- Same-directory sessions can still observe the project writer's incomplete filesystem changes.
- Users can violate the unenforced project-writer rule and modify project files concurrently.
- Unauthorized concurrent namespace writers can still reach the accepted final race window.
- A terminal namespace can receive unauthorized writes if a mutation bypasses revalidation.
- An ephemeral Pi session can leave durable external state without an automatic continuation path.

Slate accepts these risks within the approved overall boundaries. Track 11 must not claim stronger guarantees.

- An abrupt exit can occur before Pi persists the Pi binding record. The external namespace stays valid. The Pi session can lose its automatic association.

- Concurrent first mutations can leave a losing external candidate. That candidate never becomes current through the active Pi session.
- Conflict restoration can make Slate unavailable until authoritative external state validates.
- A context switch can leave old-context work without an active destination.
- Malformed legacy Slate evidence can prevent restoration until a later track provides an approved recovery path.

## Non-goals

- Implementing handoff, adoption, clean-recipient checks, or writer transfer from Track 12.
- Changing policy inheritance during adoption.
- Implementing sibling discovery, project-independent lookup, or post-removal access from Track 13.
- Making discovery metadata authoritative or snapshot-consistent.
- Implementing the namespace-owned research log from Track 14.
- Adding delivery, abandonment, or other terminal commands from Track 14.
- Adding project-writer doctrine or enforcing the project-writer boundary from Track 14.
- Integrating doctrine, public guidance, full acceptance probes, or final verification from Track 15.
- Providing automatic continuation from an ephemeral Pi session.
- Creating a persistent Pi session file for an ephemeral Pi session.
- Migrating legacy Pi state into a new-policy external namespace.
- Repairing missing or corrupt authoritative state from Pi snapshots.
- Treating a Pi binding record as canonical state or transfer authority.
- Supporting branching adoption or parallel mainline writers.
- Coordinating writers through locks, leases, revocation, or forced shutdown.
- Providing filesystem snapshot isolation for same-directory sessions.
- Using the canonical current directory as Slate session identity.
- Changing Pi transcript ownership, storage, history, or fork behavior.
- Implementing discovery-based recovery after a Pi binding failure.
- Prescribing storage fields, runtime classes, lifecycle hooks, or implementation algorithms.
- Defending against malicious same-process extensions, including executable object properties, prototype changes, or modified built-ins.
- Enforcing byte-level canonical JSON or duplicate-name detection before standard parsing.
- Broad runtime performance and memory optimization, which remains deferred.

- Track 13 may locate a namespace for read-only inspection after a Pi binding record is lost.
Discovery does not restore writable continuation or perform adoption.
