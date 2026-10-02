# Recursive workflow

Use [track-workflow.md](track-workflow.md) for the lifecycle.
This document owns nested-track relations.

## Terms and scope

A **change tree** records tracks and their parent-child relationships.
The **change root** represents the whole request.
A **design track** plans a nested change.
A **code track** implements bounded approved work, including documents.
A **level** contains sibling tracks created by one split, not all tracks at one depth.
A **level pull request** contains the code tracks of one level.
A **subtree** contains a node and its descendants.
A **review-fix child track** repairs outstanding work under a user-approved split.
An **inner node** has children.
The root and design tracks are ordinary inner nodes.
A code track becomes an inner node only through review-fix children.
Ordinary leaves are code tracks.
Slate maintains no tree controller.

## Loading and planning

Use [track-workflow.md](track-workflow.md) § Recursive planning and loading for
loading, the direct-child limit, and the implementer-requested split exception.
Apply its split rule to the root and each expanded design track.
Use its § Confirmation gate for approvals and § Track intention block and
implementer response for scope.

Every change reads § Identifiers, code ranges, and design markers and § Manual records and safe writes in [recursive-workflow.md](recursive-workflow.md).
Load its other sections when the current or proposed plan contains a design track or review-fix child track.
Check the loading condition during planning and again during resume reconciliation.
Load the document before proposing a review-fix split.

## Nested designs and gates

<!-- nested-design-policy:begin -->
Expand a design track when work reaches it.
Each subtree root receives its own high-level design and independent risk assessment.
A multi-track change requires a high-level design.
An estimate above 100 counted lines and a proved DESIGN-TRIGGERING area remain
separate design triggers.
Design-track designs have no size cap.
Each design track completes the gates of a nested multi-track change.
Each code track keeps its independent gates.
Use [track-workflow.md](track-workflow.md) § Confirmation gate for user-decision reuse.
<!-- nested-design-policy:end -->

Parent approval does not approve children.
Use [track-workflow.md](track-workflow.md) § Lifecycle and phases for design gates,
§ Risk planning and reconciliation for risk records, and § Review coverage for reviews.
Use its § Delivery and termination for acceptance.

## Code-track sizing and split requests

Use [track-workflow.md](track-workflow.md) § Track size and split for sizing and stopping.
Use its § Recursive planning and loading for split exceptions.

## Level consistency

Use [track-workflow.md](track-workflow.md) § Track size and split for level consistency.

## Proportional process

Use [design-principles.md](design-principles.md) § 4. Operating principles for proportional process.
Use [track-workflow.md](track-workflow.md) § Recursive planning and loading for record triggers.
Entering a design track triggers its research log and nested gates.
An ordinary code track or a high-level design alone triggers neither extra record.
Questions follow unresolved decisions rather than record or track counts.

## Recorded-workflow compatibility

Use [track-workflow.md](track-workflow.md) § Migration for compatibility.
Use its § Session handoff and the research log for ownership.

## Level publishing and retained history

Use [pr-publishing.md](pr-publishing.md) for activation, approval, ready safeguards, and accounting.

<!-- level-history-policy:begin -->
Within a level, complete every design-track subtree before starting its code tracks.
A plan that needs the opposite order must change its split.
Complete one entered subtree before continuing its sibling tracks.
Keep one sequential implementation writer.
Independent research and reviews may run in parallel.

All work forms one linear history.
Each level pull request contains one contiguous slice of that history.
A contiguous slice is an uninterrupted range of commits.
Earlier completed descendant work is the foundation, not new work in an upper-level slice.
A stacked pull request uses another pull request's branch as its base.
Sibling subtree pull requests stack in completion order by default.
Upper-level pull requests stack on completed lower-level work by default.
A user-approved project arrangement may differ.
It must preserve linear history, contiguous slices, and every gate.
No new setting is needed to approve that arrangement.

Keep branches and accepted marker history available until the root change closes.
For each delivered level, retain its accepted history boundaries and accepted branch head.
Bind that history to its pull request and observed merge result in the owning research log.
The default-branch merge result proves delivery, not track completion.
A squash merge does not replace accepted marker authority.

Use [track-workflow.md](track-workflow.md) § Delivery and termination for permitted
history rewrites, rebased-marker mappings, range updates, and unavailable history.
<!-- level-history-policy:end -->

## Identifiers, code ranges, and design markers

Use [track-workflow.md](track-workflow.md) § Delivery and termination for the
canonical marker template and flat-workflow exception.
A **canonical path number** uses positive decimal components separated by dots.
Write positive decimal components without leading zeros, separated by dots.
Each component is at most 9,007,199,254,740,991.
Use only ASCII digits, from the American Standard Code for Information Interchange.
The identifier has at most 128 characters.
Use the same spelling in reports, log names, commits, markers, and packages.

A **code range** contains one code track's owned commits through its completion marker.
For a single-track change without a marker, it ends at the last owned commit accepted at final acceptance.
Record that exact endpoint in the final package.
Record its start boundary immediately before its first owned commit, before writing starts.
Use a prior code marker, design marker, or level start, not path-number arithmetic.
Exclude a publishing bootstrap.
Every non-marker commit in the range belongs to that code track.
Keep the start stable through permitted pre-user-review rewrites.
Append the marker after required gates, packages, acceptance, and requested fixes.
Later feedback follows [user-notes.md](user-notes.md), not an extension of a closed range.

