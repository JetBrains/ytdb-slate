# Releasing ytdb-slate

Follow these steps in order. For the commands below, set `VERSION`, `PRIOR_VERSION`, and `PR` to literal values for the release; do not include angle brackets or reuse the example values.

```bash
export PACKAGE='ytdb-slate'
export VERSION='X.Y.Z'
export PRIOR_VERSION='A.B.C'
export PR='123'
export TAG="v$VERSION"
```

1. **The agent prepares the umbrella PR.** Bump only `version` in `package.json`; leave `.pi/settings.json` pinned to `npm:ytdb-slate@$PRIOR_VERSION`. Run every required verification, confirm that `node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8'))"` succeeds, and follow `docs/pr-publishing.md` through the ready flip. Do not publish from the PR branch.

2. **The user merges.** The user squash-merges the umbrella PR. The agent must not merge it.

3. **The agent identifies and verifies the merged commit.** Obtain the PR's exact squash SHA from GitHub, not from recent history, then fetch and test it:

   ```bash
   git fetch origin main
   SQUASH_SHA=$(gh pr view "$PR" --json mergeCommit --jq '.mergeCommit.oid')
   test -n "$SQUASH_SHA"
   test "$(git rev-parse "$SQUASH_SHA^{commit}")" = "$SQUASH_SHA"
   git merge-base --is-ancestor "$SQUASH_SHA" origin/main
   ```

   Stop if GitHub does not report an exact merge commit or any test fails. An ancestry check alone is not proof that the intended PR produced the SHA.

4. **The agent verifies and packs the exact commit before publication.** Verify the release version and prior serviceable pin from the commit itself, detach at that commit, and require a clean tree:

   ```bash
   test "$(git show "$SQUASH_SHA:package.json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).version))")" = "$VERSION"
   git show "$SQUASH_SHA:.pi/settings.json" | grep -Fq "npm:$PACKAGE@$PRIOR_VERSION"
   git switch --detach "$SQUASH_SHA"
   test "$(git rev-parse HEAD)" = "$SQUASH_SHA"
   test -z "$(git status --porcelain)"
   ```

   Create the actual tarball that will be published; do not rely on the clean source tree or a dry run:

   ```bash
   PACK_DIR=$(mktemp -d)
   PACK_JSON=$(npm pack --json --pack-destination "$PACK_DIR")
   TARBALL="$PACK_DIR/$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(x[0].filename)" "$PACK_JSON")"
   test -f "$TARBALL"
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
   test -f "$PACK_DIR/unpacked/package/extension/index.ts"
   test -f "$PACK_DIR/unpacked/package/docs/track-workflow.md"
   test -f "$PACK_DIR/unpacked/package/docs/review-rules.md"
   test -f "$PACK_DIR/unpacked/package/docs/design-principles.md"
   test -f "$PACK_DIR/unpacked/package/docs/pr-publishing.md"
   test -f "$PACK_DIR/unpacked/package/docs/model-routing.md"
   test -f "$PACK_DIR/unpacked/package/README.md"
   test -f "$PACK_DIR/unpacked/package/LICENSE"
   ```

   Inspect the `tar` listing for unexpected files as well as running the explicit checks. Stop before publication if the tarball is wrong.

5. **The agent publishes the inspected tarball.** Only after steps 3 and 4 pass, run:

   ```bash
   npm publish "$TARBALL"
   ```

   Keep the command output. Whether it exits successfully or fails, continue to the registry checks in step 6 before any retry, tag, release, or pin change.

