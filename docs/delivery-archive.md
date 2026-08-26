# Delivery archive procedure

This document is the sole authority for delivery archive operations. Read it completely
before taking any archive action. Follow every refusal and reporting rule.

The lifecycle policy remains in [track-workflow.md](track-workflow.md). That policy
decides whether delivery or abandonment requires this procedure. This procedure never
creates a waiver or authorizes worktree cleanup.

## Attempt boundary and inputs

One fresh worker thread performs one bounded attempt. Only the orchestrator may schedule
another attempt.

The task provides the fixed absolute package-resolved path of this document. It also
provides one variable value named `corpusSession`. Accept no caller-selected procedure
path, working-log path, destination path, ordinal, project path, or retry state.

Refuse the attempt unless `corpusSession` passes the shipped
`isMintedSlateSessionName` validator. The value must use ASCII and at most 48 UTF-8
bytes. It must have the form
`<shipped-adjective>-<shipped-noun>-<four lowercase hexadecimal digits>`. The adjective
and noun must occur in Slate's shipped mint tables.

Report any refusal as a failure. Name the failed step and reason. Do not start a second
attempt in this thread.

## Path and process rules

Use direct process calls with argument arrays. Do not interpolate a path into a command
string. Pass each path as one argument.

One shell path rule applies if a shell command must use a literal path. Assign the path
to a variable with a literal single-quoted assignment first. Refuse a path containing a
single quote because that assignment cannot represent it. Use double quotes around every
later variable expansion. Build a path from an environment variable only through a
double-quoted expansion. Do not place a tilde inside a single-quoted assignment.

Reject an empty path, a nonabsolute path where an absolute path is required, or a path
containing a control character. Use no-follow operations for every named archive
boundary. Before any mutation, refuse if the runtime lacks any required primitive.
Required primitives are no-follow file opens, retained directory descriptors,
descriptor-relative operations, and device-and-inode identity comparisons. Do not fall
back to a pathname-based copy.

A symbolic link above the canonical corpus root may represent the agent directory. Do
not follow a symbolic link at or below that root. Refuse a symbolic link at the project
directory, session directory, `session.json`, `deliveries`, selected ordinal, or
archive-file boundary.

## Derive and capture the source

Start from the worker session working directory. It may be below the change worktree
root.

1. Clone the worker environment for the Git child. Remove `GIT_DIR`,
   `GIT_COMMON_DIR`, and `GIT_WORK_TREE` from that child environment.
2. Run this command with the worker working directory as the child working directory.
   Pass the arguments without shell interpolation:

   ```text
   git rev-parse --path-format=absolute --show-toplevel
   ```

3. Require a successful exit and one nonempty output line. Remove only Git's single
   trailing output terminator. Reject a missing terminator, remaining line terminator,
   extra output, control character, or nonabsolute result.
4. Canonicalize the result. Require that the canonical result names an existing
   directory. This directory is the worktree root.
5. Derive exactly `<worktree root>/research-log.md`. The task must not supply or alter
   this path.
6. Open the source with read-only, no-follow, and nonblocking semantics. Refuse an open
   failure. Validate regular-file status through `fstat` on that same descriptor. A
   symbolic link, directory, device, socket, or FIFO is not a valid source. Successful
   reading through the descriptor establishes readability.
7. Read every source byte through that descriptor. Keep the captured bytes as the
   source snapshot. Compute their SHA-256 hash. Do not read, stat, resolve, or reopen the
   source pathname after the open.

Never write, truncate, rename, unlink, or remove the source. The working log survives
both success and failure. A source change during or after capture can make the snapshot
stale. Do not reread the source pathname to refresh this attempt.

## Resolve the corpus project and session

Resolve the archive location only after the source snapshot succeeds.

1. When `PI_CODING_AGENT_DIR` is set, use its value as the Pi agent directory.
   Otherwise derive the agent directory as `$HOME/.pi/agent`. Refuse an empty or
   unavailable required environment value.
2. Form `<agent directory>/ytdb-slate/projects`. Resolve that corpus-root input once to
   its canonical absolute path. Refuse failed resolution, empty output, a nonabsolute
   result, or a result that is not an existing readable directory. Open and retain a
   descriptor for the canonical corpus root.
3. Derive the project key from the canonical worktree root. Run the following Git
   operation with the same cleared child environment and direct argument handling:

   ```text
   git -C <canonical worktree root> rev-parse --path-format=absolute --git-common-dir
   ```

   Apply the same exit, terminator, extra-output, control-character, and absolute-path
   checks used for worktree-root output. Hash the captured Git common-directory value
   with SHA-256. The project digest is the first 12 lowercase hexadecimal characters.
4. List the canonical corpus root. Consider every entry whose name ends in
   `-<project digest>`. Refuse any matching entry that is a symbolic link or is not a
   directory. Refuse zero matching directories. Refuse several matching directories.
   Open the sole project directory relative to the retained corpus-root descriptor with
   directory and no-follow semantics. Retain that project descriptor.
5. Resolve `corpusSession` as one child name beneath the retained project descriptor.
   Open it with directory and no-follow semantics. Refuse absence, a symbolic link, a
   non-directory, or any resolution outside the selected project. Retain the session
   descriptor.
