# Releasing ytdb-slate

The **Release** workflow prepares, checks, publishes, proves, promotes, tags, and records one release. A user creates and merges the prepared pull request. Automation never creates, approves, or merges that pull request.

## One-time setup

Configure the npm trusted publisher for this repository. Set the workflow filename to `release.yml`, not the full path. Set the GitHub environment to `npm-release`. Enable direct `npm publish` for this trusted publisher.

In GitHub, open **Settings → Environments → npm-release**. Select deployment branches and tags. Add a custom rule that permits branch `main` only. Do not permit tags.

Create an expiring granular npm token for package `ytdb-slate`. Give it **Read and write (stage only)** package access. A stage-only token can move distribution tags and deprecate existing versions. It cannot publish a new version directly. Do not use npm staged publishing in this release process.

Store the token as the `NPM_STAGE_ONLY_TOKEN` secret in the `npm-release` environment. Only the postproof promotion job references this secret. Set a short expiry that covers the release. Rotate the token before expiry and revoke it after use or suspected disclosure. Never put it in workflow input, release notes, logs, artifacts, repository files, or chat.

Check the package and organization publishing-access and two-factor authentication rules. The effect of a **disallow tokens** rule on distribution-tag changes is not documented. Public registry reads cannot prove token write access. If current policy blocks promotion, stop and request a separate operator decision. Do not relax a package or organization policy automatically.

OpenID Connect trusted publishing remains the only package-upload authority. The first live upload and promotion must prove both external authentication paths because repository tests cannot inspect them.

Repository collaborators who may merge remain the trusted set. Existing collaborator, npm-writer, and Git version-tag authority outside this workflow is an accepted scope limit.

## Draft the release notes

The release agent drafts the notes before it starts `prepare`. Use the latest version tag as the start of the change list:

```sh
git fetch origin --tags
git tag -l 'v*' --sort=-v:refname | head -n 1
git log --first-parent --format='%h %s' v<last>..origin/main
```

The `git tag` command prints the latest version tag. Replace `v<last>` with that tag. Each squash-merge title ends with a pull request number in the form `(#NNN)`. A title can contain more than one number. Use `gh pr view <number>` to check which pull request describes the change. Read the pull request when its title does not explain the effect for users.

If a commit title has no pull request number, read the change with `git show <commit>`. Include that commit when it changes behavior for users.

Find configuration changes in the same range:

```sh
git diff --name-status v<last>..origin/main -- .pi/slate.json extension/ docs/ README.md
git diff v<last>..origin/main -- docs/configuration.md
```

Read relevant diffs under `extension/` and `docs/`. `docs/configuration.md` lists configuration keys and defaults. Look for added, removed, renamed, or ignored keys and changed defaults. State any action users need to take to keep Slate working.

Check the package manifest for pi software development kit (SDK) changes:

```sh
git diff v<last>..origin/main -- package.json
```

Read the exact SDK pins in `devDependencies`. The SDK entries in `peerDependencies` use `*`. A changed pin alone does not prove a minimum working pi version. State a minimum version only when tests provide evidence for it.

The GitHub release holds the published notes for each release. Read the previous notes as an example with `gh release view v<last> --json body`.

Write the notes in Markdown with this structure. Include `Fixes` only when the release has fixes. Include `Breaking changes` only when the release has them. Number each breaking change and give its required user action.

```markdown
# ytdb-slate <version>

<Short introduction.>

## Highlights

<Notable changes for users.>

## Fixes

<Fixes, when present.>

## Breaking changes

1. <Change.> Action: <What the user must do.>

## Compatibility

<Effects on existing users and any required configuration actions.>

## SDK compatibility

<Supported SDK information backed by evidence.>
```

Follow the writing convention in `AGENTS.md` and `docs/writing-guidance.md`. Release notes may describe removals as change records. Keep tokens out of the notes as required in **One-time setup**. The workflow checks only that the notes are not empty. The structure above is a rule for the release agent, not a workflow format check.

Show the complete notes to the user. Wait for explicit approval before running `prepare`. Enter the approved text unchanged in the `notes` input. The notes hash becomes part of the request identity, so the notes cannot change after preparation.

