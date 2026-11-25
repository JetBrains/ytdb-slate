# ytdb-slate 0.21.0

This release changes the default result of the `threads` tool. It also corrects which session `pi --continue` opens after a handoff.

## Highlights

- The `threads` tool now lists every worker thread of the current session, newest first. A worker thread is a separate session that performs one action. The orchestrator is the main session that plans the work, and it calls this tool. A call without parameters never lists a thread of another session. The list has no row limit, and the result has no byte limit.
- The new parameter `parentSession: true` lists the threads of the newest earlier session that has threads. Slate skips a session without threads.
- The parameter `before` still lists older threads from all sessions. It now returns up to 20 threads instead of eight. Slate rejects a call that combines `before` with `parentSession: true`.
- The result now names what it lists. It shows a count for the current session beside the totals for all threads.

## Fixes

- After a handoff, `pi --continue` could open the earlier session instead of the new session. A handoff transfers the work to a new session. Slate now finishes its last write to the earlier session before the new session starts its first turn. Slate then waits up to three seconds until the file system reports a later time than that last write. If this check fails, Slate shows a warning and still starts the new session. In that case, check which session `pi --continue` opened.

## Compatibility

No configuration keys or defaults changed. Saved threads need no migration. A thread that an earlier Slate version saved has no session ID. Such a thread no longer appears in the default list. The orchestrator finds it with `parentSession: true` or `before`. Slate lists at most 20 of these threads in one result. Slate now refuses to create a thread when pi supplies no session ID. An ordinary pi session always supplies one.

The fix does not cover a new session that never starts a run, because such a session has no session file. Issue #621 tracks this case. The wait time was measured on Linux file systems only.

## SDK compatibility

Slate was tested with the pi software development kit (SDK) at version 1.6.0. Pi 1.6.0 remains the minimum supported version.

