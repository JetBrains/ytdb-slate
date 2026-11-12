# Record-write recovery

Read with the common rules.

## Active attempt decisions

Read the owning log across actions and sessions. Unclear or exhausted history pauses.
Ordinary exhaustion leaves recovery retention available. Appends and status keep their rules.
Ordinary sequence requires checked earlier results, or stop evidence for missing results.
Stop evidence is logged user confirmation that the earlier session and all its commands ended, including for an in-process writer, for example after a restart.
Termination requests, tool/command returns, worker claims and missing thread results do not qualify.
No recovery observation, copy, classification or write precedes stop evidence. It covers writers started before it. Later writers follow the ordinary result rule.
Only overlapping exclusive command creations may use the creation exemption. An occupant ends it before classification.

## Active identity and recovery decisions

Logged-edit recovery precedes first-write recovery even if its destination vanished.
Classify current bytes against every eligible identity for the same path before calling them unlogged.
Use the common eligible-identity definition and record-path selector.
Approval identifies approved design bytes and binds replacement, but proves no stored bytes, restoration or successor identity.
Verified-write, successor and adoption identities support evidence, restoration, classification and successors, not replacement. Verified copies exclude successor use. Recovery-only permits classification alone, never binding.
Occupied creation matches only its interrupted attempt's checked expected hash.
Without it, pause even on later approval/task agreement. It grants no other evidence use.
Bound payloads prove only same-attempt authorized replacement arrival, not prior state or successors.
Complete bound arrival: check/log, no overwrite/restore.
Record-only workers check bytes and log agreement. Exit 3 proves no write.
The interrupted operation selects the writer. Baselines and successors stay record-only.
Unknown bytes need checked retention and recovery-only logging before an edit decision acts.
A pre-activation logged verified-write identity counts as a result. Other pre-activation history needs a logged user decision without waiving stop evidence.
Only disagreement between successive observations made after stop evidence was recorded pauses and voids it. A logged/current mismatch prompting recovery does not. Create and preserve exits 4/7 pause without retry and void it.

Unclear or failed append: orchestrator reads its end before retry.
Failed final check: inspect the whole record.
Retry absent text, never present text.
Partial text: append a correction naming the cut-off entry.

Failed or unclear `status.md`: retry a whole rewrite.
A logged interrupted edit stays an edit even when the destination vanishes.
Absent destination: command-creation restoration from a verified eligible source.
Failed or unclear creation: only common command-result retries.
Missing or different preservation copy: leave current unchanged.
Retry preservation only within its checked first attempt + one next-name retry allowance.
Unclear or failed edit: compare with its intended logged copy. Unverifiable copy pauses replacement. Never guess a copy.
If unchanged, retry only the edit.

All design, map and plan writers need operation and attempt entries.
Use common edit-task prerequisites.
The orchestrator decides restoration under recovery, outside the pre-edit barrier.
Adoption requires a common eligible same-record identity, never recovery-only, approval, decision or attempt identities.
Map binding needs its writer's same-attempt report, never a later report or another action. Missing report pauses whole edit recovery for the orchestrator decision, including in-place edits.
Plan edits use common edit-task prerequisites.
Before replacement, restoration or edit retry, command-preserve present bytes in immutable versioned separate regular non-link files beside the record.
Refresh separate-file and restore-source proof immediately before repair, else pause.
Classification grants no replacement. Read these decisions on every exception.

