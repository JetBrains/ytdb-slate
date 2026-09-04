# Releasing ytdb-slate

Ten steps, numbered 0 to 9, in order. The agent owns most of them. The user owns two: the merge and the publication. Everything that reaches npm or the default branch is the user's act.

Every command block enables fail-closed shell behavior. Do not continue after a failed command unless the applicable recovery branch says to continue.

## How to read this runbook

**Steps may run in separate sessions.** The first real release ran across four agent actions. Nothing carries between them in shell variables, so no step trusts one. Step 0 writes the state file, and every block after it reloads that state, revalidates it, and re-derives the facts it gates on. A block that gates on a registry fact re-reads the registry. A typed word never unlocks anything.

**No step assumes the checkout you happen to be standing in.** This repository is worked in many worktrees at once. Run `git worktree list` to see how many there are now, and do not trust a count written in a document. Every git command names its repository with `git -C`, and every gh command names its repository with `--repo`. The release itself happens in a dedicated worktree that step 9 removes. One checkout is bound, once: step 0 records the checkout it runs in as `REPO_DIR`, and steps 1, 3, 7, 8 and 9 work in that recorded path rather than the current directory. Run step 0 in the umbrella PR branch checkout.

**Some paths have never executed.** They are marked **Untested.** where they appear, and listed under "Untested paths" below. A marked path is reviewed, not proven. Read it before you run it.

**Never set a state value by hand.** If a block stops because a state key is missing or malformed, re-run the step that writes that key. Hand-setting the value is how the first release turned a guard into a formality.

**A state file from an earlier runbook still loads.** An earlier version of this runbook wrote four keys that no step writes now: `PRIOR_VERSION`, `PINNED_AT`, `GIT_COMMON_DIR` and `PROVEN_AT`. The state helper drops such a key on every read, prints one line on standard error saying which key it dropped, and continues. The next `save` writes the state without it. A release that was in flight across that change therefore resumes and can be repaired, and no operator has to edit a state file. Do not add a removed key back.

**`GIT_COMMON_DIR` is gone, and this is why.** The first two removed keys belonged to the removed package-pin step. The third is different. Step 0 recorded the git common directory of the recorded checkout, every later block read the state with `load` and evaluated its output, and `load` exports every key it holds. `GIT_COMMON_DIR` is a name that git itself reads from the environment, so every later git command ran with a git common directory forced by a file, and so did anything else that a block started, including `npm test`. No step and no resume-index row ever read the value. A review of this runbook found both facts, and a fabricated state file naming another repository made every `git -C` call of the gate block that step 8 then carried fail with `fatal: not a git repository`. The field, its writer, its schema entry and its export are removed together, and nothing derives a git directory from the state any more. Each block names its repository with `git -C "$REPO_DIR"` instead, which is what the blocks already did.

**Declare the release once per session.** Run `export SLATE_RELEASE=<version>` before any block after step 0. Step 0 prints that line, and step 0 itself needs no declaration, because it takes the version as an argument. Every later block refuses to run without the declaration and stops if the declaration disagrees with the state behind the pointer. It is the one fact a block cannot derive — which release you mean — and it is never used as evidence for anything else.

## Before you start

Have all of this before step 0. Steps 5 and 7 act in public, and a missing tool or a missing permission is cheap to fix now and expensive to find after publication.

- **Tools on `PATH`:** bash 4 or newer (the blocks use `mapfile`, arrays and `[[ ]]`), git, GNU coreutils, `gh`, `node`, `npm`, `pi`, `tar`, `cmp`, `awk`, `sed`, `grep`, `diff`, `find`, `mktemp` and GNU `timeout`.
- **GitHub:** `gh auth status` reports you as logged in, against the host that serves this repository, with write access to it. Step 7 pushes a tag and creates a release.
- **npm:** the user who runs step 5 has an account that may publish `ytdb-slate` and can answer its two-factor prompt. The agent never needs npm credentials; it only reads the registry.
- **The registry, from this machine:** steps 0, 6, 7 and 8 read <https://registry.npmjs.org>. Step 8 installs the published version from there into an empty throwaway npm package cache, so it accepts no local substitute.
- **The registry address is pinned, not inherited.** Every registry command in this runbook passes `--registry https://registry.npmjs.org/`, and step 8 exports the same address in `npm_config_registry`. npm reads configuration files that a scrubbed environment cannot remove, including a global file, and such a file can point npm at a mirror. An explicit address wins over every configuration file. A machine that can reach the real registry only through a mirror cannot run this runbook as written.
- **A direct connection to the registry, with nothing in the path.** Step 8 requires a direct connection from this machine to <https://registry.npmjs.org>. Three conditions put it out of scope. A configured proxy is the first. A transparent intercepting proxy is the second. A local registry mirror is the third. Each of them can change the bytes or the metadata that this machine receives. Step 8 contains no proxy detection at all, and proxy support is a declared non-goal of this runbook. A proxy is administrator-controlled, so the operator resolves it at their own level and then runs step 8 from a machine with a direct connection.
- **The step 1 verification set:** run it as a normal user, not as root. The ladder needs GNU coreutils. The resolver checks need `pi` and `node`. The writing-reminder integration harness needs its checked command set, including GNU `timeout` with `--kill-after`.

## Release state

State lives outside the repository, so it survives session ends, branch switches and worktree removal:

```
${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/
  current              # one line: the absolute path of the release directory in progress
  <version>/
    release.json       # machine-written release state
    state.cjs          # state loader/writer, written by step 0
    hash.cjs           # tarball hasher, written by step 0
    release-note.md    # release notes, written before step 7
    artifact/          # the inspected tarball, retained until step 9
    registry/          # the tarball downloaded back from npm
    evidence/          # publish log, registry replies, escalation material
    checkout/          # the release worktree, detached at the squash commit,
                       # removed by step 9
```

Keep the whole `<version>` directory until the release closes. Step 9 removes the worktree and clears the `current` pointer; it keeps the evidence.

## Resume index

What each step changes outside this machine, and how to find out whether it already ran. Read this before resuming a release in a new session. Where completion cannot be detected, the entry says so and the answer is to re-run the step — an index that reads as authoritative and is wrong is worse than no index.

| Step | Effect outside the repository | Determine whether it already ran |
| --- | --- | --- |
| 0 | None. Writes the release directory and the pointer. | `release.json` exists and holds your version. |
| 1 | None. | **Not detectable. Re-run it.** A bumped `package.json` shows an edit was made, not that the verification set passed; the runs leave no durable record except the load log, and a passing run yesterday says nothing about the tree today. |
| 2 | The squash merge, by the user. | `gh pr view <PR> --json mergeCommit` reports a commit. |
| 3 | Adds a worktree to this repository. | `release.json` has `SQUASH_SHA`, and `$RELEASE_DIR/checkout` exists. |
| 4 | None. | `release.json` has `TARBALL_SHA256`, and the retained tarball hashes to it. Re-running is refused after the handoff. |
| 5 | **Publishes to npm. Irreversible.** By the user. | `npm view <package>@<version> version --registry https://registry.npmjs.org/` succeeds. |
| 6 | None. Read-only; downloads the published tarball. | **Not detectable, and does not need to be.** Re-running it is the intended way to resolve it. |
| 7 | Pushes a tag and creates a GitHub release. | `git ls-remote --refs origin refs/tags/<tag>` and `gh release view <tag> --repo <repo>`. The block determines this itself before it creates anything. |
| 8 | None outside this machine. It reads the registry, and it installs the published version into a throwaway project outside every checkout. It writes into a throwaway npm package cache and removes that cache at the end. | **Not detectable, and does not need to be.** It stores no result, and running it again is cheap. |
| 9 | Removes the worktree it added. | `git worktree list` shows no path under the release directory. |

