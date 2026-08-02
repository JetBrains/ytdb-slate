# Releasing ytdb-slate

Follow these eight steps in one Bash shell and in order. Every command block enables fail-closed shell behavior. Do not continue after a failed command unless the applicable recovery branch says to continue.

Set the release values first. Replace every `REPLACE_*` value; the guards deliberately reject placeholders, empty values, invalid versions, and an invalid PR number.

```bash
set -euo pipefail
export PACKAGE='ytdb-slate'
export VERSION='REPLACE_VERSION'
export PRIOR_VERSION='REPLACE_PRIOR_VERSION'
export PR='REPLACE_PR_NUMBER'
[[ "$PACKAGE" == 'ytdb-slate' ]]
[[ "$VERSION" != REPLACE_* && "$PRIOR_VERSION" != REPLACE_* && "$PR" != REPLACE_* ]]
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$PRIOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$VERSION" != "$PRIOR_VERSION" ]]
[[ "$PR" =~ ^[1-9][0-9]*$ ]]
export TAG="v$VERSION"
[[ "$TAG" == "v$VERSION" ]]
```

1. **The agent prepares the umbrella PR.** Bump only `version` in `package.json`; leave `.pi/settings.json` pinned to `npm:ytdb-slate@$PRIOR_VERSION`. Run every required verification and follow `docs/pr-publishing.md` through the ready flip. Do not publish from the PR branch. These checks must pass:

   ```bash
   set -euo pipefail
   : "${PACKAGE:?Run the initialization block}" "${VERSION:?}" "${PRIOR_VERSION:?}" "${PR:?}" "${TAG:?}"
   [[ "$PACKAGE" == 'ytdb-slate' && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$PRIOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
   [[ "$VERSION" != "$PRIOR_VERSION" && "$PR" =~ ^[1-9][0-9]*$ && "$TAG" == "v$VERSION" ]]
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
   ```

2. **The user merges.** The user squash-merges the umbrella PR. The agent must not merge it.

3. **The agent identifies and verifies the merged commit.** Obtain the PR's exact squash SHA from GitHub, not from recent history, then fetch and test it:

   ```bash
   set -euo pipefail
   : "${PR:?Run the initialization block}"
   [[ "$PR" =~ ^[1-9][0-9]*$ ]]
   git fetch origin main
   export SQUASH_SHA
   SQUASH_SHA=$(gh pr view "$PR" --json mergeCommit --jq '.mergeCommit.oid')
   [[ "$SQUASH_SHA" =~ ^[0-9a-f]{40}$ ]]
   [[ "$(git rev-parse "$SQUASH_SHA^{commit}")" == "$SQUASH_SHA" ]]
   git merge-base --is-ancestor "$SQUASH_SHA" origin/main
   ```

   Stop if GitHub does not report an exact merge commit or any check fails. An ancestry check alone is not proof that the intended PR produced the SHA.

4. **The agent verifies and packs the exact commit before publication.** Verify the release version and prior serviceable pin from the commit itself, detach at that commit, and require a clean tree:

   ```bash
   set -euo pipefail
   : "${PACKAGE:?Run the initialization block}" "${VERSION:?}" "${PRIOR_VERSION:?}" "${SQUASH_SHA:?Run step 3}"
   [[ "$PACKAGE" == 'ytdb-slate' && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$PRIOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
   [[ "$SQUASH_SHA" =~ ^[0-9a-f]{40}$ ]]
   VERIFY_DIR=$(mktemp -d)
   git show "$SQUASH_SHA:package.json" >"$VERIFY_DIR/package.json"
   git show "$SQUASH_SHA:.pi/settings.json" >"$VERIFY_DIR/settings.json"
   node - "$VERIFY_DIR/package.json" "$VERIFY_DIR/settings.json" "$VERSION" "$PRIOR_VERSION" <<'NODE'
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
   git switch --detach "$SQUASH_SHA"
   [[ "$(git rev-parse HEAD)" == "$SQUASH_SHA" ]]
   [[ -z "$(git status --porcelain)" ]]
   ```

   Create and inspect the actual tarball that will be published; do not rely on the clean source tree or a dry run:

   ```bash
   set -euo pipefail
   : "${VERSION:?Run the initialization block}"
   [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
   export PACK_DIR TARBALL
   PACK_DIR=$(mktemp -d)
   PACK_JSON=$(npm pack --json --pack-destination "$PACK_DIR")
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
     docs/track-workflow.md \
     docs/review-rules.md \
     docs/design-principles.md \
     docs/pr-publishing.md \
     docs/model-routing.md \
     README.md \
     LICENSE
   do
     [[ -f "$PACK_DIR/unpacked/package/$path" ]]
   done
   ```

   Inspect the `tar` listing for unexpected files as well as running the explicit checks. Stop before publication if the tarball is wrong.

