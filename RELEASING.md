# Releasing ytdb-slate

Nine steps, numbered 0 to 8, in order. The agent owns most of them. The user owns two: the merge and the publication. Everything that reaches npm or the default branch is the user's act.

Every command block enables fail-closed shell behavior. Do not continue after a failed command unless the applicable recovery branch says to continue.

## How to read this runbook

**Steps may run in separate sessions.** The first real release ran across four agent actions. Nothing carries between them in shell variables, so no step trusts one. Every block reloads machine-written state from a file, revalidates it, and re-derives the facts it gates on. A block that gates on a registry fact re-reads the registry; a typed word never unlocks anything.

**No step assumes the checkout you happen to be standing in.** This repository is worked in many worktrees at once — eleven at the time of writing. Every git command names its repository with `git -C`, and every gh command names its repository with `--repo`. The release itself happens in a dedicated worktree that step 8 removes. One checkout is bound, once: step 0 records the checkout it runs in as `REPO_DIR`, and steps 1, 3, 7 and 8 work in that recorded path rather than the current directory. Run step 0 in the umbrella PR branch checkout.

**Some paths have never executed.** They are marked **Untested.** where they appear, and listed under "Untested paths" below. A marked path is reviewed, not proven. Read it before you run it.

**Never set a state value by hand.** If a block stops because a state key is missing or malformed, re-run the step that writes that key. Hand-setting the value is how the first release turned a guard into a formality.

**Declare the release once per session.** `export SLATE_RELEASE=<version>` before running any block; step 0 prints the line. Every block refuses to run without it and stops if it disagrees with the state behind the pointer. It is the one fact a block cannot derive — which release you mean — and it is never used as evidence for anything else.

## Before you start

Have all of this before step 0. Steps 5 and 7 act in public, and a missing tool or a missing permission is cheap to fix now and expensive to find after publication.

- **Tools on `PATH`:** bash 4 or newer (the blocks use `mapfile`, arrays and `[[ ]]`), git, GNU coreutils, `gh`, `node`, `npm`, `pi`, `python3`, `tar`, `cmp`, `awk`, `sed`, `grep`, `diff`.
- **GitHub:** `gh auth status` reports you as logged in, against the host that serves this repository, with write access to it. Step 7 pushes a tag and creates a release.
- **npm:** the user who runs step 5 has an account that may publish `ytdb-slate` and can answer its two-factor prompt. The agent never needs npm credentials; it only reads the registry.
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
    artifact/          # the inspected tarball, retained until step 8
    registry/          # the tarball downloaded back from npm
    evidence/          # publish log, registry replies, load proof, escalation material
    checkout/          # the release worktree, detached at the squash commit