Step 5 is the only irreversible step. Step 7 re-derives its gates on every run and detects its own prior completion. Step 8 changes nothing outside this machine, and it may be run again at any time.

## Untested paths

These have never run. Treat any of them as a hypothesis and read the commands before executing them.

- The integrity-mismatch halt in step 6.
- The inconclusive branch and escalation in step 6.
- Every restart state in step 7 except "nothing exists yet".
- The duplicate-version tripwire in step 0.
- Step 8 inside a real release. Its block was rehearsed against the published 0.10.0 on a workstation, and that rehearsal drove the passing path only.
- The load of a state file written by an earlier runbook, inside a real release. The migration rule was rehearsed on a fabricated file carrying the three keys that were removed at that time. `PROVEN_AT`, the fourth removed key, has never been dropped by a measured read.
- Teardown after a failure in step 9.

## Step 0 — the agent starts the release

Run this block in the umbrella PR branch checkout. It records that checkout as `REPO_DIR`, the value is immutable, and step 1 verifies the bumped version there.

Replace every `REPLACE_*` value. The guards reject placeholders, empty values, invalid versions and an invalid PR number.

Re-running this block for the same version is safe: `init` keeps existing state and fails if a value would change. That is what makes a restart in a new session possible.

```bash
set -euo pipefail
PACKAGE='ytdb-slate'
VERSION='REPLACE_VERSION'
PR='REPLACE_PR_NUMBER'
[[ "$VERSION" != REPLACE_* && "$PR" != REPLACE_* ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$PR" =~ ^[1-9][0-9]*$ ]]
TAG="v$VERSION"

# The duplicate-version tripwire. A published version is immutable, so a number
# the registry already serves can never be published and must not start a
# release. The read must succeed: a registry this block cannot read is a
# precondition it cannot check, and it stops here rather than later. **Untested.**
PUBLISHED=$(npm view "$PACKAGE" versions --json --registry 'https://registry.npmjs.org/')
node -e '
const served = JSON.parse(process.argv[1]);
const list = Array.isArray(served) ? served : [served];
if (list.includes(process.argv[2])) throw new Error(`${process.argv[2]} is already published; start again with the next unused patch version`);
' "$PUBLISHED" "$VERSION"

REPO_DIR=$(git rev-parse --show-toplevel)
[[ "$REPO_DIR" == /* ]]
REPO=$(cd "$REPO_DIR" && gh repo view --json nameWithOwner --jq '.nameWithOwner')
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]

STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release"
RELEASE_DIR="$STATE_ROOT/$VERSION"
if [[ -f "$STATE_ROOT/current" ]]; then
  IN_PROGRESS=$(cat "$STATE_ROOT/current")
  if [[ "$IN_PROGRESS" != "$RELEASE_DIR" ]]; then
    printf 'A release is already in progress at %s. Finish it, or tear it down with step 9, before starting %s.\n' "$IN_PROGRESS" "$VERSION" >&2
    exit 1
  fi
fi
mkdir -p "$RELEASE_DIR/evidence" "$RELEASE_DIR/artifact"

cat >"$RELEASE_DIR/state.cjs" <<'CJS'
const fs = require("node:fs");
const nodePath = require("node:path");

const FIELDS = {
  PACKAGE: /^ytdb-slate$/,
  VERSION: /^[0-9]+\.[0-9]+\.[0-9]+$/,
  PR: /^[1-9][0-9]*$/,
  TAG: /^v[0-9]+\.[0-9]+\.[0-9]+$/,
  REPO: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  REPO_DIR: /^\/[^'\n]*$/,
  RELEASE_DIR: /^\/[^'\n]*$/,
  SQUASH_SHA: /^[0-9a-f]{40}$/,
  WORKTREE: /^\/[^'\n]*$/,
  TARBALL: /^\/[^'\n]*\.tgz$/,
  TARBALL_SHA256: /^[0-9a-f]{64}$/,
  TARBALL_INTEGRITY: /^sha512-[A-Za-z0-9+/]+={0,2}$/,
  REGISTRY_INTEGRITY: /^sha512-[A-Za-z0-9+/]+={0,2}$/,
  HANDOFF_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
  REGISTRY_VERIFIED_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
  TAGGED_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
};

// Values that identify the release. Once written they are facts, not settings:
// a different value means a different release, which starts again at step 0.
const IMMUTABLE = new Set([
  "PACKAGE", "VERSION", "PR", "TAG", "REPO",
  "REPO_DIR", "RELEASE_DIR", "SQUASH_SHA", "WORKTREE",
]);
// The reference bytes may be re-derived by a re-pack, but not after the user
// has been handed a command naming them.
const SEALED_BY_HANDOFF = new Set(["TARBALL", "TARBALL_SHA256", "TARBALL_INTEGRITY"]);
// Keys that an earlier runbook wrote and no step writes now. The first two
// belonged to the removed package-pin step. GIT_COMMON_DIR was written, never
// read, and exported into every later block under a name that git itself reads
// from the environment, which forced a git common directory on every command a
// block ran. PROVEN_AT belonged to the removed proof state of step 8, and step
// 8 stores no result now. A release in flight across such a change must still
// load, so a read drops each one, says so, and continues. The next save writes
// the state without them. Nothing reads these values.
const REMOVED = new Set(["PRIOR_VERSION", "PINNED_AT", "GIT_COMMON_DIR", "PROVEN_AT"]);
const reportRemoved = (key) => process.stderr.write(`state: dropped ${key}, which an earlier runbook wrote and no step uses now\n`);

const [mode, statePath, ...rest] = process.argv.slice(2);
if (!mode || !statePath) throw new Error("usage: state.cjs <init|save|load> <state.json> ...");

// The pointer file is a convenience, not an identity. Every read confirms that
// the state found is the state for the release the caller named.
const takeExpected = () => {
  if (rest[0] !== "--expect") throw new Error(`${mode} needs --expect <version> naming the release you are working on`);
  const expected = rest[1];
  if (!FIELDS.VERSION.test(expected ?? "")) throw new Error(`--expect needs a version, got ${JSON.stringify(expected)}`);
  rest.splice(0, 2);
  return expected;
};

const checkIdentity = (state, expected) => {
  const directory = nodePath.resolve(nodePath.dirname(statePath));
  if (state.RELEASE_DIR !== directory) throw new Error(`state names release directory ${state.RELEASE_DIR} but was read from ${directory}`);
  if (nodePath.basename(directory) !== state.VERSION) throw new Error(`release directory ${directory} does not belong to version ${state.VERSION}`);
  if (expected !== undefined && state.VERSION !== expected) {
    throw new Error(`the pointer leads to the release of ${state.VERSION}, but you declared ${expected}; another release is in progress`);
  }
};

const readState = () => {
  if (!fs.existsSync(statePath)) return {};
  const value = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("state file is not an object");
  for (const [key, entry] of Object.entries(value)) {
    if (REMOVED.has(key)) { reportRemoved(key); delete value[key]; continue; }
    if (!FIELDS[key]) throw new Error(`state file has unknown key ${key}`);
    if (typeof entry !== "string" || !FIELDS[key].test(entry)) throw new Error(`state key ${key} is malformed: ${JSON.stringify(entry)}`);
  }
  return value;
};

const parsePairs = () => {
  const pairs = [];
  for (const argument of rest) {
    const at = argument.indexOf("=");
    if (at <= 0) throw new Error(`expected KEY=VALUE, got ${JSON.stringify(argument)}`);
    const key = argument.slice(0, at);
    const value = argument.slice(at + 1);
    if (REMOVED.has(key)) throw new Error(`state key ${key} was removed from this runbook; nothing writes it now`);
    if (!FIELDS[key]) throw new Error(`unknown state key ${key}`);
    if (!FIELDS[key].test(value)) throw new Error(`value for ${key} is malformed: ${JSON.stringify(value)}`);
    pairs.push([key, value]);
  }
  return pairs;
};

const write = (state) => {
  const ordered = Object.fromEntries(Object.keys(FIELDS).filter(key => key in state).map(key => [key, state[key]]));
  fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify(ordered, null, 2)}\n`);
  fs.renameSync(`${statePath}.tmp`, statePath);
};

