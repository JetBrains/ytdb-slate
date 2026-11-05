# Record-write recovery

Read with common record rules.

Failed or unclear log/report write: orchestrator reads its end before retry.
Failed final check: inspect the whole record.
Retry absent text, never present text.
Partial text: append a correction naming the cut-off entry.

Failed or unclear `status.md`: retry a whole rewrite.
A logged interrupted edit stays an edit even when the destination vanishes.
Failed or unclear creation: only common command-result retries.
Missing or different preservation copy: leave current unchanged.
Retry preservation at the next unused versioned name.
Failed or unclear design/map edit: use the worker’s intended-logged-copy comparison.
Unverifiable intended copy: pause replacement. Never guess another numbered copy.
If unchanged, retry only the edit.
Otherwise the orchestrator decides restoration under recovery, outside the pre-edit barrier. Require verified restore-source hash before copying.
Occupied creation, even equal: pause for record-only classification.
Until recovery delivers classification, ask the user.
An exit 3 result is never logged as a write identity.
Known exits 2, 5, 6, 8, unavailable exclusive creation and a command that cannot run take precedence.
For create, missing/invalid report or signal: retry creation with the same expected hash.
Then occupied means pause occupied.
Other unclear command results: pause unknown.
Inactive preservation: all preserve operation-and-exit pairs mean pause unknown.