## Start a release

1. Open the **Release** workflow on branch `main`.
2. Choose `prepare`.
3. Enter one unused semantic version and the approved Markdown release notes from **Draft the release notes**.
4. Run the workflow once. Leave the authorization identity input empty for preparation.

Each preparation dispatch creates a new authorization generation. A rerun of that same workflow run keeps the generation. Preparation checks the full release-state history at the commit named by its write lease. It refuses any identity that has ended, including one from an earlier run. A history read failure also stops preparation. A later dispatch creates a new request identity even when the version, notes, and base are unchanged.

Preparation first claims the single release lane on the `release-state` branch. It then creates a branch named from the version and request identity. The workflow prints a compare link. Use that link to create the pull request.

Review the exact metadata-only diff. A first request normally changes `package.json`, `package-lock.json`, and three files under `release/requests/<version>/`. A corrected request may change a subset of the three request files when `main` already names the same unused version. It must change `request.json`. The other request files must still match the reviewed request content. A request that changes the version must change both manifests and `request.json`. No executable-code path receives a coverage exception.

Use the repository's enabled squash merge or merge queue. The workflow examines every commit in the resulting `main` push. It selects the exact release commit, its own parent and diff, and its associated merged pull request. An unrelated commit in the same grouped push does not become the release identity.

The merge authorizes publication. Do not edit the durable request or notes after preparation. Do not change npm `latest` manually while release automation is active.

## Automatic publication

The workflow performs these actions in order:

1. It claims the exact request identity only while the durable owner matches the identity found at launch. A repeated claim for the same merge is safe. A claim after retirement or new preparation is refused.
2. It runs every executable release check in `verification/release-checks.sh` against the exact commit and parent. A failure, refusal, unsupported result, missing verdict, or `NOT RUN` stops publication.
3. It accepts a coverage `WARN` only when the changed paths follow the reviewed request path rule. The paths must be a subset of the permitted set and include `request.json`. A version-changing request must also change both manifests. It records the request identity, parent, and head with that disposition.
4. It packs and fingerprints one archive without repository-write or npm authority.
5. It saves the archive and a unique workflow run and run-attempt pair before upload. The saved state becomes unknown before the upload command.
6. The protected upload job publishes that archive once under the internal `slate-candidate` npm distribution tag. It uses OpenID Connect. It runs no install, package test, lifecycle script, or extension code.
7. Read-only jobs compare the registry bytes with the saved archive. They install the exact version with an empty cache and require one packaged `/slate` command with no extension error.
8. The workflow records promotion intent and the observed `latest` value. The protected promotion job uses the stage-only token to move `latest` to the same proved version. It reads `latest` before and after the write.
9. Only a verified promotion permits the immutable Git version tag and GitHub release at the exact release commit.

The internal npm tag is an automation pointer, not a consumer guarantee. Before proof, the version can be reached by exact version, by the internal tag, and by matching ranges that do not select the current `latest`. Default `latest` selection is the protection boundary.

npm distribution-tag writes are unconditional. The workflow serializes and fences its own writers. It refuses a conflict that it observes and never rolls back another observed selection. It cannot close the race with an independent npm writer between its reads and write. The operating rule against manual `latest` changes reduces this accepted risk but does not provide global compare-and-swap protection.

## Announce the release

The release agent writes an announcement only after a successful release. Confirm that promotion of npm `latest` is verified and that the Git version tag exists. Confirm the GitHub release with `gh release view v<version> --json url`.

Write a short message for social networks. Name the notable changes from `Highlights` and `Breaking changes`, when present. Link to the release notes at `https://github.com/JetBrains/ytdb-slate/releases/tag/v<version>`. Follow the writing convention in `AGENTS.md` and `docs/writing-guidance.md`.

Give the message to the user. Do not post it. Do not write an announcement for a failed, retired, or closed release.

## Failure, retirement, and recovery