```

Keep the whole `<version>` directory until the release closes. Step 8 removes the worktree and clears the `current` pointer; it keeps the evidence.

## Resume index

What each step changes outside this machine, and how to find out whether it already ran. Read this before resuming a release in a new session. Where completion cannot be detected, the entry says so and the answer is to re-run the step — an index that reads as authoritative and is wrong is worse than no index.

| Step | Effect outside the repository | Determine whether it already ran |
| --- | --- | --- |
| 0 | None. Writes the release directory and the pointer. | `release.json` exists and holds your version. |
| 1 | None. | **Not detectable. Re-run it.** A bumped `package.json` shows an edit was made, not that the verification set passed; the runs leave no durable record except the load log, and a passing run yesterday says nothing about the tree today. |
| 2 | The squash merge, by the user. | `gh pr view <PR> --json mergeCommit` reports a commit. |
| 3 | Adds a worktree to this repository. | `release.json` has `SQUASH_SHA`, and `$RELEASE_DIR/checkout` exists. |
| 4 | None. | `release.json` has `TARBALL_SHA256`, and the retained tarball hashes to it. Re-running is refused after the handoff. |
| 5 | **Publishes to npm. Irreversible.** By the user. | `npm view <package>@<version> version` succeeds. |
| 6 | None. Read-only; downloads the published tarball. | **Not detectable, and does not need to be.** Re-running it is the intended way to resolve it. |
| 7 | Pushes a tag and creates a GitHub release. | `git ls-remote --refs origin refs/tags/<tag>` and `gh release view <tag> --repo <repo>`. The block determines this itself before it creates anything. |
| 8 | Removes the worktree it added. | `git worktree list` shows no path under the release directory. |

Step 5 is the only irreversible step. Step 7 re-derives its gates on every run and detects its own prior completion.

## Untested paths

These have never run. Treat any of them as a hypothesis and read the commands before executing them.

- The integrity-mismatch halt in step 6.
- The inconclusive branch and escalation in step 6.
- Every restart state in step 7 except "nothing exists yet".
- Teardown after a failure in step 8.

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

REPO_DIR=$(git rev-parse --show-toplevel)
[[ "$REPO_DIR" == /* ]]
GIT_COMMON_DIR=$(cd "$(git -C "$REPO_DIR" rev-parse --git-common-dir)" && pwd)
REPO=$(cd "$REPO_DIR" && gh repo view --json nameWithOwner --jq '.nameWithOwner')
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]

STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release"
RELEASE_DIR="$STATE_ROOT/$VERSION"
if [[ -f "$STATE_ROOT/current" ]]; then
  IN_PROGRESS=$(cat "$STATE_ROOT/current")
  if [[ "$IN_PROGRESS" != "$RELEASE_DIR" ]]; then
    printf 'A release is already in progress at %s. Finish it, or tear it down with step 8, before starting %s.\n' "$IN_PROGRESS" "$VERSION" >&2
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
  GIT_COMMON_DIR: /^\/[^'\n]*$/,
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
  "REPO_DIR", "GIT_COMMON_DIR", "RELEASE_DIR", "SQUASH_SHA", "WORKTREE",
]);
// The reference bytes may be re-derived by a re-pack, but not after the user
// has been handed a command naming them.
const SEALED_BY_HANDOFF = new Set(["TARBALL", "TARBALL_SHA256", "TARBALL_INTEGRITY"]);

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
  REPO="$REPO" REPO_DIR="$REPO_DIR" GIT_COMMON_DIR="$GIT_COMMON_DIR" RELEASE_DIR="$RELEASE_DIR"
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

Bump only `version` in `package.json`. Follow `docs/pr-publishing.md` through the ready flip. Do not publish from the PR branch.

This block works in `REPO_DIR`, the checkout step 0 ran in; it does not use the directory you are standing in, and no release worktree exists yet. If step 0 recorded a checkout that is not the PR branch, the version assertion below stops the block. `REPO_DIR` is immutable, so the repair is to start the state again: steps 0 and 1 change nothing outside this machine, so delete the release directory printed by step 0, then run step 0 from the PR branch checkout.

**Run the full verification set, not only the typecheck.** `AGENTS.md` names several behavioral nets with distinct scopes. The typecheck is separate because it sees shapes, not behavior. A release ships every file, so step 1 runs every checked-in net and the manual smoke test:

- `npm run typecheck` checks TypeScript shapes.
- Both packaging-guard commands check the manifest and real pack list, including their self-tests.
- `bash verification/run-load-check.sh --repo .` checks working-tree loading, hooks, tools and config syntax.
- `bash verification/run-resolver-checks.sh --repo . --strict` checks pure pipelines and doctrine rendering.
- `npm test` runs the unit suite and the patch-coverage gate.
- `bash verification/run-ladder.sh --repo . --strict` checks model switches and worker settings isolation. It takes about three minutes. Do not run it as root.
- Both package-content commands check package-resolved runtime files and their self-test: `node verification/package-content-check.mjs --repo .` and `node verification/package-content-check.mjs --repo . --self-test`.
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
const version = process.argv[2];
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
# Keep the five direct doctrine documents in one class.
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

The docs check compares the tarball against the `docs/` tree of the merged commit and requires exact equality. It cannot go stale when a document is added, as it did when it named five of seven shipped documents. The floor of seven catches an empty or truncated `docs/` tree.

The named group contains the five direct doctrine documents. The package-content checks prove one exported path and one packed copy for every shipped document.

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

  npm publish '$TARBALL'

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

## Step 6 — the agent verifies the published artifact and its registry load

This is the check the old runbook threw away: it fetched `dist.integrity` and compared it to nothing. Here the registry's integrity value is compared against the recorded integrity of the inspected bytes, and the served tarball is compared byte for byte against the retained one. A handoff can substitute a different artifact; this is what detects it.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION TARBALL TARBALL_SHA256 TARBALL_INTEGRITY HANDOFF_AT)
eval "$STATE"

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
if VIEW_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity dist.tarball --json 2>"$VIEW_ERROR"); then
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
    if REGISTRY_JSON=$(cd "$REGISTRY_DIR" && npm pack "$PACKAGE@$VERSION" --json --pack-destination "$REGISTRY_DIR" 2>>"$VIEW_ERROR"); then
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

- **`verified`.** npm serves the inspected bytes. Continue with the registry-load validation below.

- **`integrity-mismatch`. Untested.** npm serves something other than the inspected artifact under an immutable version number. **Stop.** Do not tag or release.

  The runbook does not deprecate the version, move a dist-tag or unpublish anything. Those are public, irreversible acts on a package other people install, and an earlier draft of this document automated them: it read a byte difference and reached for `npm deprecate`. Review found two ways that path could fire on evidence that was stale or malformed. The action was worth less than the ways of getting it wrong, so it is gone. The runbook's job here is to put the facts in front of the user; the decision is theirs and is made outside this document.

  This run's evidence is under `$RELEASE_DIR/evidence/`: `registry-view.json`, `registry-view.err` and `registry-result.txt`, with the inspected tarball under `$RELEASE_DIR/artifact/`, the recorded hashes in `release.json`, and the downloaded tarball under `$RELEASE_DIR/registry/` — which is empty when the integrity values already differed, because the block downloads nothing once it knows they do. Nothing further needs collecting.

  Re-run step 6 once after a few minutes before reporting: a mid-propagation read can differ, and the re-run replaces the evidence with its own. Then tell the user the version, the recorded sha256 and integrity of the inspected tarball, the integrity npm serves, whether the difference is in the integrity value, in the bytes, or in both, and the path of the inspected tarball — with the downloaded one only if `$RELEASE_DIR/registry/` holds it.

  Either way this version number is spent. A published version cannot be replaced or reused, so a corrected release starts at step 0 with the next unused patch version.

- **`inconclusive`. Untested.** The block reached no conclusion. Do not publish again. Two different causes end here and they need different work, so read `registry-view.err` and the block's own stderr first and name the one you have:

  - **The registry read failed** — `npm view` errored, served another version, or served an integrity value the block could not compare. That can mean absence, propagation delay, lost permission, or a registry or network failure, and none of them is authoritative. This is what the numbered steps below are for.
  - **The local evidence collection failed** — `npm pack` could not write the download, or `cmp` could not read a file: a full disk, a permission error, an unreadable path. The registry may be perfectly healthy; the block just could not look. Fix the local condition and re-run step 6. Do not wait, and do not escalate to npm: nothing here is evidence about the publication.

  1. Preserve the evidence. It already belongs in `$RELEASE_DIR/evidence/`: `publish.log` from the user, `registry-view.err`, `registry-view.json` if this run's read answered, `registry-result.txt`. Add the recorded `sha256` and integrity from `release.json`, which is already there. This directory is outside `/tmp` and outside the repository, so it survives a reboot and a worktree removal.
  2. Wait and re-read. Re-run the step 6 block after 15 minutes, up to four times over an hour. Propagation delay resolves in that window.
  3. Widen the read once before escalating. `npm view "$PACKAGE" --json` returns the whole package document; enumerate its `versions` array rather than trusting a single-version E404. That distinction was what identified the true state during the first release.
  4. Escalate if it is still unresolved. Open a ticket at <https://www.npmjs.com/support> against the package `ytdb-slate`. Include: the version, the publish timestamp from `publish.log`, the full publish log, the `npm view` error output, the recorded sha256 and sha512 integrity, and the question asked plainly — was the publish transaction for this version accepted?
  5. Do not retry step 5 until npm support or a registry operator confirms that the transaction was not accepted. If the version becomes visible instead, re-run step 6 and follow the branch it reports.

  Leave the release worktree in place while an escalation is open; step 8 removes it when the release closes, either way.

### Registry-load validation

This validation is mandatory after the integrity result is `verified`. It proves
that pi loads the published package, not merely that npm serves the expected
bytes. Each block creates its own trusted project, agent directory and settings
file. The settings file names only `npm:$PACKAGE@$VERSION`. Each block also
installs that package explicitly before asking `pi list` for its installed path.

The first block asserts explicit project trust, one loaded `/slate` path inside
the installed package, and registration of `thread`, `threads` and `episode`. It
also rejects both stderr failure markers and every RPC `extension_error` event.
The last check is load-bearing: pi can exit zero after a lifecycle hook throws.
The canary is the checked-in observer used by the load-check harness; it does not
ship in the package.

The complete validation was rehearsed against `ytdb-slate@0.10.0` with pi
0.84.2. Both blocks passed from fresh probe directories. A second headless run
injected a throwing `session_start` hook into the installed copy; the
`extension_error` gate rejected it. Both rehearsals removed their probe roots.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION WORKTREE REGISTRY_VERIFIED_AT)
eval "$STATE"

unset PROBE_BASE PROBE_ROOT
PROBE_BASE=""
PROBE_ROOT=""
cleanup_alert() {
  printf '\n%s\n%s\n' '!!! PROBE CLEANUP INCOMPLETE !!!' "$1" >&2
}
cleanup_probe() {
  local base=${PROBE_BASE:-} target=${PROBE_ROOT:-} cleanup_failed=0 leftovers=0
  if [[ -z "$base" || -z "$target" ]]; then
    cleanup_alert 'Probe cleanup has an unset path. Inspect the release scratch area and remove leftovers by hand.'
    return 1
  fi
  case "$base:$target" in /*:/*) ;; *)
    cleanup_alert "Probe paths are not absolute: $base : $target. Remove any leftovers by hand."
    return 1
  esac
  case "$target" in "$base"/*) ;; *)
    cleanup_alert "Probe root is outside its block-created base: $target. Remove it by hand."
    return 1
  esac
  if [[ -d "$target" ]]; then
    if ! rm -rf -- "$target"; then
      cleanup_alert "Automatic removal failed. REMOVE THIS PATH BY HAND: $target"
      cleanup_failed=1
    fi
  else
    cleanup_alert "Expected probe root is not a directory: $target. Inspect the paths below and remove leftovers by hand."
    cleanup_failed=1
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    cleanup_alert "REMOVE THIS PATH BY HAND: $target"
    cleanup_failed=1
  fi
  if [[ -d "$base" ]]; then
    while IFS= read -r -d '' leftover; do
      cleanup_alert "REMOVE THIS PATH BY HAND: $leftover"
      leftovers=$((leftovers + 1))
      cleanup_failed=1
    done < <(find "$base" -mindepth 1 -maxdepth 1 -print0)
    if (( leftovers == 0 )) && ! rmdir "$base"; then
      cleanup_alert "Automatic removal failed. REMOVE THIS PATH BY HAND: $base"
      cleanup_failed=1
    fi
  elif [[ -e "$base" || -L "$base" ]]; then
    cleanup_alert "Probe base is not a directory. REMOVE THIS PATH BY HAND: $base"
    cleanup_failed=1
  fi
  return "$cleanup_failed"
}
trap cleanup_probe EXIT
trap 'exit 130' INT TERM
mkdir -p "$RELEASE_DIR/evidence"
PROBE_BASE=$(mktemp -d "$RELEASE_DIR/registry-load-headless.XXXXXX")
PROBE_ROOT=$(mktemp -d "$PROBE_BASE/probe.XXXXXX")
PROBE_PROJECT="$PROBE_ROOT/project"
PROBE_AGENT="$PROBE_ROOT/agent"
mkdir -p "$PROBE_PROJECT/.pi" "$PROBE_AGENT"
printf '{}\n' >"$PROBE_AGENT/settings.json"
node - "$PROBE_PROJECT/.pi/settings.json" "$PACKAGE" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [settingsPath, packageName, version] = process.argv.slice(2);
fs.writeFileSync(settingsPath, `${JSON.stringify({ packages: [`npm:${packageName}@${version}`] }, null, 2)}\n`);
NODE

INSTALL_OUT="$RELEASE_DIR/evidence/registry-load-install.out"
INSTALL_ERR="$RELEASE_DIR/evidence/registry-load-install.err"
if ! (cd "$PROBE_PROJECT" && PI_CODING_AGENT_DIR="$PROBE_AGENT" \
  pi install -l --approve "npm:$PACKAGE@$VERSION") >"$INSTALL_OUT" 2>"$INSTALL_ERR"; then
  cat "$INSTALL_ERR" >&2
  cat "$INSTALL_OUT" >&2
  exit 1
fi
cat "$INSTALL_OUT"
cat "$INSTALL_ERR" >&2

PACKAGE_LIST="$RELEASE_DIR/evidence/registry-load-package-list.txt"
(cd "$PROBE_PROJECT" && PI_CODING_AGENT_DIR="$PROBE_AGENT" NO_COLOR=1 pi list -a) >"$PACKAGE_LIST"
INSTALLED_DIR=$(awk -v spec="  npm:$PACKAGE@$VERSION" '
  $0 == "Project packages:" { project = 1; next }
  project && $0 == spec { getline; sub(/^[[:space:]]+/, ""); print; exit }
' "$PACKAGE_LIST")
if [[ -z "$INSTALLED_DIR" || ! -f "$INSTALLED_DIR/package.json" ]]; then
  printf 'Cannot locate the installed package after explicit installation. pi list output:\n' >&2
  cat "$PACKAGE_LIST" >&2
  exit 1
fi

RPC_IN="$RELEASE_DIR/evidence/registry-load.in"
RPC_OUT="$RELEASE_DIR/evidence/registry-load.out"
RPC_ERR="$RELEASE_DIR/evidence/registry-load.err"
printf '%s\n' '{"id":"1","type":"get_commands"}' >"$RPC_IN"
RPC_STATUS=0
(cd "$PROBE_PROJECT" && PI_CODING_AGENT_DIR="$PROBE_AGENT" pi \
  -e "$WORKTREE/verification/ci-canary.ts" --mode rpc -a <"$RPC_IN") \
  >"$RPC_OUT" 2>"$RPC_ERR" || RPC_STATUS=$?
if (( RPC_STATUS != 0 )); then
  printf 'Registry-load RPC exited %s.\n' "$RPC_STATUS" >&2
  cat "$RPC_ERR" >&2
  cat "$RPC_OUT" >&2
  exit 1
fi
if grep -Fq -e 'Failed to load extension' -e 'Extension error (' "$RPC_ERR"; then
  printf 'Registry-load stderr contains an extension failure marker.\n' >&2
  cat "$RPC_ERR" >&2
  exit 1
fi

node - "$RPC_OUT" "$RPC_ERR" "$INSTALLED_DIR" "$PROBE_PROJECT" "$PACKAGE" "$VERSION" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [stdoutPath, stderrPath, installedDir, projectDir, packageName, version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(installedDir, "package.json"), "utf8"));
if (manifest.name !== packageName || manifest.version !== version) {
  throw new Error(`installed package is ${manifest.name}@${manifest.version}`);
}
const canaryLines = fs.readFileSync(stderrPath, "utf8").split("\n")
  .map(line => line.trim()).filter(line => line.startsWith("CI-CANARY "));
if (canaryLines.length !== 1) throw new Error(`expected one canary line, found ${canaryLines.length}`);
const canary = JSON.parse(canaryLines[0].slice("CI-CANARY ".length));
if (canary.trusted !== true) throw new Error(`probe project is not trusted: ${JSON.stringify(canary)}`);
if (fs.realpathSync(canary.cwd) !== fs.realpathSync(projectDir)) throw new Error(`canary ran in ${canary.cwd}`);
for (const tool of ["thread", "threads", "episode"]) {
  if (!Array.isArray(canary.tools) || !canary.tools.includes(tool)) throw new Error(`missing registered tool ${tool}`);
}
const objects = [];
for (const [index, line] of fs.readFileSync(stdoutPath, "utf8").split("\n").entries()) {
  if (!line.trim()) continue;
  try { objects.push(JSON.parse(line)); }
  catch (error) { throw new Error(`RPC stdout line ${index + 1} is not JSON: ${error.message}`); }
}
const extensionErrors = objects.filter(value => value?.type === "extension_error");
if (extensionErrors.length !== 0) throw new Error(`extension_error event(s): ${JSON.stringify(extensionErrors)}`);
const response = objects.find(value => value?.type === "response" && value?.command === "get_commands");
const slate = response?.data?.commands?.filter(value => value?.name === "slate") ?? [];
if (slate.length !== 1) throw new Error(`expected one /slate command, found ${slate.length}`);
const loadedPath = slate[0]?.sourceInfo?.path;
if (typeof loadedPath !== "string") throw new Error("/slate has no loaded source path");
const installedReal = fs.realpathSync(installedDir);
const loadedReal = fs.realpathSync(loadedPath);
if (!loadedReal.startsWith(installedReal + path.sep)) {
  throw new Error(`slate loaded from ${loadedReal}, outside installed package ${installedReal}`);
}
const entries = manifest.pi?.extensions;
if (!Array.isArray(entries) || !entries.some(entry =>
  typeof entry === "string" && fs.realpathSync(path.resolve(installedReal, entry)) === loadedReal)) {
  throw new Error(`loaded path ${loadedReal} is not a declared extension entry`);
}
process.stdout.write(`trusted registry package loaded from ${loadedReal}; thread, threads and episode are registered; no extension failure was reported\n`);
NODE
```