5. **The agent publishes the inspected tarball.** Only after steps 3 and 4 pass, run the publish command once. Its failure is captured instead of aborting this shell because step 6 is mandatory after every publish attempt:

   ```bash
   set -euo pipefail
   : "${PACKAGE:?Run the initialization block}" "${VERSION:?}" "${TARBALL:?Run step 4}"
   [[ "$PACKAGE" == 'ytdb-slate' && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && -f "$TARBALL" ]]
   export PUBLISH_STATUS PUBLISH_LOG
   PUBLISH_LOG=$(mktemp)
   set +e
   npm publish "$TARBALL" >"$PUBLISH_LOG" 2>&1
   PUBLISH_STATUS=$?
   set -e
   cat "$PUBLISH_LOG"
   printf 'npm publish exit status: %s\n' "$PUBLISH_STATUS"
   ```

   Keep `PUBLISH_LOG`. Do not infer the registry state from `PUBLISH_STATUS`. Continue directly to step 6 before any retry, tag, release, or pin change.

6. **The agent resolves the publication result and verifies the registry artifact.** A successful lookup of the exact version is conclusive. A failed lookup is not: it can mean absence, propagation delay, loss of permission, or a registry/network failure. This block records those states without allowing any state except `verified` through step 7:

   ```bash
   set -euo pipefail
   : "${PACKAGE:?Run the initialization block}" "${VERSION:?}" "${TARBALL:?Run step 4}" "${PUBLISH_STATUS:?Run step 5}"
   [[ "$PACKAGE" == 'ytdb-slate' && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && -f "$TARBALL" ]]
   export REGISTRY_RESULT='inconclusive'
   REGISTRY_ERROR=$(mktemp)
   if VIEW_JSON=$(npm view "$PACKAGE@$VERSION" version dist.integrity dist.tarball --json 2>"$REGISTRY_ERROR"); then
     [[ "$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(x.version)" "$VIEW_JSON")" == "$VERSION" ]]
     REGISTRY_DIR=$(mktemp -d)
     if REGISTRY_JSON=$(npm pack "$PACKAGE@$VERSION" --json --pack-destination "$REGISTRY_DIR" 2>>"$REGISTRY_ERROR"); then
       REGISTRY_TARBALL="$REGISTRY_DIR/$(node -e "const x=JSON.parse(process.argv[1]);if(x.length!==1)throw Error('unexpected registry pack result');process.stdout.write(x[0].filename)" "$REGISTRY_JSON")"
       [[ -f "$REGISTRY_TARBALL" ]]
       if cmp "$TARBALL" "$REGISTRY_TARBALL"; then
         REGISTRY_RESULT='verified'
       else
         REGISTRY_RESULT='wrong-artifact'
       fi
     fi
   fi
   export REGISTRY_RESULT
   printf 'registry result: %s\n' "$REGISTRY_RESULT"
   ```

   Use the matching recovery branch:

   - `verified`: publication succeeded and the served bytes match. Continue.
   - `wrong-artifact`: publication succeeded with a bad immutable version. Do not tag it, release it, or pin it. Deprecate it, restore the previous serviceable version as `latest`, and verify both recovery operations:

     ```bash
     set -euo pipefail
     : "${PACKAGE:?}" "${VERSION:?}" "${PRIOR_VERSION:?}" "${REGISTRY_RESULT:?Run the registry check}"
     [[ "$REGISTRY_RESULT" == 'wrong-artifact' ]]
     [[ "$PACKAGE" == 'ytdb-slate' && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$PRIOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$VERSION" != "$PRIOR_VERSION" ]]
     DEPRECATION="Defective release; use $PRIOR_VERSION pending a corrected release"
     npm deprecate "$PACKAGE@$VERSION" "$DEPRECATION"
     [[ "$(npm view "$PACKAGE@$VERSION" deprecated)" == "$DEPRECATION" ]]
     npm dist-tag add "$PACKAGE@$PRIOR_VERSION" latest
     [[ "$(npm view "$PACKAGE" dist-tags.latest)" == "$PRIOR_VERSION" ]]
     ```

     After those checks pass, prepare the next unused patch version through this full procedure. A published version cannot be replaced or reused.
   - `inconclusive`: do not run `npm publish` again. Keep the prior pin, create no tag or release, preserve `PUBLISH_LOG` and `REGISTRY_ERROR`, and wait or escalate to npm support. A CLI error or E404 alone is never authoritative absence after an ambiguous publish. Authoritative absence means npm support or a registry operator has confirmed that the publish transaction was not accepted. Only after that confirmation may the agent retry step 5 for the same version; otherwise, if the version later becomes visible, verify it through this step.