if (mode === "init" || mode === "save") {
  const expected = mode === "save" ? takeExpected() : undefined;
  const state = readState();
  if (mode === "save") checkIdentity(state, expected);
  for (const [key, value] of parsePairs()) {
    if (key in state && state[key] !== value) {
      if (mode === "init") throw new Error(`refusing to change ${key} from ${state[key]} to ${value}; this is a different release`);
      if (IMMUTABLE.has(key)) throw new Error(`refusing to change ${key} from ${state[key]} to ${value}; it identifies this release. If it is genuinely different, this is a different release: start again at step 0 with a new version.`);
      if (SEALED_BY_HANDOFF.has(key) && "HANDOFF_AT" in state) throw new Error(`refusing to change ${key} after the handoff at ${state.HANDOFF_AT}; the user was given a command naming the recorded bytes`);
      process.stderr.write(`state: ${key} ${state[key]} -> ${value}\n`);
    }
    state[key] = value;
  }
  if (mode === "init") checkIdentity(state, undefined);
  write(state);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
} else if (mode === "load") {
  const expected = takeExpected();
  const state = readState();
  checkIdentity(state, expected);
  for (const key of rest) {
    if (REMOVED.has(key)) throw new Error(`state key ${key} was removed from this runbook; nothing needs it now`);
    if (!FIELDS[key]) throw new Error(`unknown state key ${key}`);
    if (!(key in state)) throw new Error(`state key ${key} is not set; re-run the step that writes it`);
  }
  for (const [key, value] of Object.entries(state)) process.stdout.write(`export ${key}='${value}'\n`);
} else {
  throw new Error(`unknown mode ${mode}`);
}
CJS

cat >"$RELEASE_DIR/hash.cjs" <<'CJS'
const crypto = require("node:crypto");
const fs = require("node:fs");
const bytes = fs.readFileSync(process.argv[2]);
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
process.stdout.write(`${sha256} ${integrity}\n`);
CJS

node "$RELEASE_DIR/state.cjs" init "$RELEASE_DIR/release.json" \
  PACKAGE="$PACKAGE" VERSION="$VERSION" PR="$PR" TAG="$TAG" \
  REPO="$REPO" REPO_DIR="$REPO_DIR" RELEASE_DIR="$RELEASE_DIR"
printf '%s\n' "$RELEASE_DIR" >"$STATE_ROOT/current"
printf 'release state: %s\n' "$RELEASE_DIR"
printf 'run this once in every session that continues this release:\n\n  export SLATE_RELEASE=%s\n' "$VERSION"
```

Every later block opens with the same five lines. They name the release, read the pointer, load the state, and stop if a required key is absent or if the state belongs to a different release:

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" VERSION)
eval "$STATE"
```

`SLATE_RELEASE` is the one thing no block can derive: which release the operator means. It is a declaration of intent, never carried evidence — a block that does not see it refuses to run, and a block whose declaration disagrees with the state behind the pointer stops rather than acting on the wrong release. Export it once per session; step 0 prints the line.

## Step 1 — the agent prepares the umbrella PR

Bump only `version` in `package.json`. Change no settings file. A release moves no pin in the checkout that step 0 recorded: its `.pi/settings.json` names the local `../../main` worktree and holds no registry entry for slate. Other checkouts of this repository are a different matter, and most of them still carry an `npm:ytdb-slate@<version>` entry that names an earlier release. Step 8 states what those entries do and do not prove. Step 8 installs the published package in a throwaway project instead. The load check below asserts the shape of that settings file, so this step does not repeat it. Follow `docs/pr-publishing.md` through the ready flip. Do not publish from the PR branch.

This block works in `REPO_DIR`, the checkout step 0 ran in; it does not use the directory you are standing in, and no release worktree exists yet. If step 0 recorded a checkout that is not the PR branch, the version assertion below stops the block. `REPO_DIR` is immutable, so the repair is to start the state again: steps 0 and 1 change nothing outside this machine, so delete the release directory printed by step 0, then run step 0 from the PR branch checkout.

**Run the full verification set, not only the typecheck.** `AGENTS.md` names several behavioral nets with distinct scopes. The typecheck is separate because it sees shapes, not behavior. A release ships every file, so step 1 runs every checked-in net and the manual smoke test:

- `npm run typecheck` checks TypeScript shapes.
- Both packaging-guard commands check the manifest and real pack list, including their self-tests.
- `bash verification/run-load-check.sh --repo .` checks working-tree loading, hooks, tools and config syntax.
- `bash verification/run-resolver-checks.sh --repo . --strict` checks pure pipelines and doctrine rendering.
- `npm test` runs the unit suite and the patch-coverage gate.
- `bash verification/run-ladder.sh --repo . --strict` checks model switches and worker settings isolation. It takes about three minutes. Do not run it as root.
- Both package-content commands check package-resolved runtime files. `AGENTS.md` requires the plain command and its `--self-test`, so this step runs both.
- `node verification/writing-check-tests.mjs` checks writing-checker correctness.
- `node verification/writing-check-scaling.mjs` checks linear growth and output caps.
- `bash verification/run-writing-reminder-check.sh --repo .` checks the real reminder hook, steer and persistence path. It requires GNU `timeout`.
- The isolated-load smoke test below provides an additional manual read of direct loader output.

The CI set remains the five checks in `AGENTS.md`. The other commands above are release-time hand-run nets.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION PR REPO_DIR)
eval "$STATE"
cd "$REPO_DIR"
[[ -z "$(git -C "$REPO_DIR" status --porcelain)" ]]

