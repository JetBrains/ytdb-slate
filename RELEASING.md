# Releasing ytdb-slate

Nine steps, in order. The agent owns most of them. The user owns two: the merge and the publication.

Every command block enables fail-closed shell behavior. Do not continue after a failed command unless the applicable recovery branch says to continue.

## How to read this runbook

**Steps may run in separate sessions.** The first real release ran across four agent actions. Nothing carries between them in shell variables, so no step trusts one. Every block reloads machine-written state from a file, revalidates it, and re-derives the facts it gates on. A block that gates on a registry fact re-reads the registry; a typed word never unlocks anything.

**No step assumes a single checkout.** This repository is worked in many worktrees at once — eleven at the time of writing. Every git command names its repository with `git -C`, and every gh command names its repository with `--repo`. The release itself happens in a dedicated worktree that step 9 removes.

**Some paths have never executed.** They are marked **Untested.** where they appear, and listed under "Untested paths" below. A marked path is reviewed, not proven. Read it before you run it.

**Never set a state value by hand.** If a block stops because a state key is missing or malformed, re-run the step that writes that key. Hand-setting the value is how the first release turned a guard into a formality.

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
    checkout/          # the release worktree, detached at the squash commit
    pin/               # the pin worktree, detached at origin/main
```

Keep the whole `<version>` directory until the release closes. Step 9 removes the worktrees and clears the `current` pointer; it keeps the evidence.

## Untested paths

These have never run. Treat any of them as a hypothesis and read the commands before executing them.

- The integrity-mismatch halt in step 6, and the deprecation proposal under it.
- The inconclusive branch and escalation in step 6.
- Every restart state in step 7 except "nothing exists yet".
- The `ERR` restore in step 8.
- Teardown after a failure in step 9.

## Step 0 — the agent starts the release

Replace every `REPLACE_*` value. The guards reject placeholders, empty values, invalid versions and an invalid PR number.

Re-running this block for the same version is safe: `init` keeps existing state and fails if a value would change. That is what makes a restart in a new session possible.

```bash
set -euo pipefail
PACKAGE='ytdb-slate'
VERSION='REPLACE_VERSION'
PRIOR_VERSION='REPLACE_PRIOR_VERSION'
PR='REPLACE_PR_NUMBER'
[[ "$VERSION" != REPLACE_* && "$PRIOR_VERSION" != REPLACE_* && "$PR" != REPLACE_* ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$PRIOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$VERSION" != "$PRIOR_VERSION" ]]
[[ "$PR" =~ ^[1-9][0-9]*$ ]]
TAG="v$VERSION"

REPO_DIR=$(git rev-parse --show-toplevel)
[[ "$REPO_DIR" == /* ]]
GIT_COMMON_DIR=$(cd "$(git -C "$REPO_DIR" rev-parse --git-common-dir)" && pwd)
REPO=$(cd "$REPO_DIR" && gh repo view --json nameWithOwner --jq '.nameWithOwner')
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]

STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release"
RELEASE_DIR="$STATE_ROOT/$VERSION"
mkdir -p "$RELEASE_DIR/evidence" "$RELEASE_DIR/artifact"

cat >"$RELEASE_DIR/state.cjs" <<'CJS'
const fs = require("node:fs");

const FIELDS = {
  PACKAGE: /^ytdb-slate$/,
  VERSION: /^[0-9]+\.[0-9]+\.[0-9]+$/,
  PRIOR_VERSION: /^[0-9]+\.[0-9]+\.[0-9]+$/,
  PR: /^[1-9][0-9]*$/,
  TAG: /^v[0-9]+\.[0-9]+\.[0-9]+$/,
  REPO: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  REPO_DIR: /^\/[^'\n]*$/,
  GIT_COMMON_DIR: /^\/[^'\n]*$/,
  RELEASE_DIR: /^\/[^'\n]*$/,
  SQUASH_SHA: /^[0-9a-f]{40}$/,
  WORKTREE: /^\/[^'\n]*$/,
  PIN_WORKTREE: /^\/[^'\n]*$/,
  TARBALL: /^\/[^'\n]*\.tgz$/,
  TARBALL_SHA256: /^[0-9a-f]{64}$/,
  TARBALL_INTEGRITY: /^sha512-[A-Za-z0-9+/]+={0,2}$/,
  REGISTRY_INTEGRITY: /^sha512-[A-Za-z0-9+/]+={0,2}$/,
  HANDOFF_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
  REGISTRY_VERIFIED_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
  TAGGED_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
  PINNED_AT: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/,
};

const [mode, statePath, ...rest] = process.argv.slice(2);
if (!mode || !statePath) throw new Error("usage: state.cjs <init|save|load> <state.json> ...");

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
  const state = readState();
  for (const [key, value] of parsePairs()) {
    if (key in state && state[key] !== value) {
      if (mode === "init") throw new Error(`refusing to change ${key} from ${state[key]} to ${value}; this is a different release`);
      process.stderr.write(`state: ${key} ${state[key]} -> ${value}\n`);
    }
    state[key] = value;
  }
  write(state);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
} else if (mode === "load") {
  const state = readState();
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
  PACKAGE="$PACKAGE" VERSION="$VERSION" PRIOR_VERSION="$PRIOR_VERSION" PR="$PR" TAG="$TAG" \
  REPO="$REPO" REPO_DIR="$REPO_DIR" GIT_COMMON_DIR="$GIT_COMMON_DIR" RELEASE_DIR="$RELEASE_DIR"
printf '%s\n' "$RELEASE_DIR" >"$STATE_ROOT/current"
printf 'release state: %s\n' "$RELEASE_DIR"
```

Every later block opens with the same four lines. They read the pointer, load the state, and stop if a required key is absent:

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" VERSION)
eval "$STATE"
```

## Step 1 — the agent prepares the umbrella PR

Bump only `version` in `package.json`. Leave `.pi/settings.json` pinned to `npm:ytdb-slate@$PRIOR_VERSION`; step 8 moves the pin, after npm serves the new version. Follow `docs/pr-publishing.md` through the ready flip. Do not publish from the PR branch.

Run this in the PR branch checkout, not in a release worktree — none exists yet.

**Run the full verification set, not only the typecheck.** `AGENTS.md` names three automated nets and one manual load test, each with its own trigger. A release ships every file, so the release runs all of the automated ones unconditionally rather than deciding which of them the diff implicated:

- `npm run typecheck` — the type gate. Seconds.
- `bash verification/run-resolver-checks.sh --repo . --strict` — the pure pipelines: worker extensions, the doctrine rules, the model router, the dispatch guards, the state sanitizers, the profile table. About a second.
- `bash verification/run-ladder.sh --repo . --strict` — the model-switch machinery and the worker settings isolation. About three minutes. Do not run it as root; it needs GNU coreutils.
- The isolated-load smoke test, below. Judge it by the absence of a `Failed to load extension` line, never by the exit code: pi exits 0 when extension loading fails.

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" PACKAGE VERSION PRIOR_VERSION PR REPO_DIR)
eval "$STATE"
cd "$REPO_DIR"
[[ -z "$(git -C "$REPO_DIR" status --porcelain)" ]]

node - "$VERSION" "$PRIOR_VERSION" <<'NODE'
const fs = require("node:fs");
const [version, priorVersion] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const settings = JSON.parse(fs.readFileSync(".pi/settings.json", "utf8"));
if (manifest.version !== version) throw new Error(`package version is ${manifest.version}`);
const sources = (settings.packages ?? []).map(value => typeof value === "string" ? value : value.source);
const slate = sources.filter(value => typeof value === "string" && value.startsWith("npm:ytdb-slate@"));
const expected = `npm:ytdb-slate@${priorVersion}`;
if (slate.length !== 1 || slate[0] !== expected) throw new Error(`dogfood pin is ${JSON.stringify(slate)}`);
NODE

npm run typecheck
bash verification/run-resolver-checks.sh --repo . --strict
bash verification/run-ladder.sh --repo . --strict

LOAD_LOG="$RELEASE_DIR/evidence/isolated-load.log"
pi --no-extensions -e . -p exit >"$LOAD_LOG" 2>&1 || true
cat "$LOAD_LOG"
if grep -Fq 'Failed to load extension' "$LOAD_LOG"; then
  printf 'Extension failed to load; stop.\n' >&2
  exit 1
fi
```

That headless run proves registration and `session_start` only. It never enters orchestrator mode, so it never builds the doctrine and never consults the router. **If the release changes doctrine rendering, the router, or any dispatch path, also open an interactive `pi --no-extensions -e .` session and exercise the tools by hand before flipping the PR to ready.** The automated nets cover the resolution and the rendering; only a live session proves the wiring runs.

Finally, re-read the full diff before requesting the merge.

## Step 2 — the user merges

The user squash-merges the umbrella PR. The agent must not merge it.

## Step 3 — the agent identifies the merged commit and creates the release worktree

Take the squash SHA from GitHub, not from recent history. If state already holds a SQUASH_SHA, it must match the freshly derived one; a mismatch means the PR was re-merged and the release must restart at step 0 with a new version.

The release worktree isolates the release from every other checkout. Nothing here switches a branch, so nothing collides with a branch that another worktree holds.

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" PR REPO REPO_DIR)
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

node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" SQUASH_SHA="$SQUASH_SHA" WORKTREE="$WORKTREE"
```

Stop if GitHub does not report an exact merge commit or any check fails. Ancestry alone is not proof that the intended PR produced the SHA.

## Step 4 — the agent verifies and packs the exact commit

Verify the release version and the prior serviceable pin from the merged commit itself, then build the tarball inside the release worktree.

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" VERSION PRIOR_VERSION SQUASH_SHA WORKTREE)
eval "$STATE"
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]
[[ -z "$(git -C "$WORKTREE" status --porcelain)" ]]

node - "$WORKTREE/package.json" "$WORKTREE/.pi/settings.json" "$VERSION" "$PRIOR_VERSION" <<'NODE'
const fs = require("node:fs");
const [manifestPath, settingsPath, version, priorVersion] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
if (manifest.version !== version) throw new Error(`merged package version is ${manifest.version}`);
const sources = (settings.packages ?? []).map(value => typeof value === "string" ? value : value.source);
const slate = sources.filter(value => typeof value === "string" && value.startsWith("npm:ytdb-slate@"));
const expected = `npm:ytdb-slate@${priorVersion}`;
if (slate.length !== 1 || slate[0] !== expected) throw new Error(`merged dogfood pin is ${JSON.stringify(slate)}`);
NODE
```

Create and inspect the actual tarball that will be published. Do not rely on the clean source tree or a dry run. The tarball goes into the release directory, not `/tmp`: the user publishes it in a later session, and `/tmp` does not have to survive that long.

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" VERSION SQUASH_SHA WORKTREE)
eval "$STATE"
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]

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
NODE

for path in \
  extension/index.ts \
  README.md \
  LICENSE
do
  [[ -f "$PACK_DIR/unpacked/package/$path" ]]
done

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
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" \
  TARBALL="$TARBALL" TARBALL_SHA256="$TARBALL_SHA256" TARBALL_INTEGRITY="$TARBALL_INTEGRITY"
printf 'tarball:   %s\nsha256:    %s\nintegrity: %s\n' "$TARBALL" "$TARBALL_SHA256" "$TARBALL_INTEGRITY"
```

The docs check compares the tarball against the `docs/` tree of the merged commit and requires exact equality, so it cannot go stale when a document is added — as it did when it named five of the seven shipped documents. The floor of seven catches an empty or truncated `docs/` tree, and the named five are the documents the doctrine dereferences at runtime; a publish without them ships a broken doctrine.

`TARBALL_SHA256` and `TARBALL_INTEGRITY` are the record of the inspected bytes. `TARBALL_INTEGRITY` is in npm's own `dist.integrity` form, so step 6 compares the registry's value against it directly.

Read the `tar` listing for unexpected files as well as running the explicit checks. Stop before the handoff if the tarball is wrong.

## Step 5 — the user publishes

The agent does not publish. The npm account requires two-factor authentication, and both existing releases were published by the user after the agent could not complete the transaction. Publication is the user's step for the same reason the merge is: it needs the user's credentials and the user's consent. The agent prepares the artifact, hands over one exact command against one exact file, and verifies the result afterwards.

**The agent prints the handoff.** It hands over the absolute path of the inspected tarball and the hashes of its bytes, so both sides of the handoff refer to the same artifact:

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" PACKAGE VERSION TARBALL TARBALL_SHA256 TARBALL_INTEGRITY)
eval "$STATE"
[[ -f "$TARBALL" ]]
HASHES=$(node "$RELEASE_DIR/hash.cjs" "$TARBALL")
read -r NOW_SHA256 NOW_INTEGRITY <<<"$HASHES"
[[ "$NOW_SHA256" == "$TARBALL_SHA256" && "$NOW_INTEGRITY" == "$TARBALL_INTEGRITY" ]]
mkdir -p "$RELEASE_DIR/evidence"
HANDOFF_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" HANDOFF_AT="$HANDOFF_AT"
cat <<HANDOFF
Publish $PACKAGE@$VERSION. Run this in your own terminal, so you can answer the
two-factor prompt:

  npm publish '$TARBALL' 2>&1 | tee '$RELEASE_DIR/evidence/publish.log'

The inspected bytes are:

  sha256     $TARBALL_SHA256
  integrity  $TARBALL_INTEGRITY

npm prints a shasum and an integrity line before it uploads. The integrity line
must equal the value above. If it does not, stop and do not confirm the upload.

Publish this file and no other. Do not repack it. Tell the agent when the
command has finished, and whether it succeeded.
HANDOFF
```

**The user publishes.** Run the printed command, complete two-factor, keep the log. If the command fails, say so and stop; do not retry it without the agent, because a second attempt against an accepted transaction is the one thing this runbook cannot undo.

**The agent waits.** It does not run `npm publish`, does not repack, and does not infer the outcome from what the user reports. It proceeds to step 6 after the user says the command finished, whatever the user believes happened.

## Step 6 — the agent verifies the published artifact

This is the check the old runbook threw away: it fetched `dist.integrity` and compared it to nothing. Here the registry's integrity value is compared against the recorded integrity of the inspected bytes, and the served tarball is compared byte for byte against the retained one. A handoff can substitute a different artifact; this is what detects it.

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" PACKAGE VERSION TARBALL TARBALL_SHA256 TARBALL_INTEGRITY HANDOFF_AT)
eval "$STATE"
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
    REGISTRY_DIR="$RELEASE_DIR/registry"
    rm -rf "$REGISTRY_DIR"
    mkdir -p "$REGISTRY_DIR"
    if REGISTRY_JSON=$(cd "$REGISTRY_DIR" && npm pack "$PACKAGE@$VERSION" --json --pack-destination "$REGISTRY_DIR" 2>>"$VIEW_ERROR"); then
      REGISTRY_TARBALL="$REGISTRY_DIR/$(node -e "const x=JSON.parse(process.argv[1]);if(x.length!==1)throw Error('unexpected registry pack result');process.stdout.write(x[0].filename)" "$REGISTRY_JSON")"
      [[ -f "$REGISTRY_TARBALL" ]]
      if cmp "$TARBALL" "$REGISTRY_TARBALL"; then
        REGISTRY_RESULT='verified'
      else
        REGISTRY_RESULT='integrity-mismatch'
      fi
    fi
  fi
fi

printf '%s\n' "$REGISTRY_RESULT" >"$RELEASE_DIR/evidence/registry-result.txt"
printf 'registry result: %s\nregistry integrity: %s\nrecorded integrity: %s\n' \
  "$REGISTRY_RESULT" "$REGISTRY_INTEGRITY" "$TARBALL_INTEGRITY"
if [[ "$REGISTRY_RESULT" == 'verified' ]]; then
  node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" \
    REGISTRY_INTEGRITY="$REGISTRY_INTEGRITY" REGISTRY_VERIFIED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
```

`registry-result.txt` and the recorded timestamp are a record, not a key. Steps 7 and 8 re-run the registry comparison themselves, so writing `verified` into a file or a variable unlocks nothing.

Use the matching branch:

- **`verified`.** npm serves the inspected bytes. Continue to step 7.

- **`integrity-mismatch`. Untested.** npm serves something other than the inspected artifact under an immutable version number. **Stop and hand the decision to the user.** Do not tag, release or pin. Do not deprecate anything on the agent's own authority: deprecation is public and it burns the version number, and no automatic reading of a byte difference is worth that. Report to the user: the recorded integrity, the served integrity, the path of both tarballs, and the likely causes — a different file was published, a repack happened between inspection and publication, or the registry served a corrupted copy. Re-run the comparison once after a few minutes before concluding, because a mid-propagation read can differ.

  If, and only if, the user confirms the published artifact is wrong and authorises the recovery, these are the commands. They are a proposal, and they have never run:

  ```bash
  set -euo pipefail
  RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
  STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" PACKAGE VERSION PRIOR_VERSION)
  eval "$STATE"
  [[ "$(cat "$RELEASE_DIR/evidence/registry-result.txt")" == 'integrity-mismatch' ]]
  DEPRECATION="Defective release; use $PRIOR_VERSION pending a corrected release"
  npm deprecate "$PACKAGE@$VERSION" "$DEPRECATION"
  [[ "$(npm view "$PACKAGE@$VERSION" deprecated)" == "$DEPRECATION" ]]
  npm dist-tag add "$PACKAGE@$PRIOR_VERSION" latest
  [[ "$(npm view "$PACKAGE" dist-tags.latest)" == "$PRIOR_VERSION" ]]
  ```

  `npm deprecate` and `npm dist-tag` are also write operations against a two-factor account, so the user may have to run them too. Afterwards, start the next unused patch version at step 0. A published version cannot be replaced or reused.

- **`inconclusive`. Untested.** The lookup failed. That can mean absence, propagation delay, lost permission, or a registry or network failure, and none of them is authoritative. Do not publish again.

  1. Preserve the evidence. It already belongs in `$RELEASE_DIR/evidence/`: `publish.log` from the user, `registry-view.err`, `registry-view.json` if it exists, `registry-result.txt`. Add the recorded `sha256` and integrity from `release.json`, which is already there. This directory is outside `/tmp` and outside the repository, so it survives a reboot and a worktree removal.
  2. Wait and re-read. Re-run the step 6 block after 15 minutes, up to four times over an hour. Propagation delay resolves in that window.
  3. Widen the read once before escalating. `npm view "$PACKAGE" --json` returns the whole package document; enumerate its `versions` array rather than trusting a single-version E404. That distinction was what identified the true state during the first release.
  4. Escalate if it is still unresolved. Open a ticket at <https://www.npmjs.com/support> against the package `ytdb-slate`. Include: the version, the publish timestamp from `publish.log`, the full publish log, the `npm view` error output, the recorded sha256 and sha512 integrity, and the question asked plainly — was the publish transaction for this version accepted?
  5. Do not retry step 5 until npm support or a registry operator confirms that the transaction was not accepted. If the version becomes visible instead, re-run step 6 and follow the branch it reports.

  Leave the release worktree in place while an escalation is open; step 9 removes it when the release closes, either way.

## Step 7 — the agent tags and creates the release

This step gates on facts it derives itself. It re-hashes the retained tarball, re-reads the registry, and compares the served integrity against the recorded integrity, before it creates anything. No inherited variable and no word written in a file can advance it — which is precisely the defect this replaces: during the first release the tag guard read a value typed in from a previous session's report.

Write the release notes to `$RELEASE_DIR/release-note.md` first. The block requires the file and refuses an empty one.

The block is restart-safe. It determines the local tag, the remote tag and the GitHub release states before creating anything, and accepts only a lightweight tag at the intended commit. **Untested** for every restart state except "nothing exists yet".

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" PACKAGE VERSION TAG REPO REPO_DIR SQUASH_SHA WORKTREE TARBALL TARBALL_SHA256 TARBALL_INTEGRITY)
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
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$SQUASH_SHA" ]]

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
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" TAGGED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

`--target "$SQUASH_SHA"` is not decoration. Without it the release records the default branch head, which is why the last release's `targetCommitish` did not match the commit the runbook's own final check demanded. When the tag already exists the target is cosmetic — GitHub takes the commit from the tag — but the check compares it, so it must be set.

The normal restart states are: nothing exists (create, push, release); only the correct local tag exists (skip creation, then push and release); the correct remote tag exists with no release (ensure the local tag, skip the push, create the release); or the correct remote tag and release both exist (ensure the local tag, skip both remote actions). If any existing tag or release target is wrong, stop, inspect who created it and why, and resolve it manually under repository policy. This runbook never moves or deletes a conflicting tag. The tag must point at the umbrella squash SHA, not at the later pin-only commit.

## Step 8 — the agent bumps and validates the dogfooding pin

Last, and only after npm serves the verified artifact and step 7 passes.

The pin commit is made in its own detached worktree at `origin/main`, then pushed with `git push origin HEAD:main`. It never checks out the `main` branch, so it cannot collide with a worktree that already holds `main` — which is exactly where the first release stopped dead. Any local `main` elsewhere is left untouched and one commit behind; the note at the end of this step says how to catch it up.

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" PACKAGE VERSION PRIOR_VERSION TAG REPO REPO_DIR SQUASH_SHA TARBALL_INTEGRITY)
eval "$STATE"

# Re-derive the gates: npm serves the inspected bytes, and the tag and release exist at the squash commit.
LIVE_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity --json)
[[ "$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.version ?? ""))' "$LIVE_JSON")" == "$VERSION" ]]
[[ "$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x["dist.integrity"] ?? x.dist?.integrity ?? ""))' "$LIVE_JSON")" == "$TARBALL_INTEGRITY" ]]
git -C "$REPO_DIR" fetch origin main --tags
[[ "$(git -C "$REPO_DIR" ls-remote --refs origin "refs/tags/$TAG" | awk '{print $1}')" == "$SQUASH_SHA" ]]
[[ "$(gh release view "$TAG" --repo "$REPO" --json targetCommitish --jq '.targetCommitish')" == "$SQUASH_SHA" ]]

PIN_WORKTREE="$RELEASE_DIR/pin"
if [[ -e "$PIN_WORKTREE" ]]; then
  git -C "$PIN_WORKTREE" fetch origin main
  git -C "$PIN_WORKTREE" checkout --detach FETCH_HEAD
else
  git -C "$REPO_DIR" worktree add --detach "$PIN_WORKTREE" origin/main
fi
[[ -z "$(git -C "$PIN_WORKTREE" status --porcelain)" ]]
git -C "$PIN_WORKTREE" merge-base --is-ancestor "$SQUASH_SHA" HEAD
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" PIN_WORKTREE="$PIN_WORKTREE"

PIN_BACKUP="$RELEASE_DIR/settings.json.bak"
cp "$PIN_WORKTREE/.pi/settings.json" "$PIN_BACKUP"
trap 'cp "$PIN_BACKUP" "$PIN_WORKTREE/.pi/settings.json"' ERR

node - "$PIN_WORKTREE/.pi/settings.json" "$VERSION" "$PRIOR_VERSION" <<'NODE'
const fs = require("node:fs");
const [path, version, priorVersion] = process.argv.slice(2);
const before = fs.readFileSync(path, "utf8");
const prior = `"npm:ytdb-slate@${priorVersion}"`;
const next = `"npm:ytdb-slate@${version}"`;
const occurrences = before.split(prior).length - 1;
if (occurrences !== 1) throw new Error(`expected exactly one ${prior} in ${path}, found ${occurrences}`);
if (before.includes(`"npm:ytdb-slate@${version}"`)) throw new Error("the new pin is already present");
const after = before.replace(prior, next);
if (after === before) throw new Error("pin replacement changed nothing");
if (after.length !== before.length - prior.length + next.length) throw new Error("pin replacement changed more than the pin");
JSON.parse(after);
fs.writeFileSync(path, after);
NODE

node - "$PIN_WORKTREE/.pi/settings.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [path, version] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(path, "utf8"));
const sources = (settings.packages ?? []).map(value => typeof value === "string" ? value : value.source);
const slate = sources.filter(value => typeof value === "string" && value.startsWith("npm:ytdb-slate@"));
const expected = `npm:ytdb-slate@${version}`;
if (slate.length !== 1 || slate[0] !== expected) throw new Error(`new dogfood pin is ${JSON.stringify(slate)}`);
NODE

git -C "$PIN_WORKTREE" diff --numstat -- .pi/settings.json
[[ "$(git -C "$PIN_WORKTREE" diff --numstat -- .pi/settings.json)" == $'1\t1\t.pi/settings.json' ]]
```

The edit is a textual replacement of one quoted pin, not a JSON re-serialisation. Re-serialising with `JSON.stringify` reformatted the whole `packages` array on the 0.5.1 bump, which passed every check the runbook had and still produced a diff that was not the change anyone intended. The length assertion and the `1 1` numstat make a formatting change impossible to miss: any diff other than one line changed for one line is a failure.

Now validate what pi actually resolves and loads, in the pin worktree. `-a` forces project trust for this non-interactive run. Plain redirection waits for pi to exit before either log is inspected, so there is no process-substitution race. The settings assertion above, pi's project-package listing, the installed manifest check and the forced-trust startup together prove that the exact pinned package — not local source, not a stale pin — was selected and loaded:

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" PACKAGE VERSION PIN_WORKTREE)
eval "$STATE"
PIN_BACKUP="$RELEASE_DIR/settings.json.bak"
[[ -f "$PIN_BACKUP" ]]
trap 'cp "$PIN_BACKUP" "$PIN_WORKTREE/.pi/settings.json"' ERR

LOAD_STDOUT="$RELEASE_DIR/evidence/pin-load.out"
LOAD_STDERR="$RELEASE_DIR/evidence/pin-load.err"
if ! (cd "$PIN_WORKTREE" && pi -a -p "exit") >"$LOAD_STDOUT" 2>"$LOAD_STDERR"; then
  cat "$LOAD_STDERR" >&2
  false
fi
if grep -Fq 'Failed to load extension' "$LOAD_STDERR"; then
  cat "$LOAD_STDERR" >&2
  false
fi
PACKAGE_LIST="$RELEASE_DIR/evidence/pin-package-list.txt"
(cd "$PIN_WORKTREE" && NO_COLOR=1 pi list -a) >"$PACKAGE_LIST"
INSTALLED_DIR=$(awk -v spec="  npm:$PACKAGE@$VERSION" '
  $0 == "Project packages:" { project = 1; next }
  project && $0 == spec { getline; sub(/^[[:space:]]+/, ""); print; exit }
' "$PACKAGE_LIST")
[[ -n "$INSTALLED_DIR" && -f "$INSTALLED_DIR/package.json" ]]
node - "$INSTALLED_DIR/package.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [path, version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
if (manifest.name !== "ytdb-slate" || manifest.version !== version) throw new Error(`installed package is ${manifest.name}@${manifest.version}`);
if (!Array.isArray(manifest.pi?.extensions) || !manifest.pi.extensions.includes("./extension/index.ts")) throw new Error("installed package has no Slate extension entry");
NODE
trap - ERR
```

Do not use `pi --no-extensions -e .` here: it loads local source and cannot validate the pin. Any nonzero pi exit, `Failed to load extension` line, package-list mismatch or installed-manifest mismatch is a failure. The `ERR` trap restores the prior settings — **untested** — and the agent must not commit or push the new pin after any failure.

After the check passes, stage only `.pi/settings.json` and push the pin commit. The push is not forced and is attempted once; a rejection means `origin/main` moved, so stop and restart this step from the worktree refresh:

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" VERSION PIN_WORKTREE)
eval "$STATE"
git -C "$PIN_WORKTREE" add .pi/settings.json
[[ "$(git -C "$PIN_WORKTREE" diff --cached --name-only)" == '.pi/settings.json' ]]
git -C "$PIN_WORKTREE" diff --cached
git -C "$PIN_WORKTREE" commit -m "Dogfood $VERSION"
git -C "$PIN_WORKTREE" push origin HEAD:main
node "$RELEASE_DIR/state.cjs" save "$RELEASE_DIR/release.json" PINNED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Finally, recheck every published target and the default-branch pin:

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" PACKAGE VERSION TAG REPO REPO_DIR SQUASH_SHA TARBALL_INTEGRITY)
eval "$STATE"
git -C "$REPO_DIR" fetch origin main --tags
[[ "$(git -C "$REPO_DIR" rev-parse "$TAG^{commit}")" == "$SQUASH_SHA" ]]
[[ "$(git -C "$REPO_DIR" ls-remote --refs origin "refs/tags/$TAG" | awk '{print $1}')" == "$SQUASH_SHA" ]]
[[ "$(gh release view "$TAG" --repo "$REPO" --json targetCommitish --jq '.targetCommitish')" == "$SQUASH_SHA" ]]
LIVE_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity --json)
[[ "$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x.version ?? ""))' "$LIVE_JSON")" == "$VERSION" ]]
[[ "$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(String(x["dist.integrity"] ?? x.dist?.integrity ?? ""))' "$LIVE_JSON")" == "$TARBALL_INTEGRITY" ]]
FINAL_SETTINGS="$RELEASE_DIR/evidence/final-settings.json"
git -C "$REPO_DIR" show origin/main:.pi/settings.json >"$FINAL_SETTINGS"
node - "$FINAL_SETTINGS" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [path, version] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(path, "utf8"));
const sources = (settings.packages ?? []).map(value => typeof value === "string" ? value : value.source);
const slate = sources.filter(value => typeof value === "string" && value.startsWith("npm:ytdb-slate@"));
const expected = `npm:ytdb-slate@${version}`;
if (slate.length !== 1 || slate[0] !== expected) throw new Error(`default-branch dogfood pin is ${JSON.stringify(slate)}`);
NODE
```

Other worktrees that hold `main` are now one commit behind. Catch each one up when it is clean; never force it:

```bash
git -C /path/to/that/worktree status --porcelain
git -C /path/to/that/worktree pull --ff-only origin main
```

## Step 9 — the agent tears down the release worktrees

The first release left a worktree detached at the squash commit, carrying a stale pin, because no step removed it. This step is not optional, and it runs whether the release succeeded or was abandoned. **The failure path is untested**; the success path is the same commands.

```bash
set -euo pipefail
RELEASE_DIR=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current")
STATE=$(node "$RELEASE_DIR/state.cjs" load "$RELEASE_DIR/release.json" REPO_DIR)
eval "$STATE"

for TREE in "$RELEASE_DIR/checkout" "$RELEASE_DIR/pin"; do
  if [[ -e "$TREE" ]]; then
    if [[ -n "$(git -C "$TREE" status --porcelain)" ]]; then
      printf 'Worktree %s has uncommitted changes; inspect it before removing it.\n' "$TREE" >&2
      git -C "$TREE" status --porcelain >&2
      exit 1
    fi
    git -C "$REPO_DIR" worktree remove "$TREE"
  fi
done
git -C "$REPO_DIR" worktree prune
[[ ! -e "$RELEASE_DIR/checkout" && ! -e "$RELEASE_DIR/pin" ]]
git -C "$REPO_DIR" worktree list
rm -f "${XDG_STATE_HOME:-$HOME/.local/state}/ytdb-slate/release/current"
printf 'Release directory kept for the record: %s\n' "$RELEASE_DIR"
```

Read the final `git worktree list`: no path under the release directory may remain, and no worktree may be left detached by this release. Keep `$RELEASE_DIR` — the tarball, the hashes and the evidence are the record of what was published. Delete it by hand when it is no longer wanted.

If an escalation is open, skip this step until the escalation closes, then run it.

## Consumers

Consumers install pinned with `pi install -l npm:ytdb-slate@<version>`. Pi skips pinned specs during `pi update`, so consumers bump their pin deliberately. On every bump, they must re-review their project delta documents (`doctrineExtraPath`, `reviewPerspectivesPath`, and prompt-document lists) against the shipped doctrine for drift.