7. **The agent tags and creates the release at the verified squash commit.** The first check prevents an inconclusive or bad registry result from advancing. This block is restart-safe: it determines the local tag, remote tag and GitHub release states before it creates anything. It accepts only a lightweight tag at the intended commit.

   ```bash
   set -euo pipefail
   : "${PACKAGE:?Run the initialization block}" "${VERSION:?}" "${TAG:?}" "${SQUASH_SHA:?Run step 3}" "${REGISTRY_RESULT:?Run step 6}"
   [[ "$REGISTRY_RESULT" == 'verified' ]]
   [[ "$PACKAGE" == 'ytdb-slate' && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$TAG" == "v$VERSION" && "$SQUASH_SHA" =~ ^[0-9a-f]{40}$ ]]

   halt_wrong_tag() {
     local location=$1 actual=$2
     printf 'SERIOUS: %s tag %s points at %s, expected %s.\n' "$location" "$TAG" "$actual" "$SQUASH_SHA" >&2
     printf 'Stop. Inspect the tag provenance and resolve the conflicting ref manually; never move, delete, or force-push it from this runbook.\n' >&2
     exit 1
   }

   LOCAL_TAG_EXISTS=false
   if git show-ref --verify --quiet "refs/tags/$TAG"; then
     LOCAL_TAG_EXISTS=true
     LOCAL_TAG_TYPE=$(git cat-file -t "$TAG")
     [[ "$LOCAL_TAG_TYPE" == 'commit' ]] || halt_wrong_tag 'local (non-lightweight)' "$LOCAL_TAG_TYPE"
     LOCAL_TAG_SHA=$(git rev-parse "$TAG^{commit}")
     [[ "$LOCAL_TAG_SHA" == "$SQUASH_SHA" ]] || halt_wrong_tag 'local' "$LOCAL_TAG_SHA"
   fi

   REMOTE_TAG_FILE=$(mktemp)
   git ls-remote --refs origin "refs/tags/$TAG" >"$REMOTE_TAG_FILE"
   mapfile -t REMOTE_TAG_LINES <"$REMOTE_TAG_FILE"
   (( ${#REMOTE_TAG_LINES[@]} <= 1 ))
   REMOTE_TAG_EXISTS=false
   if (( ${#REMOTE_TAG_LINES[@]} == 1 )); then
     REMOTE_TAG_EXISTS=true
     read -r REMOTE_TAG_SHA REMOTE_TAG_REF <<<"${REMOTE_TAG_LINES[0]}"
     [[ "$REMOTE_TAG_REF" == "refs/tags/$TAG" && "$REMOTE_TAG_SHA" =~ ^[0-9a-f]{40}$ ]]
     [[ "$REMOTE_TAG_SHA" == "$SQUASH_SHA" ]] || halt_wrong_tag 'remote' "$REMOTE_TAG_SHA"
   fi

   REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
   [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
   RELEASE_PROBE=$(mktemp)
   RELEASE_ERROR=$(mktemp)
   RELEASE_EXISTS=false
   if gh api --include "repos/$REPO/releases/tags/$TAG" >"$RELEASE_PROBE" 2>"$RELEASE_ERROR"; then
     RELEASE_EXISTS=true
     RELEASE_JSON=$(gh release view "$TAG" --json tagName,targetCommitish)
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
     git tag "$TAG" "$SQUASH_SHA"
     [[ "$(git cat-file -t "$TAG")" == 'commit' ]]
     [[ "$(git rev-parse "$TAG^{commit}")" == "$SQUASH_SHA" ]]
   fi
   if [[ "$REMOTE_TAG_EXISTS" != true ]]; then
     git push origin "refs/tags/$TAG"
   fi
   if [[ "$RELEASE_EXISTS" != true ]]; then
     gh release create "$TAG" --verify-tag --title "$PACKAGE $VERSION" --notes-file /tmp/release-note.md
   fi

   [[ "$(git cat-file -t "$TAG")" == 'commit' ]]
   [[ "$(git rev-parse "$TAG^{commit}")" == "$SQUASH_SHA" ]]
   [[ "$(git ls-remote --refs origin "refs/tags/$TAG" | awk '{print $1}')" == "$SQUASH_SHA" ]]
   [[ "$(gh release view "$TAG" --json targetCommitish --jq '.targetCommitish')" == "$SQUASH_SHA" ]]
   [[ "$(npm view "$PACKAGE@$VERSION" version)" == "$VERSION" ]]
   ```

   The normal restart states are: nothing exists (create, push, release); only the correct local tag exists (skip creation, then push and release); the correct remote tag exists with no release (ensure the local tag, skip the push, then create the release); or the correct remote tag and release both exist (ensure the local tag and skip both remote actions). Use the real prepared release-note path in place of `/tmp/release-note.md`. If any existing tag or release target is wrong, stop, inspect who created it and why, and resolve it manually under repository policy; this runbook never moves or deletes a conflicting tag. The tag must point to the umbrella squash SHA, not to the later pin-only commit.