6. Open `session.json` relative to the retained session descriptor with read-only,
   no-follow, and nonblocking semantics. Validate regular-file status through that
   descriptor. Read the metadata only through the opened descriptor. Refuse unreadable
   or malformed JSON. Refuse a value that is not an object. Refuse unless its `name`
   property is a string exactly equal to `corpusSession`.

Perform every check in this section before creating any path.

## Select one ordinal

The archive parent is `deliveries` beneath the retained session identity.

1. Inspect `deliveries` relative to the retained session descriptor without following
   it. If it exists, require a real directory and open it with directory and no-follow
   semantics. Retain that descriptor. List its entries exactly once.
2. If `deliveries` is absent, treat the one listing as empty. Do not perform repeated
   existence tests while choosing an ordinal.
3. Treat every name present in the listing as occupied for its matching ordinal. Its
   type, contents, completeness, and origin do not matter. A partial or replaced ordinal
   remains occupied.
4. Choose the lowest absent three-digit ordinal from `001` through `999`. Refuse
   exhaustion before creating anything.
5. If `deliveries` was absent, create it relative to the retained session descriptor
   with mode `0700`. Creation must fail when an entry now exists. Record its absolute
   path immediately after successful creation. Open the created directory with directory
   and no-follow semantics. Retain that descriptor. A creation collision ends the
   attempt.

The captured listing is the only ordinal-selection listing in this attempt. Add no
lock.

## Retain and recheck identities

A descriptor type check alone is insufficient. When opening each project, session,
`deliveries`, ordinal, or destination identity, record its device and inode from the
opened descriptor. Retain the descriptor and its recorded identity.

Recheck each retained child through a no-follow inspection or reopen of its named entry
relative to its retained parent descriptor. Require the entry to exist and to have the
expected file type. Compare its device and inode with the values recorded from the
retained child descriptor. Refuse absence, a type mismatch, or either identity mismatch.
Never substitute the rechecked entry for the retained descriptor. Perform every child
operation through the retained parent or child descriptor, not through the rechecked
pathname.

Recheck the complete retained chain that then exists immediately before destination
creation. Recheck it immediately after destination creation and before writing. Recheck
it after the write and flush, before reading bytes for verification. Recheck it after
verification and immediately before success reporting. Opening or creating a retained
child requires an immediate first check. A failed recheck follows the non-destructive
failure disposition below.

## Create and verify the destination

The destination is
`<session directory>/deliveries/<ordinal>/research-log.md`.

1. Create the selected ordinal directory relative to the retained `deliveries`
   descriptor with mode `0700`. Use an exclusive directory-relative operation. Refuse
   any existing entry, including a symbolic link or partial ordinal. Record the absolute
   ordinal path immediately after successful creation.
2. Open and retain the new ordinal directory with directory and no-follow semantics.
   Create `research-log.md` relative to that retained parent descriptor. Use read-write,
   create, exclusive, and no-follow flags with mode `0600`. Refuse any collision. Record
   the absolute destination path immediately after successful creation.
3. Validate regular-file status through the opened destination descriptor. Write the
   captured source bytes completely through that descriptor. Treat a short write as a
   failure. Flush the file before verification.
4. Seek the same opened destination descriptor to the start. Read every destination
   byte through that descriptor. Do not reopen or verify through the destination
   pathname.
5. Compute SHA-256 over the bytes read from the opened destination identity. Require an
   exact byte match and a hash match with the captured source snapshot.
6. Apply every timed retained-chain recheck above. The final recheck must prove that
   each parent entry and `research-log.md` still names the recorded device and inode of
   its opened descriptor. A rename, replacement, absence, type mismatch, or identity
   mismatch fails the attempt.

Do not publish or report a destination as successful before every verification step
passes.

## Failure disposition

A collision or any other failure ends this bounded attempt. Close opened descriptors.
Closing a descriptor is the only cleanup action.

Do not unlink, rename, truncate, rewrite, or remove any file or directory after failure.
This rule covers every path created by the attempt. It also covers partial artifacts,
renamed artifacts, replacement entries, and pre-existing content. There is no
empty-directory exception and no rollback path.

Maintain an append-only list of paths created by the attempt. A failure report must
contain:

- the failed step.
- the reason.
- the selected ordinal, when selection completed.
- every absolute path that the attempt created, in creation order.

Report `none` when the attempt created no path. Report an original created path even
when another actor later renamed or replaced its entry. Never remove the replacement.

Every ordinal present in a future listing is occupied. A collision is also occupied.
The worker must not resume, repair, overwrite, or remove a failed ordinal. The
orchestrator may schedule one new thread after reviewing the report. That fresh attempt
resolves every identity again, takes one fresh listing, and selects the lowest ordinal
that is then free.

## Success report

Success requires the verified opened destination identity. Report exactly these archive
results:

- the absolute destination path.
- the selected ordinal.
- the one shared lowercase SHA-256 hash.

The shared hash is the matching hash of the captured source bytes and bytes read from the
opened destination descriptor. A missing result leaves the archive action incomplete.
The archive operation never deletes the working log after success.