Read the failed job and the `release-state` history before acting. Download retained artifacts when needed. They contain check logs, archive evidence, registry observations, the attempt-keyed `install-failure-<attempt>` artifact, install proof, and promotion observations. The `release-state` history stores validated installation failures under `install-failures/`.

### Before upload

A branch-creation retry for the exact same prepared request is idempotent. Copy the exact request identity from the active `release-state` record into the workflow authorization identity input. Choose `abandon` only for an unmerged prepared request with no upload attempt. The workflow checks all matching pull requests, closes an open one, tolerates a missing branch, and records abandonment. Do not close or delete the branch first.

After a merged authorization fails before upload, correct the cause in normal development. Re-run the failed workflow jobs when that is enough. If the authorization must be revoked, enter its exact version and request identity, then choose `retire`. A prepared request needs exactly one merged pull request into `main` from this repository and its identity-bound branch. A failed or malformed GitHub read leaves the state unchanged. An unmerged prepared request can only be abandoned. Retirement also accepts an exact claimed authorization with no upload attempt. Retirement uses the current control code for a prepared request. It keeps empty claim fields, preserves history, and permanently revokes that identity.

Do not retire while a preparation or claim run that started before pull request #439 merged is still active. Do not rerun a preparation or claim run that started before pull request #439 merged. GitHub permits reruns for 30 days.

Preparation refuses a version found in either npm's version list or its publication-time map. A package-not-found response or a failed registry read also stops preparation. A corrected request may reuse the same unused npm version without reverting or writing `main` first.

### Unknown upload

The workflow records unknown upload state before `npm publish`. A failed or interrupted upload must never be retried. The upload job checks its saved run and run-attempt pair, so a GitHub job rerun stops before npm.

Enter the exact version and request identity, then choose `recover` to request failed jobs and their dependent jobs from the original run. The sealed upload authority rejects every upload rerun. If registry and installation proofs succeed, the dependent jobs can promote `latest` and create final records. The recovery job itself grants no upload or promotion authority. If the registry shows the version, use `recover` to pursue byte and installation proofs.

If the version is absent, `retire` can revoke the exact identity after a separate evidence gate. The workflow reads the sealed run attempt and its `upload` job through GitHub. The run must be complete. The job must have a completed non-success result for at least 60 minutes.

The workflow reads the full npm package document with a new empty cache and requires earlier versions and publication times. The version must appear in neither the version list nor the publication-time map. A package or version not-found response, a network error, or malformed data never proves absence. Any missing evidence leaves the state unchanged.

Retirement marks the upload `observed-absent` and keeps the archive fingerprint and original upload execution. A later preparation may reuse the version under a new identity. This gate records what it observed. It cannot prove that npm never accepted an upload.

A wrong verdict can leave only an unpromoted version under `slate-candidate` with the sealed archive. `latest` does not move without proof. A later same-version upload fails and records an unknown outcome or a mismatch. If evidence remains inconclusive, keep the state and ask npm support whether it accepted the transaction.

A failed installation proof may be retried from the failed job or through `recover`. Each attempt must match the exact release identity, version, commit, parent, and verified registry record. A new run-attempt number is valid because the installation job has no upload or promotion authority. Recovery from `published` state requests failed jobs and their dependent jobs from the original release run. The dependent jobs can record proof, promote `latest`, and create final records only after all proofs succeed. The recovery job itself receives no npm token and performs no npm write.

A confirmed registry byte mismatch is terminal. It proves only that the registry serves different bytes and that the version is consumed. It does not prove who uploaded those bytes. The original attempt evidence stays separate. The workflow creates no promotion, success Git tag, or GitHub release. Use a later unused version after a separate correction decision.

### Promotion and final records

A promotion conflict before the write is recorded and stops. If the protected job has no stage-only token or cannot read `latest` before the write, it records `not-attempted` with a fixed cause and reports that no npm write happened. The recorder then returns the release to `proved` and clears the promoter. A write refusal records `refused` and also returns the release to `proved`. The initial final-record job refuses both outcomes because neither verifies promotion.

