# Safe record-write command

Appends, status creation/rewrite, design/map/plan edits, preservation and present-record restoration/edit retry read this introduction and § Record preparation and recovery execution. Command creation (including absent-record restoration), hash logging and successor checks read all. Drafts read only common rules. Reports use generated guidance plus map reads.
The task supplies record permissions and explicit methods under the common change-record rules.
This reference grants no record permission.

## Command contract

Use [safe-record-write.mjs](../extension/safe-record-write.mjs) when the task requires the command.
Only the assigned worker runs the command.
Orchestrator mode has no shell tool.
The comment block at extension/safe-record-write.mjs:2–62 owns the command contract.
This reference maps that contract to the common record rules.
Preservation applies to authorized record operations.
Command source and help are not required reads.

## Invocation

Run `node COMMAND create -- SOURCE DESTINATION` for assigned new designs, maps and plans.
COMMAND is ../extension/safe-record-write.mjs, relative to this document.
SOURCE is the assigned payload, verified successor or eligible restore source.
DESTINATION is the exact assigned record path.
For the first creation and every retry, add `--expected HASH` before `--` when the task holds a logged or approval hash of SOURCE.
For successors, always supply the eligible stored-bytes identity in change-records.md.
HASH is that full source identity.
Use the read boundary of its owning log, not another log’s boundary.
Exclude recovery-only, preserved-copy-only and approval-only entries from successor selection.
SHA-256 means Secure Hash Algorithm with a 256-bit result.
A full SHA-256 hash has 64 lowercase hexadecimal digits.
The source identity check precedes the successor folder's first worker record write.
Run `node COMMAND compare -- FIRST SECOND` for complete byte comparison.
FIRST and SECOND name the files to compare.
Run `node COMMAND hash [--expected HASH] -- FILE` for a file hash.
Brackets mark an optional argument and are not literal command text.
The preservation syntax is `node COMMAND preserve [--expected HASH] -- SOURCE DESTINATION`.
Quote every shell path, including COMMAND.
Escape embedded single quotes when using single-quoted shell arguments.
The `--` argument ends option parsing so following paths can start with a dash.

## Reports and proof

Each non-help invocation attempts one JavaScript Object Notation (JSON) report on standard output.
Require exactly one report whose operation, code and process exit agree.
An unknown verb reports operation invalid with usage exit 2 and no file authority.
Any other exit with operation invalid is rejected.
Missing or duplicate reports, invalid fields, unknown field values, wrong operations, mismatched exits, signals and unexpected exits mean unknown write state.
No unknown state grants replacement permission.

The report fields are operation, code, stage, writeState, equal, sourceHash, destinationHash, expected, retainedVerified and protections.
The stage is arguments, source, destination, copy, compare, complete or output.
The first failure keeps its stage.
The writeState is not-created, created-unverified or verified.
Only this invocation's exclusive creation can report either created value.
The equal field is null before completed comparison, otherwise true or false.
Each hash is null or a full lowercase SHA-256 hash.
The sourceHash uses the latest completed read.
The destinationHash requires comparison.
The expected field is not-supplied, not-checked, agreed or differs.
Agreed describes the first hash check, not stability after that check.
Failed expected identity prevents destination comparison.

Every success requires exit 0, code ok and stage complete.
Every success also requires expected agreed when a hash was supplied, otherwise not-supplied.
Creation requires operation create, writeState verified, equal true, equal full sourceHash and destinationHash, retainedVerified false and protections.exclusiveCreate applied.
When supplied, the expected hash must equal both reported hashes.
Report that hash to the record-only logging worker.
The logging worker runs `node COMMAND hash --expected HASH -- DESTINATION` with the reported hash and logs only on agreement.
The logged identity must equal the supplied logged or approval identity when present.
Comparison requires writeState not-created, equal true, equal full hashes, retainedVerified false and expected not-supplied.
Hashing requires writeState not-created, a full sourceHash, equal null, destinationHash null and retainedVerified false.
Fresh preservation requires verified creation, complete equality, stable separate source and destination identities, successful closes and retainedVerified true.
Occupied preservation can establish retention only with complete equality, stable separate identities, successful closes and any expected hash agreement.
Occupied preservation has writeState not-created and never proves new creation.
A same-path or hard-link alias cannot establish separate retention.
Retention identifies observed bytes, not logged evidence or design approval.