The second block starts a real TUI session through a pseudo-terminal. It uses an
offline fake provider loaded beside the published package. The provider receives
the final system prompt after every `before_agent_start` handler, so it can check
the doctrine without trusting a model recitation. The check requires the Slate
heading and the four unconditional documentation paths exactly once. A headless
run never builds the doctrine, so the TUI phase is mandatory.

```bash
set -euo pipefail
: "${SLATE_RELEASE:?Declare the release first: export SLATE_RELEASE=<version>}"
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" PACKAGE VERSION REGISTRY_VERIFIED_AT)
eval "$STATE"

unset PROBE_BASE PROBE_ROOT
PROBE_BASE=""
PROBE_ROOT=""
cleanup_alert() {
  printf '\n%s\n%s\n' '!!! PROBE CLEANUP INCOMPLETE !!!' "$1" >&2
}
cleanup_probe() {
  local base=${PROBE_BASE:-} target=${PROBE_ROOT:-} cleanup_failed=0 leftovers=0
  if [[ -z "$base" || -z "$target" ]]; then
    cleanup_alert 'Probe cleanup has an unset path. Inspect the release scratch area and remove leftovers by hand.'
    return 1
  fi
  case "$base:$target" in /*:/*) ;; *)
    cleanup_alert "Probe paths are not absolute: $base : $target. Remove any leftovers by hand."
    return 1
  esac
  case "$target" in "$base"/*) ;; *)
    cleanup_alert "Probe root is outside its block-created base: $target. Remove it by hand."
    return 1
  esac
  if [[ -d "$target" ]]; then
    if ! rm -rf -- "$target"; then
      cleanup_alert "Automatic removal failed. REMOVE THIS PATH BY HAND: $target"
      cleanup_failed=1
    fi
  else
    cleanup_alert "Expected probe root is not a directory: $target. Inspect the paths below and remove leftovers by hand."
    cleanup_failed=1
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    cleanup_alert "REMOVE THIS PATH BY HAND: $target"
    cleanup_failed=1
  fi
  if [[ -d "$base" ]]; then
    while IFS= read -r -d '' leftover; do
      cleanup_alert "REMOVE THIS PATH BY HAND: $leftover"
      leftovers=$((leftovers + 1))
      cleanup_failed=1
    done < <(find "$base" -mindepth 1 -maxdepth 1 -print0)
    if (( leftovers == 0 )) && ! rmdir "$base"; then
      cleanup_alert "Automatic removal failed. REMOVE THIS PATH BY HAND: $base"
      cleanup_failed=1
    fi
  elif [[ -e "$base" || -L "$base" ]]; then
    cleanup_alert "Probe base is not a directory. REMOVE THIS PATH BY HAND: $base"
    cleanup_failed=1
  fi
  return "$cleanup_failed"
}
trap cleanup_probe EXIT
trap 'exit 130' INT TERM
mkdir -p "$RELEASE_DIR/evidence"
PROBE_BASE=$(mktemp -d "$RELEASE_DIR/registry-load-doctrine.XXXXXX")
PROBE_ROOT=$(mktemp -d "$PROBE_BASE/probe.XXXXXX")
PROBE_PROJECT="$PROBE_ROOT/project"
PROBE_AGENT="$PROBE_ROOT/agent"
PROBE_HOME="$PROBE_ROOT/home"
PROBE_TMP="$PROBE_ROOT/tmp"
mkdir -p "$PROBE_PROJECT/.pi" "$PROBE_AGENT" "$PROBE_HOME" "$PROBE_TMP"
printf '{}\n' >"$PROBE_AGENT/settings.json"
node - "$PROBE_PROJECT/.pi/settings.json" "$PACKAGE" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [settingsPath, packageName, version] = process.argv.slice(2);
fs.writeFileSync(settingsPath, `${JSON.stringify({ packages: [`npm:${packageName}@${version}`] }, null, 2)}\n`);
NODE

INSTALL_OUT="$RELEASE_DIR/evidence/registry-doctrine-install.out"
INSTALL_ERR="$RELEASE_DIR/evidence/registry-doctrine-install.err"
if ! (cd "$PROBE_PROJECT" && PI_CODING_AGENT_DIR="$PROBE_AGENT" \
  pi install -l --approve "npm:$PACKAGE@$VERSION") >"$INSTALL_OUT" 2>"$INSTALL_ERR"; then
  cat "$INSTALL_ERR" >&2
  cat "$INSTALL_OUT" >&2
  exit 1
fi
cat "$INSTALL_OUT"
cat "$INSTALL_ERR" >&2

PACKAGE_LIST="$RELEASE_DIR/evidence/registry-doctrine-package-list.txt"
(cd "$PROBE_PROJECT" && PI_CODING_AGENT_DIR="$PROBE_AGENT" NO_COLOR=1 pi list -a) >"$PACKAGE_LIST"
INSTALLED_DIR=$(awk -v spec="  npm:$PACKAGE@$VERSION" '
  $0 == "Project packages:" { project = 1; next }
  project && $0 == spec { getline; sub(/^[[:space:]]+/, ""); print; exit }
' "$PACKAGE_LIST")
if [[ -z "$INSTALLED_DIR" || ! -f "$INSTALLED_DIR/package.json" ]]; then
  printf 'Cannot locate the installed package after explicit installation. pi list output:\n' >&2
  cat "$PACKAGE_LIST" >&2
  exit 1
fi

DOCTRINE_EVIDENCE="$RELEASE_DIR/evidence/registry-doctrine.json"
DOCTRINE_TRANSCRIPT="$RELEASE_DIR/evidence/registry-doctrine-tui.raw"
DOCTRINE_CANARY="$PROBE_ROOT/doctrine-canary.mjs"
cat >"$DOCTRINE_CANARY" <<'MJS'
import { writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const evidencePath = process.env.SLATE_DOCTRINE_EVIDENCE;
const packageRoot = process.env.SLATE_DOCTRINE_PACKAGE_ROOT;
let trusted = false;

function message(model, text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function completedStream(output) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...output, stopReason: "pending" } });
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
  });
  return stream;
}

export default function doctrineCanary(pi) {
  pi.on("session_start", (_event, ctx) => { trusted = ctx.isProjectTrusted(); });
  pi.registerProvider("slate-doctrine-fake", {
    name: "Slate doctrine offline canary",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "offline-canary-key",
    api: "openai-completions",
    models: [{
      id: "doctrine-model",
      name: "Doctrine model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 1_024,
    }],
    streamSimple(model, context) {
      const systemPrompt = context.systemPrompt ?? "";
      const required = [
        "# Slate orchestrator mode",
        `${packageRoot}/docs/track-workflow.md`,
        `${packageRoot}/docs/review-rules.md`,
        `${packageRoot}/docs/design-principles.md`,
      ];
      const counts = Object.fromEntries(required.map(value =>
        [value, systemPrompt.split(value).length - 1]));
      const result = {
        trusted,
        required,
        counts,
        exact: trusted && required.every(value => counts[value] === 1),
      };
      writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
      const text = result.exact ? "SLATE_DOCTRINE_CANARY_COMPLETE" : "SLATE_DOCTRINE_CANARY_FAILED";
      return completedStream(message(model, text));
    },
  });
}
MJS

PTY_RUNNER="$PROBE_ROOT/run-tui.py"
cat >"$PTY_RUNNER" <<'PY'
import os
import pty
import select
import signal
import sys
import time

pi_bin, project, agent, home, tmp, canary, evidence, package_root, transcript = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(project)
    env = {
        "HOME": home,
        "PATH": os.environ["PATH"],
        "PI_CODING_AGENT_DIR": agent,
        "SLATE_DOCTRINE_EVIDENCE": evidence,
        "SLATE_DOCTRINE_PACKAGE_ROOT": package_root,
        "TERM": "xterm-256color",
        "TMPDIR": tmp,
    }
    os.execvpe(pi_bin, [pi_bin, "-e", canary, "-a", "--provider",
        "slate-doctrine-fake", "--model", "doctrine-model"], env)

start = time.monotonic()
deadline = start + 120
sent_mode = False
sent_prompt = False
requested_exit = False
saw_provider_result = False
output = bytearray()
status = None
with open(transcript, "wb") as transcript_file:
    while time.monotonic() < deadline:
        done, child_status = os.waitpid(pid, os.WNOHANG)
        if done:
            status = child_status
            break
        readable, _, _ = select.select([fd], [], [], 0.2)
        if readable:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if data:
                output.extend(data)
                transcript_file.write(data)
                transcript_file.flush()
        elapsed = time.monotonic() - start
        if not sent_mode and elapsed >= 2:
            os.write(fd, b"/slate on\r")
            sent_mode = True
        if sent_mode and not sent_prompt and elapsed >= 4:
            os.write(fd, b"Run the doctrine validation.\r")
            sent_prompt = True
        if sent_prompt and os.path.exists(evidence):
            saw_provider_result = (b"SLATE_DOCTRINE_CANARY_COMPLETE" in output or
                b"SLATE_DOCTRINE_CANARY_FAILED" in output)
        if saw_provider_result and not requested_exit:
            os.write(fd, b"\x04")
            requested_exit = True
        if requested_exit and elapsed >= 15:
            break

if status is None:
    os.kill(pid, signal.SIGTERM)
    _, status = os.waitpid(pid, 0)
    print("TUI did not exit cleanly after the doctrine result", file=sys.stderr)
    sys.exit(1)
exit_code = os.waitstatus_to_exitcode(status)
print(f"TUI exit={exit_code}; doctrine provider reached={saw_provider_result}")
if exit_code != 0 or not saw_provider_result:
    sys.exit(1)
PY

PI_BIN=$(command -v pi)
python3 "$PTY_RUNNER" "$PI_BIN" "$PROBE_PROJECT" "$PROBE_AGENT" "$PROBE_HOME" \
  "$PROBE_TMP" "$DOCTRINE_CANARY" "$DOCTRINE_EVIDENCE" "$INSTALLED_DIR" \
  "$DOCTRINE_TRANSCRIPT"
if grep -aFq -e 'Failed to load extension' -e 'Extension error (' "$DOCTRINE_TRANSCRIPT"; then
  printf 'Interactive doctrine transcript contains an extension failure marker.\n' >&2
  exit 1
fi
node - "$DOCTRINE_EVIDENCE" <<'NODE'
const fs = require("node:fs");
const evidence = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (evidence.trusted !== true) throw new Error("interactive project was not trusted");
if (evidence.exact !== true) throw new Error(`doctrine markers were not exact: ${JSON.stringify(evidence)}`);
if (!Array.isArray(evidence.required) || evidence.required.length !== 5) {
  throw new Error(`unexpected doctrine marker roster: ${JSON.stringify(evidence.required)}`);
}
process.stdout.write(`interactive doctrine check passed: ${evidence.required.join(" | ")}\n`);
NODE
```