8. **The agent bumps and validates the dogfooding pin LAST.** Only after npm serves the verified artifact and step 7 passes, return to the default branch and fast-forward it. Back up the serviceable settings, install the exact new pin, and make every failed check restore the prior file:

   ```bash
   set -euo pipefail
   : "${PACKAGE:?Run the initialization block}" "${VERSION:?}" "${PRIOR_VERSION:?}" "${TAG:?}" "${SQUASH_SHA:?}" "${REGISTRY_RESULT:?Run step 6}"
   [[ "$REGISTRY_RESULT" == 'verified' && "$PACKAGE" == 'ytdb-slate' ]]
   [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$PRIOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$VERSION" != "$PRIOR_VERSION" ]]
   [[ "$TAG" == "v$VERSION" && "$SQUASH_SHA" =~ ^[0-9a-f]{40}$ ]]
   git switch main
   git pull --ff-only origin main
   PIN_BACKUP=$(mktemp)
   cp .pi/settings.json "$PIN_BACKUP"
   trap 'cp "$PIN_BACKUP" .pi/settings.json' ERR
   node - "$VERSION" "$PRIOR_VERSION" <<'NODE'
   const fs = require("node:fs");
   const [version, priorVersion] = process.argv.slice(2);
   const path = ".pi/settings.json";
   const settings = JSON.parse(fs.readFileSync(path, "utf8"));
   const values = settings.packages ?? [];
   const matches = [];
   for (let index = 0; index < values.length; index++) {
     const source = typeof values[index] === "string" ? values[index] : values[index].source;
     if (typeof source === "string" && source.startsWith("npm:ytdb-slate@")) matches.push([index, source]);
   }
   const prior = `npm:ytdb-slate@${priorVersion}`;
   if (matches.length !== 1 || matches[0][1] !== prior) throw new Error(`prior dogfood pin is ${JSON.stringify(matches)}`);
   const [index] = matches[0];
   if (typeof values[index] === "string") values[index] = `npm:ytdb-slate@${version}`;
   else values[index].source = `npm:ytdb-slate@${version}`;
   fs.writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
   NODE
   node - "$VERSION" <<'NODE'
   const fs = require("node:fs");
   const version = process.argv[2];
   const settings = JSON.parse(fs.readFileSync(".pi/settings.json", "utf8"));
   const sources = (settings.packages ?? []).map(value => typeof value === "string" ? value : value.source);
   const slate = sources.filter(value => typeof value === "string" && value.startsWith("npm:ytdb-slate@"));
   const expected = `npm:ytdb-slate@${version}`;
   if (slate.length !== 1 || slate[0] !== expected) throw new Error(`new dogfood pin is ${JSON.stringify(slate)}`);
   NODE
   ```

   Now validate what Pi actually resolves and loads. `-a` forces project trust for this non-interactive run. Plain redirection waits for Pi to exit before either log is inspected, so there is no process-substitution race. The settings assertion above, Pi's project-package listing, the installed manifest check, and the forced-trust startup together prove that the exact pinned package—not local source or a stale pin—was selected and loaded:

   ```bash
   set -euo pipefail
   : "${PACKAGE:?}" "${VERSION:?}" "${PIN_BACKUP:?Run the pin-update block}"
   LOAD_STDOUT=$(mktemp)
   LOAD_STDERR=$(mktemp)
   if ! pi -a -p "exit" >"$LOAD_STDOUT" 2>"$LOAD_STDERR"; then
     cat "$LOAD_STDERR" >&2
     false
   fi
   if grep -Fq 'Failed to load extension' "$LOAD_STDERR"; then
     cat "$LOAD_STDERR" >&2
     false
   fi
   PACKAGE_LIST=$(mktemp)
   NO_COLOR=1 pi list -a >"$PACKAGE_LIST"
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

   Do not use `pi --no-extensions -e .`: it loads local source and cannot validate the pin. Any nonzero Pi exit, `Failed to load extension` line, package-list mismatch, or installed-manifest mismatch is a failure; the `ERR` trap restores the prior settings, and the agent must not commit or push the new pin. After a successful check, stage only `.pi/settings.json`, then make and push its own post-publication commit:

   ```bash
   set -euo pipefail
   : "${VERSION:?}" "${PIN_BACKUP:?}"
   [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
   git add .pi/settings.json
   [[ "$(git diff --cached --name-only)" == '.pi/settings.json' ]]
   git commit -m "Dogfood $VERSION"
   git push origin main
   ```

   Finally, recheck every published target and the default branch pin with concrete commands:

   ```bash
   set -euo pipefail
   : "${PACKAGE:?}" "${VERSION:?}" "${TAG:?}" "${SQUASH_SHA:?}"
   [[ "$PACKAGE" == 'ytdb-slate' && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$TAG" == "v$VERSION" && "$SQUASH_SHA" =~ ^[0-9a-f]{40}$ ]]
   git fetch origin main --tags
   [[ "$(git rev-parse "$TAG^{commit}")" == "$SQUASH_SHA" ]]
   [[ "$(git ls-remote origin "refs/tags/$TAG" | awk '{print $1}')" == "$SQUASH_SHA" ]]
   [[ "$(gh release view "$TAG" --json targetCommitish --jq '.targetCommitish')" == "$SQUASH_SHA" ]]
   [[ "$(npm view "$PACKAGE@$VERSION" version)" == "$VERSION" ]]
   FINAL_SETTINGS=$(mktemp)
   git show origin/main:.pi/settings.json >"$FINAL_SETTINGS"
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

Consumers install pinned with `pi install -l npm:ytdb-slate@<version>`. Pi skips pinned specs during `pi update`, so consumers bump their pin deliberately. On every bump, they must re-review their project delta documents (`doctrineExtraPath`, `reviewPerspectivesPath`, and prompt-document lists) against the shipped doctrine for drift.
