# Track 12 High-Level Design

## Intention

Pi manages conversations with an agent. Slate is a Pi extension that coordinates work across Pi processes.

A durable session is Slate work that remains available after participating processes exit. Canonical state is the authoritative saved information for a durable session.

A same-session process is a process that accesses one durable Slate session. A different-session process accesses another durable Slate session.

A source process is the process that holds the current saved state before handoff. A recipient process is the newly created process that receives a saved copy of the session state.

A recovery process continues an interrupted handoff. A caller is the user or system that starts a handoff.

A handoff is a caller-started operation that saves recipient state for a durable session. Handoff completion means that Slate saves the recipient state, reads it back, and structurally validates it. Completion is information. Completion does not grant ownership.

Structural validation checks the expected fields, types, identities, names, sizes, encoding, and storage paths. It does not assign ownership, detect process activity, resolve conflicts, or enforce lifecycle status.

The caller owns every synchronization attempt and every conflict between processes that access the same Slate session. Slate does not assign or enforce same-session writer ownership. Slate does not preserve overlapping writes or resolve same-session conflicts. Slate does not detect resumed source activity or enforce one writer. Slate does not enforce terminal lifecycle status against later same-session processes.

The caller runs only one handoff process at a time. The caller waits for that process to finish or terminate. After termination, the caller inspects the saved recipient state. The caller may accept that information, request sequential recovery, or abandon the operation. Slate does not coordinate another process for the caller.

Track 12 retains isolation between different durable sessions, structural validation, sequential interruption recovery, and inactive normal startup.

## Goals

- Support new durable sessions whose canonical state survives process exit.
- Preserve the work identity, policy, saved history, costs, modes, and pause state.
- Keep canonical state in one stable external storage location.
- Keep different durable sessions isolated from one another.
- Keep a recipient free of canonical state until the handoff saves recipient state.
- Save recipient state without copying canonical state into a second authoritative namespace.
- Define completion as saved recipient state that Slate reads back and structurally validates.
- Make completion informational rather than an ownership grant.
- Preserve recipient-state safety when recipient state changes during one handoff process.
- Let the caller run one handoff process at a time and wait for its result.
- Support sequential recovery after an interrupted handoff.
- Let a recovery process read saved state, save the next valid recipient state, and receive read-back structural validation.
- Preserve the saved result after a local continuation failure.
- Validate identity, policy, state shape, storage boundaries, and path containment.
- Refuse malformed, replaced, legacy, mixed, or uncertain saved information without changing it.
- Keep normal Pi startup inactive.
- Keep discovery, terminal operations, production activation, public guidance, and integrated validation deferred to later tracks.

## Components

The handoff reader and writer save recipient state in the stable external storage location. The structural validator checks saved data and storage boundaries. The caller supplies sequencing and owns same-session conflicts. The recovery process performs a later caller-selected attempt.

```text
                         [Caller]
                    owns sequencing and
                    same-session conflicts
                             |
                starts and waits for one process
                             v
 [Source process] ----> [Handoff process] <---- [Recipient process]
        |                      |
        |                      | saves recipient state
        |                      v
        |              [Structural validator]
        |                      |
        |                      | reads back and validates
        |                      v
        |           [Stable external namespace]
        |                      ^
        |                      |
        +------------ [Recovery process]

  Different namespaces remain isolated.
  Completion reports information and grants no ownership.
```

The stable external namespace remains authoritative for canonical state and saved recipient state. It does not become a writer-ownership registry.

Explicit Track 12 invocation can reach handoff and recovery behavior. Normal Pi startup keeps Track 12 behavior inactive.

## Approach and data flow

### Keep same-session coordination caller-owned

The caller runs only one handoff process at a time and waits for that process to finish or terminate. The caller owns every synchronization attempt and every same-session conflict.

The caller must prevent branch changes and staged-file changes during the Track 12 commit action. Track 12 does not coordinate with another process changing the same Git worktree during that action.

Track 12 retains the prepared commit message and the one-track-one-commit requirement. Track 12 removes the single-use commit helper and its tests because repeated commit-helper regressions were unrelated to Track 12 runtime goals.

Track 12 does not promise a stable whole-repository coverage percentage before the Track 12 commit exists. Repeated percentage changes unrelated to durable handoff behavior do not determine Track 12 correctness.

The implementation report keeps the exact full-test command, passing-test result, and exit status. It keeps the reason the patch coverage gate has not run. It keeps the requirement to run the patch coverage gate after the commit. The report omits unstable exact pre-commit coverage percentages. Committed patch coverage is the applicable change-specific check.