Both blocks remove their project and agent directory on success, failure, or
interruption. Each block ignores inherited probe variables and removes only the
root it created under its own temporary base. The evidence remains under
`$RELEASE_DIR/evidence/`.

The probe runs the package being released. In-probe subversion of cleanup is out
of scope. Any leftover directory under the release scratch area is reported with
its exact path for manual removal rather than treated as a security boundary.
Continue to step 7 only after both blocks pass.

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

# Re-derive the artifact facts.
[[ -f "$TARBALL" ]]
HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r NOW_SHA256 NOW_INTEGRITY <<<"$HASHES"
[[ "$NOW_SHA256" == "$TARBALL_SHA256" && "$NOW_INTEGRITY" == "$TARBALL_INTEGRITY" ]]

# Re-derive the registry facts. This is the gate, not a stored result.
LIVE_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity --json)
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
[[ "$(npm view "$PACKAGE@$VERSION" version)" == "$VERSION" ]]
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" --expect "$SLATE_RELEASE" TAGGED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

`--target "$SQUASH_SHA"` is not decoration. Without it the release records the default branch head, which is why the last release's `targetCommitish` did not match the commit the runbook's own final check demanded. When the tag already exists the target is cosmetic — GitHub takes the commit from the tag — but the check compares it, so it must be set.