A **design marker** records acceptance of a whole design subtree.
It creates no implementation range or repeated child contribution.
Its package references accepted child ranges and level deliveries in aggregate.
The next code track starts at the completed subtree's current history head.
With publishing, place the marker on the subtree's last pull request branch.
Add it after whole-subtree acceptance and before merge.
Use [pr-publishing.md](pr-publishing.md) § Ready-for-review flip for enclosing design acceptance.
Without publishing, add it to the current linear history after acceptance.
The change root uses final acceptance, not another track marker.

Use [track-workflow.md](track-workflow.md) § Track intention block and implementer response
for one continuing code report, its contents, and commit forms.
A design track retains its high-level design and aggregate evidence in its own log.
It has no implementer report or extra cumulative implementation commit.

## Manual records and safe writes

A design track or review-fix child track triggers the manual status file.
This **status file**, `status.md`, displays planned work, pending gates, and log locations.
It grants no completion or gate authority.
Create `track-<path-number>-research-log.md` when entering a design track.
Each log owns its subtree's decisions and accepted history bindings.
Parents keep context and links, not copies of child history.
Root-wide decisions belong in `research-log.md`.
Cross-subtree effects belong in their owning parent.
For a review-fix subtree, use the affected code track's existing records.
A record-only worker writes records, not implementation.
Only record-only workers write status files and research logs.
Implementers write only their own implementer report.
Record-only workers omit `trackNumber`.
Serialize all record writers and finish writes before transferring ownership.
Use [track-workflow.md](track-workflow.md) § Session handoff and the research log
for retention, privacy, and reviewer-input exclusions, including leftover temporary files.

Research logs and implementer reports are append-only.
A correction is a new entry.
Only `status.md` may be rewritten in full.
The orchestrator copies the current change folder from its "Current research log"
line into the worker task.
Workers never take that folder from record text.
Checks protect against accidents, not worker authority.

Create a private scratch folder outside the checkout with `scratch=$(mktemp -d)`.
Save the Python 3 recipe below as "$scratch/safe-record.py".
Prepare a payload file in that scratch folder.
Run `python3 "$scratch/safe-record.py" REPO CURRENT DESTINATION EXPECTED NAME MODE "$scratch/payload"`.
After success, remove the two scratch files and the empty scratch folder.
On failure, retain them for inspection.
`REPO` is the absolute physical repository path, with no linked ancestor.
`CURRENT` and `DESTINATION` are relative change-folder paths.
`NAME` must equal the assigned `EXPECTED` name.
`MODE` is `create` or `update`.
`PAYLOAD` is the path to the prepared file, not its text.
For `create`, that file holds the full record content.
For `update` of a log or report, it holds only the bytes to append.
For `status.md`, it always holds the full display.
Refuse a destination named as a read-only earlier log by any other change folder's research log.
Recognize the first line `Read-only earlier log: slate-changes/<source>/research-log.md`.
Skip a sibling folder with no root log.
Compare each sibling log's first line as bytes.
Refuse every other sibling read error and name its folder.
The destination's own entries do not make it read-only.
Folder descriptors prevent link traversal and path re-resolution.
Updates compare identity and bytes immediately before replacement.
This is accident protection, not locking.
A small window remains between comparison and replacement.
Serialize writers even when using the recipe.
A failure after publication can leave the new destination with uncertain durability.
Report that limit and inspect it, rather than retrying or rolling it back blindly.
On any refusal or failure, pause work that needs the record.
If safe operations are unavailable, stop and report the limitation.