For `not-attempted` or `refused`, correct the cause and choose `recover` with the exact version and identity. Recovery retries only if the current `latest` equals the expected value saved in the promotion intent. A different value stops recovery. Use `close` after confirming that no promoter is active. The protected retry job needs the stage-only token. A normal rerun of the earlier promoter is not a retry because its run attempt no longer owns the promotion intent.

An interrupted promotion with no result has an unknown outcome. Recovery reads the current `latest` value and records either the desired effect or a superseding value. It does not infer that no write happened. It does not perform a blind promotion write.

If promotion is verified, recovery may create only missing Git and GitHub records. It refuses an existing tag or release that points elsewhere. It never moves an existing Git tag.

Use `close` in either of two cases. The first case is a published and proved release that cannot be promoted. The second case is a registry-verified published release with a recorded installation failure. For the second case, confirm that `record-install-failure` succeeded and that `release-state` contains the matching entry under `install-failures/`. If the recorder failed, choose `recover` again. Do not rerun only `record-install-failure`, because its artifact name uses the new run-attempt number. If installation fails again, the failure recorder uses the same new run attempt. If installation succeeds, the failure recorder is skipped. The release can continue only after the required proofs succeed. In both cases, first resolve every unknown upload or promotion outcome and ensure that no publisher or promoter is active. Then enter the exact version and request identity and choose `close`. This terminal action preserves the consumed version, archive, registry evidence, installation attempts, and other evidence. It creates no npm promotion, success Git tag, or GitHub release. It permanently revokes the old authorization and frees the lane for a later version. A late installation result cannot reopen the closed identity. The consumed version cannot be reused.

If the token is missing before the write, check that the promoter recorded `not-attempted` and the recorder saved that outcome in `release-state`. Rotate the protected secret, then choose `recover` for a new protected attempt when `latest` still equals the saved expected value. If npm refuses the write, check that the recorder saved `refused`, rotate the secret, and use the same guarded recovery route. Revoke the old token. If package or organization policy must change, stop and request separate approval.

If the promoter produced a `promotion-result` or `recovered-promotion-result` artifact but its recorder failed, rerun only the failed promotion recorder job first. Do so only while the result artifact exists and the original promotion intent still owns `release-state`. Do not choose `recover` before the recorder succeeds. With `promotion-unknown` still in state, `recover` reads `latest` and records `superseded` when it remains at the expected value. The release can then only be closed.

Never rerun the promoter. Promotion artifact names do not include the run attempt, so the recorder can download the earlier artifact. The attempt-keyed `install-failure-<attempt>` artifact differs. A rerun of only `record-install-failure` cannot read its earlier artifact and must instead rerun the failed installation job and its recorder together.

The `not-attempted` route applies only when the control code copied to `release-state` at preparation recognizes it. In Bash, run `set -o pipefail` and `git fetch origin release-state`. Run `git show origin/release-state:verification/release-job.mjs | awk '/result:"not-attempted"/ { n++ } END { print n+0 }'` and `git show origin/release-state:verification/release-control.mjs | awk '/"not-attempted"/ { n++ } END { print n+0 }'`. A positive count in both files means the route applies. Zero in either count means it does not apply.

Stop if a command fails. Inspect `executePromotion` to confirm that the missing-token and failed first `latest`-read branches return that result. Inspect the control module for result support. Do not rerun a workflow run whose checked-out `.github/workflows/release.yml` lacks the `not-attempted` retry condition in `recover` for a release whose stored control code supports it. Check the workflow file at that run's commit, not just the current `main` branch.

## Evidence and limits

The `release-state` branch is the durable lifecycle history. Workflow writes add commits and use compare-and-swap leases. They do not rewind or delete history. Workflow artifacts remain readable for 90 days. Registry bytes, npm distribution tags, the immutable Git version tag, and the GitHub release are external facts.

The fresh-install proof establishes installation, extension loading, and `/slate` command registration. It does not establish interactive doctrine rendering, model routing, or tool registration. Optional npm build provenance remains outside this process.

No development action may run this workflow live or create or test a token. It may not bump a version, publish, promote, create a Git tag, or create a GitHub release. Every real release needs a separate user request and merge authorization.