Slate does not assign or enforce same-session writer ownership. Slate does not coordinate overlapping processes. Slate does not preserve overlapping writes or resolve conflicts. Slate does not detect resumed source activity or enforce one writer. Slate does not enforce terminal lifecycle status against a later same-session process.

A different-session process remains isolated by its own durable namespace. This isolation does not create same-session ownership or conflict enforcement.

### Save and validate recipient state

The caller starts a handoff for a new durable session. The source process supplies the current saved state. The recipient process starts without canonical state or earlier authority information.

Slate validates the selected namespace, identity, policy, record shape, and storage path before writing. Slate saves recipient state in the stable external namespace. Slate reads the saved recipient state back and structurally validates the result.

A successful read-back is handoff completion information. It does not authorize a writer, select a winner, or prevent another same-session process from writing. Slate does not preserve overlapping writes or resolve the resulting conflict.

A malformed, replaced, legacy, mixed, or uncertain record causes refusal without migration, repair, deletion, or reinterpretation. Structural refusal protects namespace and record integrity. It does not enforce ownership or lifecycle status.

### Recover sequentially after interruption

If a handoff process terminates before a usable read-back result, the caller decides whether to request recovery. The caller starts recovery only as a later, sequential process.

Recovery reads the saved state and validates its structure. Recovery may save the next recipient state when the records and storage paths are valid. Recovery reads that state back and structurally validates it. Recovery does not need the interrupted process to run.

Slate does not detect whether the source process resumed. Slate does not protect recovery from a resumed source or another same-session process. The caller owns that risk and the conflict it creates.

A local failure after a valid saved result does not erase or roll back that result. Permanent loss or corruption of the stable namespace may prevent recovery.

### Support only new durable sessions

Track 12 accepts only durable sessions created for Track 12 behavior. Each durable session has one policy and one stable external namespace. Handoff preserves policy, work identity, saved history, costs, modes, and pause state.

Track 12 does not merge, replace, or discard recipient work. It does not create a second authoritative namespace. It does not support or migrate legacy sessions.

### Preserve the plain persisted-data boundary

Slate validates expected fields, types, identities, names, sizes, text encoding, and path containment. It refuses linked, replaced, malformed, oversized, or escaped storage paths.

Track 12 accepts structurally valid saved information without authenticated origin information. Track 12 does not add cryptographic authentication. Refusal leaves saved evidence unchanged.

### Keep Track 12 inactive during normal startup

Explicit Track 12 invocation can reach handoff and recovery behavior. Normal Pi startup cannot create or receive a Track 12 durable session.

Track 12 remains disconnected from normal production behavior. Track 13 remains read-only and informational. Track 14 records lifecycle status as historical information. It may retain the project-writer rule only for a project file shared by different Slate sessions. Track 15 owns public guidance, integration, and verification.

The same-session boundary applies to every later track. A later track may change it only through a new user-approved high-level design.

## Non-goals

- Assigning or enforcing same-session writer ownership.
- Preserving overlapping writes.
- Resolving conflicts between same-session processes.
- Detecting resumed source activity.
- Enforcing one writer.
- Enforcing terminal lifecycle status against later same-session processes.
- Coordinating overlapping handoff or recovery processes.
- Treating completion as an ownership grant.
- Treating a saved terminal status as an access-control gate.
- Verifying or enforcing source-process inactivity.
- Forcing, suspending, or terminating a source process.
- Recovering from a live source process as an automatic decision.
- Supporting or migrating legacy handoffs or sessions.
- Modifying or deleting legacy saved information.
- Activating durable behavior during normal Pi startup.
- Changing normal production behavior.
- Adding discovery, sibling metadata, terminal commands, or terminal enforcement.
- Assigning or enforcing a project writer for one Slate session.
- Changing the project-writer rule for a project file shared by different Slate sessions.
- Adding production integration, public guidance, or integrated verification.
- Supporting participants on different machines.
- Adding locks, leases, revocation, forced shutdown, source selection, prompts, waivers, cleanup, or archive creation.
- Merging, replacing, or discarding recipient work.
- Creating another authoritative storage location during a handoff.
- Adding cryptographic authentication or authenticated provenance.
- Redesigning trust for saved information.
- Changing Pi transcript ownership or storage.
- Adding automatic pruning or a secondary archive.
- Coordinating with another process changing the same Git worktree during the Track 12 commit action.
- Promising a stable whole-repository coverage percentage before the Track 12 commit exists.