## Operation and exit routes

The table maps every operation-and-exit pair to exactly one common route class.
Check that every operation and exit key occurs exactly once and only defined classes appear.
Use accept, retry creation, retry preservation, pause occupied, pause identity and pause unknown.
Report exactly one class and the operation’s proof fields.
Accept requires all operation-specific proof above, not exit 0 alone.
Known exits 2, 5, 6, 8, create exits 4/7, a command that cannot run and unavailable exclusive creation take precedence.
For create, a missing or invalid command report or a signal means retry creation with the same expected hash.
Other unclear command results mean pause unknown.
A worker report with no defined class, several classes or accept without the required proof means pause unknown.
A rejected pair is pause unknown, never success.
I/O means input/output.
An unsafe leaf is a symbolic link or a nonregular final path component.
Unsafe leaves, including destination links, pause rather than retry.

| Operation | 0 ok | 2 usage | 3 occupied | 4 different | 5 identity | 6 io | 7 changed | 8 unsafe-file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| create | accept | pause unknown | pause occupied | pause unknown | pause identity | pause unknown | pause unknown | pause unknown |
| compare | accept | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown |
| hash | accept | pause unknown | pause unknown | pause unknown | pause identity | pause unknown | pause unknown | pause unknown |
| preserve | accept | pause unknown | accept retention or retry preservation | pause unknown | pause identity | pause unknown | pause unknown | pause unknown |
| invalid | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown |

Retry creation permits another exclusive creation from the assigned source. Retry preservation permits only a bounded next-name preservation with unchanged source and reliable first identity.
A retry keeps any supplied expected hash.
There is no creation-retry cap.
Usage, unavailable exclusive creation, I/O and unsafe leaves pause.
A command that cannot run also pauses.
For pause occupied and pause unknown, report the result for the common exception triggers.
Log appends and status rewrites keep their own rules. All design, map and plan callers follow checked history and stopped-writer duties.
Occupied equality never proves creation. Never log exit 3 as a write identity.
For preserve exit 3, complete occupied proof means accept retention, never creation. Unequal occupied bytes permit retry only with checked history, reliable unchanged identity and recovery stop evidence when applicable. Missing proof pauses unknown.
Create/preserve exits 4/7 pause and void stop evidence.
Fresh occupied-only retention checks accept no other result, including exit 0. No new retained file is an attempt-free check.
A logged interrupted edit remains an edit even if the destination vanishes.
Keep explicit edit prerequisites and methods.
Without an earlier failure, exit 7 also covers a changed comparison-pass source hash or a vanished created name.
Report-output failure selects exit 6 and attempts a fixed I/O diagnostic.
A failed diagnostic write after an emitted report keeps the report code and exit.

## Protection observations and bounds

The protections object has exactly exclusiveCreate, noFollowOpen, nonblockingOpen and mode0600.
Each value is applied, unavailable or not-applicable.
Open values describe flags requested in attempted opens, even on refusal.
Protection fields describe attempted opens, not guarantees.
Unavailable remains set after an optional flag falls back or is absent.
Exclusive creation never falls back.
Unsupported exclusive creation reports exclusiveCreate unavailable.
The mode0600 field describes observed created-file permissions, not requested permissions.
Without creation, mode0600 is not-applicable.
Windows reports optional open flags and mode unavailable.
Windows ordinary opens can miss a same-user link swap.
Parent symbolic links are not an access boundary.
Checks provide no atomic snapshot against another process using the same user account.
The command promises no replacement, deletion, cleanup or power-loss durability.
Partial bytes remain.
Help is bounded at 1,024 bytes.
A report is bounded at 2,048 bytes and standard error at 256 bytes, including line endings.
Reports contain no paths or operating-system text.

## Record preparation and recovery execution

