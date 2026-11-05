# Safe record-write command

Appends, status creation/rewrite, design/map edits, preservation retry and restoration with edit retry read this introduction and § Record preparation and recovery execution. Command creation, hash logging and successor checks read all. Drafts read only common rules. Reports use generated guidance plus map reads.
The task supplies record permissions and explicit methods under the common change-record rules.
This reference grants no record permission.

## Command contract

Use [safe-record-write.mjs](../extension/safe-record-write.mjs) when the task requires the command.
Only the assigned worker runs the command.
Orchestrator mode has no shell tool.
The comment block at extension/safe-record-write.mjs:2–62 owns the command contract.
This reference maps that contract to the common record rules.
Preservation remains inactive until replacement and recovery are delivered.
Command source and help are not required reads.

## Invocation

Run `node COMMAND create -- SOURCE DESTINATION` for assigned new designs, maps and plans.
COMMAND is ../extension/safe-record-write.mjs relative to this reference.
SOURCE is the assigned payload or verified successor source.
DESTINATION is the exact assigned record path.
For the first creation and every retry, add `--expected HASH` before `--` when the task holds a logged or approval hash of SOURCE.
For successors, always supply the applicable identity defined in change-records.md.
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
The inactive preservation syntax is `node COMMAND preserve [--expected HASH] -- SOURCE DESTINATION`.
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
Inactive preservation requires verified creation, complete equality, stable separate source and destination identities, successful closes and retainedVerified true.
Occupied preservation can establish retention only with complete equality, stable separate identities, successful closes and any expected hash agreement.
Occupied preservation has writeState not-created and never proves new creation.
A same-path or hard-link alias cannot establish separate retention.
Retention identifies observed bytes, not logged evidence or design approval.

## Operation and exit routes

The table maps every operation-and-exit pair to exactly one common route class.
Check that every operation and exit key occurs exactly once and only defined classes appear.
Use only accept, retry creation, pause occupied, pause identity and pause unknown.
Report exactly one class and the operation’s proof fields.
Accept requires all operation-specific proof above, not exit 0 alone.
Known exits 2, 5, 6, 8, unavailable exclusive creation and a command that cannot run take precedence.
For create, a missing or invalid command report or a signal means retry creation with the same expected hash.
Other unclear command results mean pause unknown.
A worker report with no defined class, several classes or accept without the required proof means pause unknown.
A rejected pair is pause unknown, never success.
I/O means input/output.
An unsafe leaf is a symbolic link or a nonregular final path component.
Unsafe leaves, including destination links, pause rather than retry.

| Operation | 0 ok | 2 usage | 3 occupied | 4 different | 5 identity | 6 io | 7 changed | 8 unsafe-file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| create | accept | pause unknown | pause occupied | retry creation | pause identity | pause unknown | retry creation | pause unknown |
| compare | accept | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown |
| hash | accept | pause unknown | pause unknown | pause unknown | pause identity | pause unknown | pause unknown | pause unknown |
| preserve | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown |
| invalid | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown | pause unknown |

For command results, only retry creation permits another exclusive creation from the assigned source.
A retry keeps any supplied expected hash.
There is no creation-retry cap.
Usage, unavailable exclusive creation, I/O and unsafe leaves pause rather than retry.
A command that cannot run also pauses.
For pause occupied and pause unknown, report the result for the common exception triggers.
Log appends, status rewrites, `cp -n` copies and existing edit retries keep their own rules.
Occupied equality never proves creation. Never log exit 3 as a write identity.
Preserve is pending and inactive. Every preserve cell means pause unknown.
Pending grants no classification or next-name permission.
Only later preservation has bounded next-name retry.
A logged interrupted edit stays an edit even when the destination vanishes.
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

Before an action’s first record write, copy current bytes to an action-folder start file, empty for a new record.
Write each payload to a separate temporary file there.
Append with `>>`.
Copy the temporary file for status creation or rewrites.
Use the assigned command for new designs, maps and plans.
With `cat` and `cmp`, require the log/report to equal its start copy followed by every appended temporary file in order.

Authorized preservation retry: `cp -n` at the next unused versioned name, then `cmp`.
Failed or unclear design/map edit: `cmp` against the intended retained version matching its logged full hash.
The orchestrator decides restoration under recovery, not the pre-edit barrier.
Immediately before copying, run `node COMMAND hash --expected HASH -- SOURCE`.
COMMAND is ../extension/safe-record-write.mjs relative to this reference.
SOURCE is the intended restore source. HASH is its logged full lowercase SHA-256 hash (64 hexadecimal digits).
Quote paths and escape embedded quotes.
Agreement requires exactly one valid JavaScript Object Notation (JSON) report, process exit 0, operation hash, code ok, stage complete, writeState not-created, expected agreed, sourceHash equal to HASH, equal null, destinationHash null and retainedVerified false.
protections has exactly exclusiveCreate, noFollowOpen, nonblockingOpen and mode0600, each applied, unavailable or not-applicable.
No report or HASH: pause unknown. Else report accept on agreement, pause identity on identity mismatch (exit 5), else pause unknown. Copy only on agreement.
On agreement, `cp`, check complete equality with `cmp`, then retry the authorized edit.
If the intended copy cannot be verified, pause replacement. Never guess another numbered copy.