node - "$VERSION" <<'NODE'
const fs = require("node:fs");
const [version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (manifest.version !== version) throw new Error(`package version is ${manifest.version}`);
NODE

npm run typecheck
bash verification/run-packaging-checks.sh --repo .
bash verification/run-packaging-checks.sh --repo . --self-test
bash verification/run-load-check.sh --repo .
bash verification/run-resolver-checks.sh --repo . --strict
npm test
bash verification/run-ladder.sh --repo . --strict
node verification/package-content-check.mjs --repo .
node verification/package-content-check.mjs --repo . --self-test
node verification/writing-check-tests.mjs
node verification/writing-check-scaling.mjs
bash verification/run-writing-reminder-check.sh --repo .

LOAD_LOG="$RELEASE_DIR/evidence/isolated-load.log"
LOAD_STATUS=0
pi --no-extensions -e . -p exit >"$LOAD_LOG" 2>&1 || LOAD_STATUS=$?
cat "$LOAD_LOG"
printf 'pi exit status: %s\n' "$LOAD_STATUS"
if (( LOAD_STATUS != 0 )); then
  printf 'pi exited %s; that is a failure whatever the log says.\n' "$LOAD_STATUS" >&2
  exit 1
fi
if grep -Eq 'Failed to load extension|Cannot find module|SyntaxError' "$LOAD_LOG"; then
  printf 'The load log carries a failure marker; stop.\n' >&2
  exit 1
fi
```

A nonzero smoke-test exit is a failure outright. On pinned pi 0.83.0, reported direct-load failures normally exit 1 and print `Failed to load extension`. Other extension failures can remain exit 0 and use different channels. A missing file inside a package's `pi.extensions` list can stay completely silent. The marker scan is therefore a floor, not a ceiling. Read the log instead of treating three patterns as exhaustive.

That headless run proves registration and `session_start` only. It never enters orchestrator mode, so it builds no doctrine, consults no router and runs no tool or failover path. **If the release changes failover, doctrine rendering, the router, or any dispatch path, also open an interactive `pi --no-extensions -e .` session before flipping the PR to ready, and exercise `thread`, `threads` and `episode` by hand along with whatever changed.** `AGENTS.md` requires failover explicitly for this reason; the automated nets cover the resolution and the rendering, and only a live session proves the wiring runs.

Finally, re-read the full diff before requesting the merge.

## Step 2 — the user merges

The user squash-merges the umbrella PR. The agent must not merge it.

## Step 3 — the agent identifies the merged commit and creates the release worktree

Take the squash SHA from GitHub, not from recent history. If state already holds a SQUASH_SHA, it must match the freshly derived one; a mismatch means the PR was re-merged and the release must restart at step 0 with a new version.

The release worktree isolates the release from every other checkout. Nothing here switches a branch, so nothing collides with a branch that another worktree holds.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PR REPO REPO_DIR)
eval "$STATE"

git -C "$REPO_DIR" fetch origin main
SQUASH_SHA=$(gh pr view "$PR" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid')
[[ "$SQUASH_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git -C "$REPO_DIR" rev-parse "$SQUASH_SHA^{commit}")" == "$SQUASH_SHA" ]]
git -C "$REPO_DIR" merge-base --is-ancestor "$SQUASH_SHA" origin/main

WORKTREE="$RELEASE_DIR/checkout"
if [[ -e "$WORKTREE" ]]; then
  [[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
else
  git -C "$REPO_DIR" worktree add --detach "$WORKTREE" "$SQUASH_SHA"
fi
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
[[ "$(git -C "$WORKTREE" rev-parse --is-inside-work-tree)" == 'true' ]]
[[ -z "$(git -C "$WORKTREE" status --porcelain)" ]]

node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" SQUASH_SHA="$SQUASH_SHA" WORKTREE="$WORKTREE"
```

Stop if GitHub does not report an exact merge commit or any check fails. Ancestry alone is not proof that the intended PR produced the SHA.

Before step 4, require a successful continuous-integration run at that exact squash commit. The run must contain both matrix jobs.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" REPO SQUASH_SHA)
eval "$STATE"

RUNS=$(gh run list --repo "$REPO" --workflow ci.yml --commit "$SQUASH_SHA" --json databaseId,status,conclusion,headSha)
RUN_ID=$(node -e '
const runs = JSON.parse(process.argv[1]);
const sha = process.argv[2];
const run = runs.find(value => value.headSha === sha && value.status === "completed" && value.conclusion === "success");
if (!run) throw new Error(`no successful completed CI run at ${sha}`);
process.stdout.write(String(run.databaseId));
' "$RUNS" "$SQUASH_SHA")
JOBS=$(gh run view "$RUN_ID" --repo "$REPO" --json jobs)
node -e '
const jobs = JSON.parse(process.argv[1]).jobs;
for (const name of ["Node 22", "Node 24"]) {
  const job = jobs.find(value => value.name === name);
  if (!job || job.status !== "completed" || job.conclusion !== "success") {
    throw new Error(`${name} did not pass: ${JSON.stringify(job)}`);
  }
}
' "$JOBS"
printf 'CI run %s passed at %s with Node 22 and Node 24.\n' "$RUN_ID" "$SQUASH_SHA"
```

## Step 4 — the agent verifies and packs the exact commit

Verify the release version from the merged commit itself, then build the tarball inside the release worktree.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" VERSION SQUASH_SHA WORKTREE)
eval "$STATE"
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
[[ -z "$(git -C "$WORKTREE" status --porcelain)" ]]

node - "$WORKTREE/package.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [manifestPath, version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.version !== version) throw new Error(`merged package version is ${manifest.version}`);
NODE
```

Create and inspect the actual tarball that will be published. Do not rely on the clean source tree or a dry run. The tarball goes into the release directory, not `/tmp`: the user publishes it in a later session, and `/tmp` does not have to survive that long.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" VERSION SQUASH_SHA WORKTREE)
eval "$STATE"

# npm pack reads the working tree, not the commit. Re-derive both here, at the
# moment of packing: the earlier block's clean tree is not evidence about this one.
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
if [[ -n "$(git -C "$WORKTREE" status --porcelain)" ]]; then
  printf 'Release worktree %s is not clean; it would be packed as it stands.\n' "$WORKTREE" >&2
  git -C "$WORKTREE" status --porcelain >&2
  exit 1
fi

# Re-packing after the handoff would delete the bytes the user was told to
# publish. Refuse before touching the directory, not after.
if grep -q '"HANDOFF_AT"' "$RELEASE_DIR/release.json"; then
  printf 'The handoff already happened; the recorded bytes are sealed. Do not re-pack.\n' >&2
  exit 1
fi

PACK_DIR="$RELEASE_DIR/artifact"
rm -rf "$PACK_DIR"
mkdir -p "$PACK_DIR"
PACK_JSON=$(cd "$WORKTREE" && npm pack --json --pack-destination "$PACK_DIR")
TARBALL="$PACK_DIR/$(node -e "const x=JSON.parse(process.argv[1]);if(x.length!==1)throw Error('unexpected pack result');process.stdout.write(x[0].filename)" "$PACK_JSON")"
[[ -f "$TARBALL" ]]
tar -tzf "$TARBALL"
mkdir "$PACK_DIR/unpacked"
tar -xzf "$TARBALL" -C "$PACK_DIR/unpacked"

node - "$PACK_DIR/unpacked/package/package.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [manifestPath, expectedVersion] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.version !== expectedVersion) throw new Error(`packed version is ${manifest.version}`);
const sdk = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];
if (manifest.dependencies && Object.keys(manifest.dependencies).length) throw new Error("packed artifact has dependencies");
for (const name of sdk) {
  if (manifest.peerDependencies?.[name] !== "*") throw new Error(`${name} is not a peer at *`);
}
for (const name of ["typescript", "@types/node"]) {
  if (manifest.peerDependencies?.[name]) throw new Error(`${name} must stay dev-only, not a peer`);
}
if (!(manifest.keywords ?? []).includes("pi-package")) throw new Error("keywords must keep pi-package; it is what lists the package in the gallery");
NODE

for path in \
  extension/index.ts \
  README.md \
  LICENSE
do
  [[ -f "$PACK_DIR/unpacked/package/$path" ]]
done
[[ ! -e "$PACK_DIR/unpacked/package/tsconfig.json" ]]

EXPECTED_DOCS="$PACK_DIR/expected-docs.txt"
PACKED_DOCS="$PACK_DIR/packed-docs.txt"
git -C "$WORKTREE" ls-tree -r --name-only HEAD docs | sort >"$EXPECTED_DOCS"
tar -tzf "$TARBALL" | sed -n 's#^package/\(docs/.*[^/]\)$#\1#p' | sort >"$PACKED_DOCS"
(( $(wc -l <"$EXPECTED_DOCS") >= 7 ))
diff "$EXPECTED_DOCS" "$PACKED_DOCS"
for path in \
  docs/track-workflow.md \
  docs/review-rules.md \
  docs/design-principles.md \
  docs/pr-publishing.md \
  docs/model-routing.md
do
  grep -Fxq "$path" "$PACKED_DOCS"
done

HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r TARBALL_SHA256 TARBALL_INTEGRITY <<<"$HASHES"
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" \
  TARBALL="$TARBALL" TARBALL_SHA256="$TARBALL_SHA256" TARBALL_INTEGRITY="$TARBALL_INTEGRITY"
printf 'tarball:   %s\nsha256:    %s\nintegrity: %s\n' "$TARBALL" "$TARBALL_SHA256" "$TARBALL_INTEGRITY"
```

The manifest checks cover all four packaging rules in `AGENTS.md`: the four SDK packages stay peers at `*`, the typecheck's tooling stays dev-only and out of the artifact, `keywords` keeps `pi-package`, and the docs check below proves `docs/` shipped.

The docs check compares the tarball against the `docs/` tree of the merged commit and requires exact equality, so it cannot go stale when a document is added — as it did when it named five of the seven shipped documents. The floor of seven catches an empty or truncated `docs/` tree, and the named five are the documents the doctrine dereferences at runtime; a publish without them ships a broken doctrine.

`TARBALL_SHA256` and `TARBALL_INTEGRITY` are the record of the inspected bytes. `TARBALL_INTEGRITY` is in npm's own `dist.integrity` form, so step 6 compares the registry's value against it directly.

Read the `tar` listing for unexpected files as well as running the explicit checks. Stop before the handoff if the tarball is wrong.

## Step 5 — the user publishes

The agent does not publish. The npm account requires two-factor authentication, and both existing releases were published by the user after the agent could not complete the transaction. Publication is the user's step for the same reason the merge is: it needs the user's credentials and the user's consent. The agent prepares the artifact, hands over one exact command against one exact file, and verifies the result afterwards.

**The agent prints the handoff.** It hands over the absolute path of the inspected tarball and the hashes of its bytes, so both sides of the handoff refer to the same artifact:

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION TARBALL TARBALL_SHA256 TARBALL_INTEGRITY)
eval "$STATE"
[[ -f "$TARBALL" ]]
HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r NOW_SHA256 NOW_INTEGRITY <<<"$HASHES"
[[ "$NOW_SHA256" == "$TARBALL_SHA256" && "$NOW_INTEGRITY" == "$TARBALL_INTEGRITY" ]]
mkdir -p "$RELEASE_DIR/evidence"
HANDOFF_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" HANDOFF_AT="$HANDOFF_AT"
cat <<HANDOFF
Publish $PACKAGE@$VERSION. Run this command in your own terminal, so you can
answer the two-factor prompt:

  npm publish '$TARBALL' --registry https://registry.npmjs.org/

The registry address is named in the command on purpose. npm reads
configuration files that can point it at another registry, and this artifact
belongs on the public one.

The output is not redirected on purpose: npm asks for the one-time password on
the terminal, and a pipe or a file can hide the prompt or suppress it entirely.
Copy the whole console output into:

  $RELEASE_DIR/evidence/publish.log

The inspected bytes are:

  sha256     $TARBALL_SHA256
  integrity  $TARBALL_INTEGRITY

npm prints a shasum and an integrity line before it uploads. The integrity line
must equal the value above. If it does not, stop and do not confirm the upload.

Publish this file and no other. Do not repack it. Tell the agent when the
command has finished.
HANDOFF
```

**The user publishes.** Run the printed command. Complete two-factor authentication. Save the console output. Do not retry without the agent. A second attempt can repeat an accepted transaction.

**The agent waits.** It does not run `npm publish` or repack. It proceeds to step 6 after the command finishes.

Treat a reported exit status only as advisory evidence. The runbook never uses that status to decide whether the publish succeeded.

A shell may fail to run the line that reports status. The shell then reports a failure that did not happen. Within a pipeline, the shell reports the last command's status. The shell does not necessarily report the `npm publish` status.

Step 6 decides whether the publish succeeded. The registry must contain the artifact. The artifact must match what step 4 packed.

## Step 6 — the agent verifies the published artifact

This is the check the old runbook threw away: it fetched `dist.integrity` and compared it to nothing. Here the registry's integrity value is compared against the recorded integrity of the inspected bytes, and the served tarball is compared byte for byte against the retained one. A handoff can substitute a different artifact; this is what detects it.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION TARBALL TARBALL_SHA256 TARBALL_INTEGRITY HANDOFF_AT)
eval "$STATE"
REGISTRY='https://registry.npmjs.org/'

# Every run reports only what it derived itself. Clear the last run's registry
# evidence before anything can fail, so no surviving file can be read as a fact
# about this result.
REGISTRY_DIR="$RELEASE_DIR/registry"
mkdir -p "$RELEASE_DIR/evidence"
rm -rf "$REGISTRY_DIR" \
  "$RELEASE_DIR/evidence/registry-view.json" \
  "$RELEASE_DIR/evidence/registry-view.err" \
  "$RELEASE_DIR/evidence/registry-result.txt"
mkdir -p "$REGISTRY_DIR"

[[ -f "$TARBALL" ]]
HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r NOW_SHA256 NOW_INTEGRITY <<<"$HASHES"
[[ "$NOW_SHA256" == "$TARBALL_SHA256" && "$NOW_INTEGRITY" == "$TARBALL_INTEGRITY" ]]

REGISTRY_RESULT='inconclusive'
REGISTRY_INTEGRITY=''
VIEW_ERROR="$RELEASE_DIR/evidence/registry-view.err"
if VIEW_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity dist.tarball --json --registry "$REGISTRY" 2>"$VIEW_ERROR"); then
  printf '%s\n' "$VIEW_JSON" >"$RELEASE_DIR/evidence/registry-view.json"
  REGISTRY_VERSION=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.version ?? ""))' "$VIEW_JSON")
  REGISTRY_INTEGRITY=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x["dist.integrity"] ?? x.dist?.integrity ?? ""))' "$VIEW_JSON")
  if [[ "$REGISTRY_VERSION" != "$VERSION" ]]; then
    printf 'registry served version %s, expected %s\n' "$REGISTRY_VERSION" "$VERSION" >&2
  elif [[ ! "$REGISTRY_INTEGRITY" =~ ^sha512- ]]; then
    printf 'registry integrity %s is not sha512; cannot compare\n' "$REGISTRY_INTEGRITY" >&2
  elif [[ "$REGISTRY_INTEGRITY" != "$TARBALL_INTEGRITY" ]]; then
    REGISTRY_RESULT='integrity-mismatch'
  else
    if REGISTRY_JSON=$(cd "$REGISTRY_DIR" && npm pack "$PACKAGE@$VERSION" --json --pack-destination "$REGISTRY_DIR" --registry "$REGISTRY" 2>>"$VIEW_ERROR"); then
      REGISTRY_TARBALL="$REGISTRY_DIR/$(node -e "const x=JSON.parse(process.argv[1]);if(x.length!==1)throw Error('unexpected registry pack result');process.stdout.write(x[0].filename)" "$REGISTRY_JSON")"
      [[ -f "$REGISTRY_TARBALL" ]]
      CMP_STATUS=0
      cmp "$TARBALL" "$REGISTRY_TARBALL" || CMP_STATUS=$?
      if (( CMP_STATUS == 0 )); then
        REGISTRY_RESULT='verified'
      elif (( CMP_STATUS == 1 )); then
        REGISTRY_RESULT='integrity-mismatch'
      else
        printf 'cmp could not compare the files (status %s); this is not evidence of a mismatch\n' "$CMP_STATUS" >&2
      fi
    fi
  fi