6. **The agent resolves the publication result and verifies the registry artifact.** Query the exact version, then download what the registry serves and compare it byte-for-byte with the inspected tarball:

   ```bash
   npm view "$PACKAGE@$VERSION" version dist.integrity dist.tarball --json
   REGISTRY_DIR=$(mktemp -d)
   REGISTRY_JSON=$(npm pack "$PACKAGE@$VERSION" --json --pack-destination "$REGISTRY_DIR")
   REGISTRY_TARBALL="$REGISTRY_DIR/$(node -e "const x=JSON.parse(process.argv[1]);process.stdout.write(x[0].filename)" "$REGISTRY_JSON")"
   cmp "$TARBALL" "$REGISTRY_TARBALL"
   ```

   Use these recovery branches:

   - If the exact version is visible and `cmp` succeeds, publication succeeded. Continue.
   - If the exact version is visible but the downloaded artifact is wrong, publication succeeded with a bad immutable version. Do not tag it, release it, or pin it. Deprecate it with `npm deprecate "$PACKAGE@$VERSION" "Defective release; use $PRIOR_VERSION pending a corrected release"`, restore the safe default with `npm dist-tag add "$PACKAGE@$PRIOR_VERSION" latest`, and prepare the next unused patch version through this full procedure. A published version cannot be replaced or reused.
   - If the publish command's result is ambiguous and registry reads fail, time out, or do not yet give an authoritative answer, do not run `npm publish` again. Keep the prior pin, create no tag or release, record the command output and registry errors, and wait or escalate to npm support until `npm view "$PACKAGE@$VERSION"` gives a conclusive result. If it then exists, treat it as published and verify it as above. Retry only after the registry authoritatively reports that the exact version does not exist. This registry check distinguishes an accepted publish from one that never registered.

7. **The agent tags and creates the release at the verified squash commit.** After the registry artifact passes, create a lightweight tag—never an annotated tag—and verify its target before and after pushing. Create the GitHub release in the project's title convention and include the prepared release note:

   ```bash
   git tag "$TAG" "$SQUASH_SHA"
   test "$(git rev-parse "$TAG^{commit}")" = "$SQUASH_SHA"
   git push origin "refs/tags/$TAG"
   gh release create "$TAG" --verify-tag --title "$PACKAGE $VERSION" --notes-file /tmp/release-note.md
   test "$(git rev-list -n 1 "$TAG")" = "$SQUASH_SHA"
   test "$(gh release view "$TAG" --json targetCommitish --jq '.targetCommitish')" = "$SQUASH_SHA"
   npm view "$PACKAGE@$VERSION" version
   ```

   Use the real prepared release-note path in place of `/tmp/release-note.md`. The tag must point to the umbrella squash SHA, not to the later pin-only commit.

8. **The agent bumps and validates the dogfooding pin LAST.** Only after npm serves the verified artifact and step 7 passes, return to the default branch, fast-forward it, and change only `.pi/settings.json` to `npm:ytdb-slate@$VERSION`. Before committing, start a normal session so project settings load the pinned npm package:

   ```bash
   git switch main
   git pull --ff-only origin main
   # Edit only .pi/settings.json here.
   LOAD_LOG=$(mktemp)
   pi -p "exit" 2> >(tee "$LOAD_LOG" >&2)
   ! grep -Fq 'Failed to load extension' "$LOAD_LOG"
   ```

   Do not use `pi --no-extensions -e .` for this check: that command loads local source and cannot validate the pin. A normal-session success is the absence of `Failed to load extension` on stderr; exit code 0 alone proves nothing. That line is a failure: restore the prior pin, do not commit or push the new one, and investigate the installed artifact. After a successful check, verify that the staged change contains only `.pi/settings.json`, then make and push its own post-publication commit:

   ```bash
   git add .pi/settings.json
   test "$(git diff --cached --name-only)" = '.pi/settings.json'
   git commit -m "Dogfood $VERSION"
   git push origin main
   ```

   Recheck the tag and GitHub release targets, npm's served version, and the default branch's dogfooding pin.

Consumers install pinned with `pi install -l npm:ytdb-slate@<version>`. Pi skips pinned specs during `pi update`, so consumers bump their pin deliberately. On every bump, they must re-review their project delta documents (`doctrineExtraPath`, `reviewPerspectivesPath`, and prompt-document lists) against the shipped doctrine for drift.