Before first write, copy current bytes to an action-folder start file (empty if new). Put payloads in separate files there.
Append with `>>`.
Copy the temporary file for status creation or rewrites.
Use the assigned command for new designs, maps and plans.
With `cat` and `cmp`, check log/report equals start copy plus appended payloads in order.

### Active preservation and attempt execution

COMMAND: ../extension/safe-record-write.mjs relative to this document. Quote/escape paths.
Run `node COMMAND preserve [--expected HASH] -- SOURCE DESTINATION` or `node COMMAND hash --expected HASH -- SOURCE`.
Brackets: optional. HASH: full lowercase SHA-256 (Secure Hash Algorithm, 256-bit), 64 hexadecimal digits.
Require one valid JavaScript Object Notation (JSON) report matching operation/code/exit.
Preserve: equal true, equal full sourceHash/destinationHash, retainedVerified true. Fresh: exit 0, code ok, stage complete, writeState verified, exclusiveCreate applied. Occupied: exit 3, code occupied, stage compare, writeState not-created.
Both need stable separate regular non-link files, successful closes, expected agreed with both hashes if supplied, else not-supplied.
Hash: exit 0, operation hash, code ok, stage complete, writeState not-created, sourceHash HASH, expected agreed, equal/destinationHash null, retainedVerified false.
protections has exactly exclusiveCreate, noFollowOpen, nonblockingOpen and mode0600, each applied, unavailable or not-applicable.
Unproved: pause. Retention grants no creation/approval/replacement.
Use immutable unused versioned names beside the record, not scratch or subfolders. Never change occupants.
Ordinary preservation uses the eligible hash. First recovery retention omits --expected and logs sourceHash as recovery-only before retry.
Each allows first attempt + one next-name retry with first recorded identity as expected. Unreliable identity or unclear/exhausted history pauses.
Entry = one attempt: record, operation (path, checked creation/edit entry), kind, number, method, destination, known expected hash.
Only record-only workers append/check entries. No recursive entries.
Missing results consume attempts. Requests/sessions reset none. Only occupied proof against the copy's logged identity consumes no fresh-check attempt.
Vanished copy, including fresh-check exit 0: pause. Leave created bytes unchanged.
Unequal occupied exit 3 permits an available next-name retry only with unchanged source and reliable identity. Create/preserve exits 4/7: pause as change.
Bad reports pause unknown. Exits 2/5/6/8 precede retries. Creation retries are uncapped, each with a new dispatch/entry.
Proofs cannot exclude a third path sharing the file through a hard link. Final-leaf, parent-link and Windows limits remain.

### Active replacement and recovery execution

Ordinary sequence needs checked results or stop evidence for missing results. Recovery always needs stop evidence, including in-process writers. It covers prior-started writers. Later writers follow ordinary results.
Stop evidence: logged user confirmation that the earlier session and all its commands ended, for example after restart.
Termination requests, tool/command returns, worker claims or missing thread results do not qualify. Only overlapping exclusive creations are exempt until occupied.
Compare regular non-link leaves only with the intended eligible logged restore copy. Never guess.
Repair over present bytes needs command retention and restore-source verification against its own eligible hash.
Separation: non-following `fs.lstatSync(path, {bigint:true})`: regular non-link leaves, distinct dev/ino pairs, unchanged dev/ino, size and mtimeNs across refresh. Else pause.
Prove restore source separate from current/retained changed bytes. Refresh immediately before writing.
Absent destination: pause and report for command-creation restoration.
Unchanged bytes: authorized edit retry only. Complete bound payload arrival: check/log without overwrite.
Otherwise retain changed bytes with checked recovery-only logging before restoration. Check restored bytes before retry.
Before replacement, match design/plan payloads to approval/orchestrator decision. Maps bind to their writer's same-attempt report, never later reports/actions.
Missing map report pauses whole edit recovery, including in-place edits, for the orchestrator decision. Check stored agreement before logging.
Only successive post-evidence observations that disagree pause and void stop evidence, including retry/refresh mismatch or disappearance/reappearance. Create and preserve exits 4/7 pause without retry and void it.