fi

printf '%s\n' "$REGISTRY_RESULT" >"$RELEASE_DIR/evidence/registry-result.txt"
printf 'registry result: %s\nregistry integrity: %s\nrecorded integrity: %s\n' \
  "$REGISTRY_RESULT" "$REGISTRY_INTEGRITY" "$TARBALL_INTEGRITY"
if [[ "$REGISTRY_RESULT" == 'verified' ]]; then
  node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" \
    REGISTRY_INTEGRITY="$REGISTRY_INTEGRITY" REGISTRY_VERIFIED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
```

The block clears `$RELEASE_DIR/registry/` and its three evidence files at the top, before any check can stop it. So whatever is there afterwards came from this run, on every branch: an empty `registry/` means this run downloaded nothing, and a missing `registry-view.json` means this run's `npm view` did not answer. Nothing needs a timestamp, because nothing outlives the run that wrote it.

`cmp` returns 1 for files that differ and more than 1 for a comparison it could not make — an unreadable file, a truncated download, an I/O error. Only 1 is a mismatch. Anything above it leaves the result `inconclusive`, because a failed comparison is not evidence, and reporting it as a mismatch would raise an alarm about a healthy release.

`registry-result.txt` and the recorded timestamp are a record, not a key. Step 7 re-runs the registry comparison itself, so writing `verified` into a file or a variable unlocks nothing.

Use the matching branch:

- **`verified`.** npm serves the inspected bytes. Continue to step 7.

- **`integrity-mismatch`. Untested.** npm serves something other than the inspected artifact under an immutable version number. **Stop.** Do not tag and do not create a release.

  The runbook does not deprecate the version, move a distribution tag or unpublish anything. Those are public, irreversible acts on a package other people install, and an earlier draft of this document automated them: it read a byte difference and reached for `npm deprecate`. Review found two ways that path could fire on evidence that was stale or malformed. The action was worth less than the ways of getting it wrong, so it is gone. The runbook's job here is to put the facts in front of the user. The decision belongs to the user, and it is made outside this document.

  This run's evidence is under `$RELEASE_DIR/evidence/`: `registry-view.json`, `registry-view.err` and `registry-result.txt`, with the inspected tarball under `$RELEASE_DIR/artifact/`, the recorded hashes in `release.json`, and the downloaded tarball under `$RELEASE_DIR/registry/` — which is empty when the integrity values already differed, because the block downloads nothing once it knows they do. Nothing further needs collecting.

  Re-run step 6 once after a few minutes before reporting: a mid-propagation read can differ, and the re-run replaces the evidence with its own. Then tell the user the version, the recorded sha256 and integrity of the inspected tarball, the integrity npm serves, whether the difference is in the integrity value, in the bytes, or in both, and the path of the inspected tarball — with the downloaded one only if `$RELEASE_DIR/registry/` holds it.

  Either way this version number is spent. A published version cannot be replaced or reused, so a corrected release starts at step 0 with the next unused patch version.

- **`inconclusive`. Untested.** The block reached no conclusion. Do not publish again. Two different causes end here and they need different work, so read `registry-view.err` and the block's own stderr first and name the one you have:

  - **The registry read failed** — `npm view` errored, served another version, or served an integrity value the block could not compare. That can mean absence, propagation delay, lost permission, or a registry or network failure, and none of them is authoritative. This is what the numbered steps below are for.
  - **The local evidence collection failed** — `npm pack` could not write the download, or `cmp` could not read a file: a full disk, a permission error, an unreadable path. The registry may be perfectly healthy; the block just could not look. Fix the local condition and re-run step 6. Do not wait, and do not escalate to npm: nothing here is evidence about the publication.

  1. Preserve the evidence. It already belongs in `$RELEASE_DIR/evidence/`: `publish.log` from the user, `registry-view.err`, `registry-view.json` if this run's read answered, `registry-result.txt`. Add the recorded `sha256` and integrity from `release.json`, which is already there. This directory is outside `/tmp` and outside the repository, so it survives a reboot and a worktree removal.
  2. Wait and re-read. Re-run the step 6 block after 15 minutes, up to four times over an hour. Propagation delay resolves in that window.
  3. Widen the read once before escalating. `npm view "$PACKAGE" --json --registry "$REGISTRY"` returns the whole package document. Enumerate its `versions` array rather than trusting a single-version E404. That distinction was what identified the true state during the first release.
  4. Escalate if it is still unresolved. Open a ticket at <https://www.npmjs.com/support> against the package `ytdb-slate`. Include: the version, the publish timestamp from `publish.log`, the full publish log, the `npm view` error output, the recorded sha256 and sha512 integrity, and the question asked plainly — was the publish transaction for this version accepted?
  5. Do not retry step 5 until npm support or a registry operator confirms that the transaction was not accepted. If the version becomes visible instead, re-run step 6 and follow the branch it reports.

  Leave the release worktree in place while an escalation is open; step 9 removes it when the release closes, either way.

## Step 7 — the agent tags and creates the release

This step gates on facts it derives itself. It re-hashes the retained tarball, re-reads the registry, and compares the served integrity against the recorded integrity, before it creates anything. No inherited variable and no word written in a file can advance it — which is precisely the defect this replaces: during the first release the tag guard read a value typed in from a previous session's report.

Write the release notes to `$RELEASE_DIR/release-note.md` first. The block requires the file and refuses an empty one.

The block is restart-safe. It determines the local tag, the remote tag and the GitHub release states before creating anything, and accepts only a lightweight tag at the intended commit. **Untested** for every restart state except "nothing exists yet".

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION TAG REPO REPO_DIR SQUASH_SHA TARBALL TARBALL_SHA256 TARBALL_INTEGRITY)
eval "$STATE"
REGISTRY='https://registry.npmjs.org/'

# Re-derive the artifact facts.
[[ -f "$TARBALL" ]]
HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r NOW_SHA256 NOW_INTEGRITY <<<"$HASHES"
[[ "$NOW_SHA256" == "$TARBALL_SHA256" && "$NOW_INTEGRITY" == "$TARBALL_INTEGRITY" ]]

# Re-derive the registry facts. This is the gate, not a stored result.
LIVE_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity --json --registry "$REGISTRY")
LIVE_VERSION=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.version ?? ""))' "$LIVE_JSON")
LIVE_INTEGRITY=$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x["dist.integrity"] ?? x.dist?.integrity ?? ""))' "$LIVE_JSON")
[[ "$LIVE_VERSION" == "$VERSION" ]]
[[ "$LIVE_INTEGRITY" == "$TARBALL_INTEGRITY" ]]

# Re-derive the commit facts.
git -C "$REPO_DIR" fetch origin main
[[ "$SQUASH_SHA" =~ ^[0-9a-f]{40}$ ]]
git -C "$REPO_DIR" merge-base --is-ancestor "$SQUASH_SHA" origin/main

NOTE_FILE="$RELEASE_DIR/release-note.md"
[[ -s "$NOTE_FILE" ]]

halt_wrong_tag() {
  local location=$1 actual=$2
  printf 'SERIOUS: %s tag %s points at %s, expected %s.\n' "$location" "$TAG" "$actual" "$SQUASH_SHA" >&2
  printf 'Stop. Inspect the tag provenance and resolve the conflicting ref manually; never move, delete, or force-push it from this runbook.\n' >&2
  exit 1
}

LOCAL_TAG_EXISTS=false
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/tags/$TAG"; then
  LOCAL_TAG_EXISTS=true
  LOCAL_TAG_TYPE=$(git -C "$REPO_DIR" cat-file -t "$TAG")
  [[ "$LOCAL_TAG_TYPE" == 'commit' ]] || halt_wrong_tag 'local (non-lightweight)' "$LOCAL_TAG_TYPE"
  LOCAL_TAG_SHA=$(git -C "$REPO_DIR" rev-parse "$TAG^{commit}")
  [[ "$LOCAL_TAG_SHA" == "$SQUASH_SHA" ]] || halt_wrong_tag 'local' "$LOCAL_TAG_SHA"
fi

REMOTE_TAG_FILE=$(mktemp)
git -C "$REPO_DIR" ls-remote --refs origin "refs/tags/$TAG" >"$REMOTE_TAG_FILE"
mapfile -t REMOTE_TAG_LINES <"$REMOTE_TAG_FILE"
(( ${#REMOTE_TAG_LINES[@]} <= 1 ))
REMOTE_TAG_EXISTS=false
if (( ${#REMOTE_TAG_LINES[@]} == 1 )); then
  REMOTE_TAG_EXISTS=true
  read -r REMOTE_TAG_SHA REMOTE_TAG_REF <<<"${REMOTE_TAG_LINES[0]}"
  [[ "$REMOTE_TAG_REF" == "refs/tags/$TAG" && "$REMOTE_TAG_SHA" =~ ^[0-9a-f]{40}$ ]]
  [[ "$REMOTE_TAG_SHA" == "$SQUASH_SHA" ]] || halt_wrong_tag 'remote' "$REMOTE_TAG_SHA"
fi

RELEASE_PROBE=$(mktemp)
RELEASE_ERROR=$(mktemp)
RELEASE_EXISTS=false
if gh api --include "repos/$REPO/releases/tags/$TAG" >"$RELEASE_PROBE" 2>"$RELEASE_ERROR"; then
  RELEASE_EXISTS=true
  RELEASE_JSON=$(gh release view "$TAG" --repo "$REPO" --json tagName,targetCommitish)
  [[ "$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(x.tagName)" "$RELEASE_JSON")" == "$TAG" ]]
  RELEASE_TARGET=$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(x.targetCommitish)" "$RELEASE_JSON")
  [[ "$RELEASE_TARGET" == "$SQUASH_SHA" ]] || halt_wrong_tag 'release target' "$RELEASE_TARGET"
else
  RELEASE_HTTP_STATUS=$(awk 'NR == 1 { print $2 }' "$RELEASE_PROBE")
  if [[ "$RELEASE_HTTP_STATUS" != '404' ]]; then
    cat "$RELEASE_ERROR" >&2
    printf 'Cannot determine whether release %s exists; stop.\n' "$TAG" >&2
    exit 1
  fi
fi

if [[ "$RELEASE_EXISTS" == true && "$REMOTE_TAG_EXISTS" != true ]]; then
  printf 'SERIOUS: release %s exists without its expected remote tag; stop and inspect the repository state.\n' "$TAG" >&2
  exit 1
fi

if [[ "$LOCAL_TAG_EXISTS" != true ]]; then
  git -C "$REPO_DIR" tag "$TAG" "$SQUASH_SHA"
  [[ "$(git -C "$REPO_DIR" cat-file -t "$TAG")" == 'commit' ]]
  [[ "$(git -C "$REPO_DIR" rev-parse "$TAG^{commit}")" == "$SQUASH_SHA" ]]
fi
if [[ "$REMOTE_TAG_EXISTS" != true ]]; then
  git -C "$REPO_DIR" push origin "refs/tags/$TAG"
fi
if [[ "$RELEASE_EXISTS" != true ]]; then
  gh release create "$TAG" --repo "$REPO" --verify-tag --target "$SQUASH_SHA" \
    --title "$PACKAGE $VERSION" --notes-file "$NOTE_FILE"
fi

[[ "$(git -C "$REPO_DIR" cat-file -t "$TAG")" == 'commit' ]]
[[ "$(git -C "$REPO_DIR" rev-parse "$TAG^{commit}")" == "$SQUASH_SHA" ]]
[[ "$(git -C "$REPO_DIR" ls-remote --refs origin "refs/tags/$TAG" | awk '{print $1}')" == "$SQUASH_SHA" ]]
[[ "$(gh release view "$TAG" --repo "$REPO" --json targetCommitish --jq '.targetCommitish')" == "$SQUASH_SHA" ]]
[[ "$(npm view "$PACKAGE@$VERSION" version --registry "$REGISTRY")" == "$VERSION" ]]
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" TAGGED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

`--target "$SQUASH_SHA"` is not decoration. Without it the release records the default branch head, which is why the last release's `targetCommitish` did not match the commit the runbook's own final check demanded. When the tag already exists the target is cosmetic — GitHub takes the commit from the tag — but the check compares it, so it must be set.

The normal restart states are these four. Nothing exists yet, so the block creates the tag, pushes it and creates the release. Only the correct local tag exists, so the block skips the creation, then pushes and releases. The correct remote tag exists with no release, so the block ensures the local tag, skips the push and creates the release. The correct remote tag and the release both exist, so the block ensures the local tag and skips both remote actions. If any existing tag or release target is wrong, stop, inspect who created it and why, and resolve it manually under repository policy. This runbook never moves or deletes a conflicting tag. The tag must point at the umbrella squash SHA, which is the commit that step 4 packed.

## Step 8 — the agent installs the published package in a throwaway project

This step is one manual check. It installs the published version into a throwaway project outside every checkout. It starts a pi session there. It reads the command list of that session.

**What the check establishes.** The published version installs from the registry with `pi install`. The install reaches the registry, because it runs against an empty throwaway npm package cache. pi loads the installed extension. The extension registers its `/slate` command in that session.

**What the check does not establish.** It does not establish that the registry served the bytes that step 4 packed. Step 6 compares the published bytes against the inspected bytes, and that comparison is the evidence for the bytes. The check also does not establish doctrine rendering, and it does not establish model routing. A headless session never enters orchestrator mode, so it builds no doctrine and it consults no router. Issue 293 in this repository, at <https://github.com/JetBrains/ytdb-slate/issues/293>, tracks the deeper interactive proof.

**The check asserts a registered command, and it asserts no registered tool.** The cause is the pi interface. The rpc interface of pi 0.83.0 carries a request that lists commands, and it carries no request that lists tools. A registered command is therefore the strongest observation this session supports. The limit for the reader is direct. A published build that registers its `/slate` command and fails to register its `thread`, `threads` or `episode` tool passes this check undetected. The extension load check reads the registered tool set of a working tree, and it runs on every pull request, so tool registration has automated coverage before a publish and no coverage after one.

**Why this check is manual, and what will replace it.** No automated check in this repository installs the published package, because a published version has to exist first. The packaging guards read the real file list from `npm pack --dry-run`, and they run on every pull request, so continuous integration already covers the package contents. The package-content check reads the same real file list and derives the runtime-file roster independently, and it runs by hand only. Issue 199 in this repository, at <https://github.com/JetBrains/ytdb-slate/issues/199>, asks for an automated release workflow. Its text does not mention verification after a publish, so no issue tracks a replacement for this step today. Run this step by hand.

**This step runs after publication only.** It never runs on a pull request, and it is not one of the five continuous-integration checks that `AGENTS.md` names. It needs a published version, and it needs the registry.

**Three isolations narrow the result, and none of them is a sandbox.** A throwaway project directory outside every checkout supplies the project scope, so no checkout's settings file takes part. A throwaway agent directory supplies the user scope, so the real user settings, the real trust record and the real model configuration take no part. An empty throwaway npm package cache supplies the download cache, so no earlier read, no earlier pack and no earlier install can serve the bytes. The session runs as the same operating-system user, and npm still reads the global configuration file, so the check can read and write everything this user can. The block pins the registry address for that reason.

**The empty cache is the load-bearing guard, and no npm flag replaces it.** A shared cache that already holds the metadata document and the tarball of one version serves a whole install of that version while the registry is unreachable. That behaviour was measured on this machine. The install then succeeded on the default flags, under `--prefer-offline` and under `--prefer-online` alike. The shared cache of a release machine is primed by this runbook itself, because step 0 reads the package document and step 6 downloads the published tarball. An empty cache holds nothing to serve, so the install must reach the registry or fail. The block asserts that the cache directory is empty before the install, and it removes the cache directory at the end. Keep this guard. Without it the check passes with no registry read at all, and the run then reports an install that never happened.

**A direct connection to the registry is required.** A configured proxy, a transparent intercepting proxy and a local registry mirror each put this step out of scope. Each of them can change the bytes or the metadata that this machine receives. This step contains no proxy detection, and proxy support is a declared non-goal of this runbook. Satisfy the precondition instead, and run this step from a machine with a direct connection.

**Other checkouts of this repository prove nothing here.** Many of them carry an `npm:ytdb-slate@<version>` entry that names an earlier release, and no such entry names the version this runbook publishes. Read the live state with `git worktree list` and with the settings file of the checkout you care about, rather than trusting a count written in a document.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION REPO_DIR)
eval "$STATE"

PI="$REPO_DIR/node_modules/.bin/pi"
if [[ ! -x "$PI" ]]; then
  printf 'No executable pi binary at %s. Run `npm ci --ignore-scripts` in %s, then run this step again.\n' "$PI" "$REPO_DIR" >&2
  exit 1
fi

CHECK_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/slate-release-check.XXXXXX")
CHECK_ROOT=$(cd "$CHECK_ROOT" && pwd -P)
case "$CHECK_ROOT" in
  "$REPO_DIR"|"$REPO_DIR"/*|"$RELEASE_DIR"|"$RELEASE_DIR"/*)
    printf 'The scratch root %s sits inside a checkout or inside the release state. Point TMPDIR somewhere else.\n' "$CHECK_ROOT" >&2
    exit 2 ;;
esac
mkdir -p "$CHECK_ROOT/project" "$CHECK_ROOT/agent" "$CHECK_ROOT/npm-cache"

# The throwaway agent directory keeps the real user settings out of the check.
export PI_CODING_AGENT_DIR="$CHECK_ROOT/agent"
export npm_config_registry='https://registry.npmjs.org/'
# The empty throwaway cache forces the install to reach the registry. The shared
# cache of this machine can serve a whole install offline, so it would make the
# check pass with no registry read.
export npm_config_cache="$CHECK_ROOT/npm-cache"
if [[ -n "$(find "$CHECK_ROOT/npm-cache" -mindepth 1 -print -quit)" ]]; then
  printf 'The throwaway npm cache %s is not empty. Remove it and run this step again.\n' "$CHECK_ROOT/npm-cache" >&2
  exit 1
fi
cd "$CHECK_ROOT/project"

printf 'pi %s at %s\n' "$("$PI" --version)" "$PI"
"$PI" install -l "npm:$PACKAGE@$VERSION" -a

printf '%s\n' '{"id":"1","type":"get_commands"}' >requests.jsonl
PI_OFFLINE=1 timeout 120 "$PI" --mode rpc -a <requests.jsonl >session.jsonl 2>session.err
node - "$CHECK_ROOT/project" "$PACKAGE" "$VERSION" <<'NODE'
const fs = require("node:fs");
const nodePath = require("node:path");
const [project, name, version] = process.argv.slice(2);
const objects = fs.readFileSync(nodePath.join(project, "session.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim().startsWith("{"))
  .map((line) => JSON.parse(line));
const errors = objects.filter((object) => object?.type === "extension_error");
for (const error of errors) process.stdout.write(`extension error: ${JSON.stringify(error)}\n`);
const answer = objects.find((object) => object?.type === "response" && object.command === "get_commands");
const packaged = (answer?.data?.commands ?? []).filter((command) => command?.sourceInfo?.origin === "package");
for (const command of packaged) {
  process.stdout.write(`packaged command: /${command.name} from ${command.sourceInfo.source} at ${command.sourceInfo.path}\n`);
}
const wanted = nodePath.join(project, ".pi", "npm", "node_modules", name, "extension", "index.ts");
const slate = packaged.find((command) => command.name === "slate");
if (errors.length !== 0) throw new Error("the session reported an extension error");
if (packaged.length !== 1 || !slate) throw new Error("the session reported no single packaged command named slate");
if (slate.sourceInfo.source !== `npm:${name}@${version}`) throw new Error(`the command comes from ${slate.sourceInfo.source}`);
if (slate.sourceInfo.path !== wanted) throw new Error(`the command resolved to ${slate.sourceInfo.path}`);
process.stdout.write(`${name}@${version} installed from the registry into an empty cache, loaded in pi and registered /slate\n`);
NODE
rm -rf "$CHECK_ROOT/npm-cache"
printf 'throwaway cache removed: %s\n' "$CHECK_ROOT/npm-cache"
printf 'throwaway root: %s\nRead it if you want to, then remove it: rm -rf %s\n' "$CHECK_ROOT" "$CHECK_ROOT"
```