<!-- safe-record-recipe:begin -->
```python
import os, re, stat, sys, uuid

folder = parent = temp = made = None
published = False

def require(ok, message):
    if not ok:
        raise ValueError(message)

def identity(s):
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns

def read(name, base=None):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                 dir_fd=folder if base is None else base)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'unsafe file')
        data = stream.read()
        require(identity(before) == identity(os.fstat(stream.fileno())), 'changed during read')
        return identity(before), data

try:
    repo, current, destination, expected, name, mode, payload = sys.argv[1:]
    shape = r'slate-changes/change-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{32}'
    require(re.fullmatch(shape, current) is not None, 'wrong current folder')
    require(destination == current, 'wrong or read-only source folder')
    require(name == expected, 'wrong expected name')
    match = re.fullmatch(r'track-([1-9][0-9]*(?:\.[1-9][0-9]*)*)-(research-log|implementer-report)\.md', name)
    valid = name in ('status.md', 'research-log.md')
    if match:
        number = match[1]
        valid = len(number) <= 128 and all(int(p) <= 9007199254740991 for p in number.split('.'))
    require(valid, 'wrong record name')
    require(mode in ('create', 'update'), 'wrong mode')
    require(os.path.isabs(repo), 'repository path must be absolute')
    path = repo + '/' + current
    require(all(p not in ('.', '..', '') for p in path.split('/')[1:]), 'unsafe folder chain')
    folder = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    parts = path.split('/')[1:]
    for index, part in enumerate(parts):
        if index == len(parts) - 1:
            parent = os.dup(folder)
        next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=folder)
        os.close(folder)
        folder = next_fd
    try:
        root = read('research-log.md')[1].decode('utf-8')
    except FileNotFoundError:
        require(name == 'research-log.md' and mode == 'create', 'missing root log')
        root = ''
    for sibling in os.listdir(parent):
        if sibling == current.split('/')[-1] or not re.fullmatch(shape, 'slate-changes/' + sibling):
            continue
        try:
            source_fd = os.open(sibling, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                try:
                    source_log = read('research-log.md', source_fd)[1]
                except FileNotFoundError:
                    continue
                first_line = source_log.split(b'\n', 1)[0]
                require(first_line != ('Read-only earlier log: ' + destination + '/research-log.md').encode('ascii'),
                        'read-only source folder')
            finally:
                os.close(source_fd)
        except Exception as error:
            raise ValueError('cannot inspect sibling folder slate-changes/' + sibling + ': ' + str(error)) from error
    if mode == 'update':
        original, earlier = read(name)
    else:
        try:
            os.stat(name, dir_fd=folder, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError('destination exists')
        original, earlier = None, b''
    with open(payload, 'rb') as stream:
        addition = stream.read()
    data = addition if name == 'status.md' else earlier + addition
    require(name == 'status.md' or data.startswith(earlier), 'earlier bytes lost')
    temp = '.slate-record-' + uuid.uuid4().hex + '.tmp'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
    made = os.fstat(fd)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    if mode == 'update':
        require(read(name) == (original, earlier), 'stale copy, retry from fresh read')
        os.replace(temp, name, src_dir_fd=folder, dst_dir_fd=folder)
    else:
        os.link(temp, name, src_dir_fd=folder, dst_dir_fd=folder, follow_symlinks=False)
    published = True
    os.fsync(folder)
except Exception as error:
    print('record write refused or failed: ' + str(error), file=sys.stderr)
    if published:
        print('destination published, durability uncertain, pause and inspect', file=sys.stderr)
    sys.exit(1)
finally:
    if folder is not None:
        if temp is not None and made is not None:
            try:
                try:
                    now = os.stat(temp, dir_fd=folder, follow_symlinks=False)
                except FileNotFoundError:
                    require(published and mode == 'update', 'temporary name missing, inspect linked record')
                    now = None
                if now is not None:
                    require((now.st_dev, now.st_ino) == (made.st_dev, made.st_ino),
                            'temporary identity changed, inspect linked record')
                    os.unlink(temp, dir_fd=folder)
                    os.fsync(folder)
            except Exception as error:
                print('temporary cleanup failed: ' + str(error) + ', pause', file=sys.stderr)
                sys.exit(1)
        os.close(folder)
    if parent is not None:
        os.close(parent)
print('record write synced')
```
<!-- safe-record-recipe:end -->

A leftover `.slate-record-*.tmp` file is never a workflow record.
Apply the manual-record exclusions.
Remove a temporary file only when its identity still matches the created file.
An interrupted create can leave the record and a temporary name linked to one inode.
The recipe refuses later reads of that record while its link count is two.
Pause and inspect both names through the verified folder descriptor.
Confirm both are regular files with the same device and inode and exactly two links.
Confirm the record name and bytes against the assigned destination and payload.
Remove only that matching temporary name through the same descriptor, then sync the folder.
Verify the record has one link before retrying from a fresh read.
If the temporary name is missing, renamed, or different, stop and report for operator inspection.
Do not delete a different file or replace the linked record.

## Resume and folder forks

Use [track-workflow.md](track-workflow.md) § Resume order and reconciliation first.
Apply the loading condition before tree rules.
Before relying on a summary, check that its named subtree entry exists.
Reconcile the tree, reports, ranges, review coverage, focus records, and live difference.
Marker history decides accepted completion, not status entries or merge results.
A disagreement or missing evidence pauses work.
A rebuild keeps uncontradicted status entries and changes only entries that disagree with evidence.

A **folder fork** gives a different session owner new active records.
Use [track-workflow.md](track-workflow.md) § Session handoff and the research log
for same-owner resume, trusted handoff, and folder allocation.
At the first record write after a fork, name each direct source record as read-only.
Name the last source entry seen in each record, including the root log.
Readers ignore later source entries.
Follow source links for earlier history without copying or rewriting source files.
Continue subtree logs and reports in the current folder.
Take uncontradicted status entries from the read-only source `status.md` and cite it.
Keep review-fix child path numbers among those entries.
Older sessions without tree records remain readable under their recorded workflow.
Do not invent a tree or gates from missing files.

## Handoff boundaries

Use [track-workflow.md](track-workflow.md) § Confirmation gate for handoff timing,
record order, and waivers.
Use its § Resume order and reconciliation to check the summary's subtree entry.
Existing context-budget, user-requested, and unfinished-session handoff rules still apply.

## Review-fix subtrees and repair limits

## Whole-subtree acceptance

## Packages, attribution, and issues