The normal restart states are: nothing exists (create, push, release); only the correct local tag exists (skip creation, then push and release); the correct remote tag exists with no release (ensure the local tag, skip the push, create the release); or the correct remote tag and release both exist (ensure the local tag, skip both remote actions). If any existing tag or release target is wrong, stop, inspect who created it and why, and resolve it manually under repository policy. This runbook never moves or deletes a conflicting tag. The tag must point at the umbrella squash SHA.

## Step 8 — the agent tears down the release worktree

The first release left a worktree detached at the squash commit because no step removed it. This step is not optional, and it runs whether the release succeeded or was abandoned. **The failure path is untested**; the success path is the same commands.

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

Read the final `git worktree list`: no path under the release directory may remain, and no worktree may be left detached by this release. Keep `$RELEASE_DIR` — the tarball, the hashes and the evidence are the record of what was published. Delete it by hand when it is no longer wanted.

If an escalation is open, skip this step until the escalation closes, then run it.

## Consumers

Consumers install pinned with `pi install -l npm:ytdb-slate@<version>`. Pi skips pinned specs during `pi update`, so consumers bump their pin deliberately. On every bump, they must re-review their project delta documents (`doctrineExtraPath`, `reviewPerspectivesPath`, and prompt-document lists) against the shipped doctrine for drift.