**What a passing run prints.** The first line names the pi version and its path. The install prints its own progress. The next two lines name the packaged command and say that the published version installed from the registry into an empty cache, loaded in pi and registered `/slate`. The last two lines name the removed throwaway cache and the path of the throwaway root. The check stores nothing outside that root, and it writes no file into the release state.

**What a failing run prints when the install cannot reach the registry.** The block stops inside `pi install`. npm reports that it cannot reach <https://registry.npmjs.org>, and the shell exits with a nonzero status. No packaged-command line and no success line appear. That is the intended result, because the empty cache holds nothing to serve.

**What to do when it does not work.** Investigate. This step has no decision procedure, and it reports no verdict word. The block stops at the command that failed, so read that command and its output first. Every guard in the block prints a message that names the problem. The session streams stay in the throwaway project as `session.jsonl` and `session.err`, and the throwaway root stays in place until you remove it. Report the facts to the user: the version, the command that failed, and the output of that command.

A failure here is not by itself a statement about the published artifact. A missing tool, an unwritable directory or an unreachable registry stops the block in the same way that a defective artifact does, and only reading the output separates the two. Step 6 is the check that compares the published bytes against the inspected bytes.

Take no public act on a failure. Step 6 states the rule in these words: "The runbook does not deprecate the version, move a distribution tag or unpublish anything. Those are public, irreversible acts on a package other people install", and "The decision belongs to the user, and it is made outside this document." The same holds here. The agent reports, and the user decides. A published version cannot be replaced or reused, so a corrected release starts at step 0 with the next unused patch version.

