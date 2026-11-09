# Pending preservation and history

## Pending worker contract

### Pending preservation contract

This contract grants no caller permission. Existing shell routes keep their rules.
After activation, use command preservation at an unused versioned name directly beside the record.
Subfolders, temporary start copies, payloads and outside-checkout copies do not count as retention.
Never modify or delete versioned copies. Leave occupied names unchanged.
Fresh success needs operation preserve, exit 0, code ok, stage complete, writeState verified, equal true, equal full sourceHash and destinationHash, retainedVerified true and protections.exclusiveCreate applied.
The command must also complete its stable separate-file checks and successful closes.
Occupied retention needs operation preserve, exit 3, code occupied, stage compare, writeState not-created, equal true, equal full sourceHash and destinationHash and retainedVerified true.
Occupied retention also requires the command's stable separate-file checks and successful closes.
Both forms require exactly one valid report with matching operation, code and process exit.
The protections object has exactly exclusiveCreate, noFollowOpen, nonblockingOpen and mode0600.
Each protection value is applied, unavailable or not-applicable.
These proofs cover distinct unchanged regular non-link files at the final path component.
They do not prove that no third path shares a retained file through a hard link.
Parent links do not form an access boundary.
Windows ordinary opens can miss a same-user link swap and have weaker open and mode protection.
These are accepted limits under the parent non-goal on protection from every file substitution.
Any supplied expected hash must agree with both full hashes and expected agreed.
Ordinary pre-edit preservation supplies the logged stored-bytes identity as the expected hash on its first attempt.
Missing that logged identity pauses ordinary preservation.
Recovery retention of unknown current bytes uses expected not-supplied on its first attempt.
Record the observed full sourceHash from that first attempt as its recovery-only identity.
Before any retry, a record-only worker checks and records that identity in the owning log.
If the first attempt supplies no reliable full identity, pause.
Every next-name retry supplies the identity recorded for its first attempt as its expected hash.
A retry without that identity or with a different identity pauses.
Recovery-only identity grants no stored-write, restoration, successor or content authority.
Unknown current bytes need complete retention before an explicit edit decision acts.
Occupied retention proves no creation, approval or replacement authority.
Neither cmp nor command comparison proves separate retention.
Pending report class retry preservation permits only a bounded next-name attempt.
Known fatal results take precedence. Malformed, absent, duplicate or mismatched reports mean pause unknown.
All active preserve table cells stay pause unknown.

### Pending attempt execution

Operation and creation, edit and preservation attempt entries remain inactive.
After activation, wait for a record-only worker to append and check the operation entry.
Wait for a checked attempt entry before each attempt.
Each writer performs at most one attempt per entry and reports its result.
Entries name the record, operation identity, attempt kind and number, method, destination and expected hash when known.
Keep ordinary preservation and recovery retention counts separate within the same operation.
Each permits one first attempt and one next-name retry.
A missing result consumes an attempt as unclear.
Redispatch and a new session reset neither count.
A fresh check uses command preserve with the existing retained name and that copy's own logged identity as expected hash.
It accepts only exit 3 with the complete occupied proof and both full hashes equal to that logged identity.
Every other result, including exit 0 after a copy vanishes, pauses.
Leave any created bytes unchanged and report them without claiming an attempt-free retention check.
Only an accepted occupied check consumes no preservation attempt.
Only the same interrupted creation's checked expected-hash field supplies its occupied-creation hash.
Never infer that hash from a later task, approval or report.

## Pending history decisions

These rules activate only with replacement and recovery callers.
Operation entries and creation, edit and preservation attempt entries remain inactive.
Existing shell routes stay outside this history contract.

An operation identity joins the record path and its logged creation or edit entry.
A record-only worker appends and checks the operation entry before the operation starts.
That worker appends and checks each attempt entry before its writer runs.
Implementers, fixers and the orchestrator gain no log permission.
Attempt-entry appends require no recursive attempt entries.
Each entry names operation identity, attempt kind and number, method, destination and expected hash when known.
Each entry authorizes at most one attempt.
Read the owning log across actions and sessions.
Missing results consume attempts as unclear.
A new request resets no count.

Allow one preservation attempt and one next-name retry for ordinary pre-edit preservation.
Give recovery retention its own first attempt and next-name retry under the same operation.
Ordinary exhaustion leaves recovery capacity intact.
A fresh check follows the occupied-only method in the pending worker contract.
Only complete occupied proof agreeing with the copy's own logged identity consumes no attempt.
Every other result pauses, including creation after the existing copy vanishes.
Ordinary first attempts require the logged stored-bytes identity.
Recovery first attempts record their observed identity before any next-name retry.
Every retry keeps its first attempt's recorded identity as expected hash.
A missing or different retry identity pauses.
Unknown current bytes require retention before an explicit edit decision acts.
Observed change, including preserve exit 7, pauses and voids any earlier stop evidence.
No next-name retry follows that result.
Unclear or exhausted history and known fatal failure pause.
Exclusive creation retry remains uncapped.
Ordinary log appends and status writes keep their own rules.

Before any new operation or attempt, account for every earlier operation on the record.
An earlier operation lacking a recorded result or stop evidence blocks new work.
No recovery observation, copy, classification or write precedes proof that earlier writers stopped.
A termination request or tool return is not stop evidence.
Unavailable evidence pauses, including an in-process writer.
User confirmation that the earlier session ended permits continuation.
Only overlapping exclusive command creations may use the narrow creation exemption.
An occupant ends that exemption before classification.
Pre-activation operations or missing attempt entries mean unclear history.
Continuation requires a recorded user decision that cannot waive the stopped-writer rule.

The pending retry preservation class permits only an available next-name attempt.
After complete retained proof, accept retention without claiming creation.
Known fatal results precede retry. Unknown reports pause.
Only the checked expected-hash field of the same interrupted creation supplies its occupied-creation hash.
Identity alone grants no content authority.