## Step 9 — the agent tears down the release worktree

The first release left a worktree detached at the squash commit, because no step removed it. This step is not optional, and it runs whether the release succeeded or was abandoned. **The failure path is untested.** The success path uses the same commands.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" REPO_DIR)
eval "$STATE"

TREE="$RELEASE_DIR/checkout"
if [[ -e "$TREE" ]]; then
  if [[ -n "$(git -C "$TREE" status --porcelain)" ]]; then
    printf 'Worktree %s has uncommitted changes; inspect it before removing it.\n' "$TREE" >&2
    git -C "$TREE" status --porcelain >&2
    exit 1
  fi
  git -C "$REPO_DIR" worktree remove "$TREE"
fi
git -C "$REPO_DIR" worktree prune
[[ ! -e "$TREE" ]]
git -C "$REPO_DIR" worktree list
rm -f "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current"
printf 'Release directory kept for the record: %s\n' "$RELEASE_DIR"
```

Read the final `git worktree list`: no path under the release directory may remain, and no worktree may be left detached by this release. This step creates no branch, so it leaves none behind. Keep `$RELEASE_DIR` — the tarball, the hashes and the evidence are the record of what was published. Delete it by hand when it is no longer wanted.

If an escalation is open, skip this step until the escalation closes, then run it.

## Consumers

Consumers install pinned with `pi install -l npm:ytdb-slate@<version>`. Pi skips pinned specs during `pi update`, so consumers bump their pin deliberately. On every bump, they must re-review their project delta documents (`doctrineExtraPath`, `reviewPerspectivesPath`, and prompt-document lists) against the shipped doctrine for drift.
