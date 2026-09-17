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

## Start a release

1. Open the **Release** workflow on branch `main`.
2. Choose `prepare`.
3. Enter one unused semantic version and the Markdown release notes.
4. Run the workflow once. Leave the authorization identity input empty for preparation.

Each preparation dispatch creates a new authorization generation. A rerun of that same workflow run keeps the generation. A later preparation creates a new request identity even when the version, notes, and base are unchanged.

Preparation first claims the single release lane on the `release-state` branch. It then creates a branch named from the version and request identity. The workflow prints a compare link. Use that link to create the pull request.

Review the exact metadata-only diff. A first request normally changes `package.json`, `package-lock.json`, and three files under `release/requests/<version>/`. A corrected request may change only the three request files when `main` already names the same unused version. No executable-code path receives a coverage exception.

Use the repository's enabled squash merge or merge queue. The workflow examines every commit in the resulting `main` push. It selects the exact release commit, its own parent and diff, and its associated merged pull request. An unrelated commit in the same grouped push does not become the release identity.

The merge authorizes publication. Do not edit the durable request or notes after preparation. Do not change npm `latest` manually while release automation is active.

## Automatic publication

The workflow performs these actions in order:

1. It claims the exact request identity. A repeated claim for the same merge is safe.
2. It runs every executable release check in `verification/release-checks.sh` against the exact commit and parent. A failure, refusal, unsupported result, missing verdict, or `NOT RUN` stops publication.
3. It accepts a coverage `WARN` only when the changed paths equal the request's reviewed path set. It records the request identity, parent, and head with that disposition.
4. It packs and fingerprints one archive without repository-write or npm authority.
5. It saves the archive and a unique workflow run and run-attempt pair before upload. The saved state becomes unknown before the upload command.
6. The protected upload job publishes that archive once under the internal `slate-candidate` npm distribution tag. It uses OpenID Connect. It runs no install, package test, lifecycle script, or extension code.
7. Read-only jobs compare the registry bytes with the saved archive. They install the exact version with an empty cache and require one packaged `/slate` command with no extension error.
8. The workflow records promotion intent and the observed `latest` value. The protected promotion job uses the stage-only token to move `latest` to the same proved version. It reads `latest` before and after the write.
9. Only a verified promotion permits the immutable Git version tag and GitHub release at the exact release commit.

The internal npm tag is an automation pointer, not a consumer guarantee. Before proof, the version can be reached by exact version, by the internal tag, and by matching ranges that do not select the current `latest`. Default `latest` selection is the protection boundary.

npm distribution-tag writes are unconditional. The workflow serializes and fences its own writers. It refuses a conflict that it observes and never rolls back another observed selection. It cannot close the race with an independent npm writer between its reads and write. The operating rule against manual `latest` changes reduces this accepted risk but does not provide global compare-and-swap protection.

## Failure, retirement, and recovery

Read the failed job and the `release-state` history before acting. Download retained artifacts when needed. They contain check logs, archive evidence, registry observations, the attempt-keyed `install-failure-<attempt>` artifact, install proof, and promotion observations. The `release-state` history stores validated installation failures under `install-failures/`.

### Before upload

A branch-creation retry for the exact same prepared request is idempotent. Copy the exact request identity from the active `release-state` record into the workflow authorization identity input. Choose `abandon` only for an unmerged prepared request with no upload attempt. The workflow checks all matching pull requests, closes an open one, tolerates a missing branch, and records abandonment. Do not close or delete the branch first.

After a merged authorization fails before upload, correct the cause in normal development. Re-run the failed workflow jobs when that is enough. If the authorization must be revoked, enter its exact version and request identity, then choose `retire`. Retirement requires the exact merged identity, no upload attempt, and no active publisher. It preserves history and permanently revokes that identity. A corrected request may reuse the same unused npm version without reverting or writing `main` first.

### Unknown upload

The workflow records unknown upload state before `npm publish`. A failed or interrupted upload must never be retried. The upload job checks its saved run and run-attempt pair, so a GitHub job rerun stops before npm.

Enter the exact version and request identity, then choose `recover` to request failed jobs and their dependent jobs from the original run. The sealed upload authority rejects every upload rerun. If registry and installation proofs succeed, the dependent jobs can promote `latest` and create final records. The recovery job itself grants no upload or promotion authority. If registry evidence remains inconclusive, keep the state and ask npm support whether it accepted the transaction.

A failed installation proof may be retried from the failed job or through `recover`. Each attempt must match the exact release identity, version, commit, parent, and verified registry record. A new run-attempt number is valid because the installation job has no upload or promotion authority. Recovery from `published` state requests failed jobs and their dependent jobs from the original release run. The dependent jobs can record proof, promote `latest`, and create final records only after all proofs succeed. The recovery job itself receives no npm token and performs no npm write.

A confirmed registry byte mismatch is terminal. It proves only that the registry serves different bytes and that the version is consumed. It does not prove who uploaded those bytes. The original attempt evidence stays separate. The workflow creates no promotion, success Git tag, or GitHub release. Use a later unused version after a separate correction decision.

### Promotion and final records

A promotion conflict before the write is recorded and stops. An interrupted promotion has an unknown outcome. Recovery reads the current `latest` value and records either the desired effect or a superseding value. It does not infer that no write happened. It does not perform a blind promotion write.

If promotion is verified, recovery may create only missing Git and GitHub records. It refuses an existing tag or release that points elsewhere. It never moves an existing Git tag.

Use `close` in either of two cases. The first case is a published and proved release that cannot be promoted. The second case is a registry-verified published release with a recorded installation failure. For the second case, confirm that `record-install-failure` succeeded and that `release-state` contains the matching entry under `install-failures/`. If the recorder failed, choose `recover` again. Do not rerun only `record-install-failure`, because its artifact name uses the new run-attempt number. If installation fails again, the failure recorder uses the same new run attempt. If installation succeeds, the failure recorder is skipped. The release can continue only after the required proofs succeed. In both cases, first resolve every unknown upload or promotion outcome and ensure that no publisher or promoter is active. Then enter the exact version and request identity and choose `close`. This terminal action preserves the consumed version, archive, registry evidence, installation attempts, and other evidence. It creates no npm promotion, success Git tag, or GitHub release. It permanently revokes the old authorization and frees the lane for a later version. A late installation result cannot reopen the closed identity. The consumed version cannot be reused.

If a token expires or is refused before a safe promotion attempt, rotate the protected secret and follow the recorded recovery state. Revoke the old token. If package or organization policy must change, stop and request separate approval.

## Evidence and limits

The `release-state` branch is the durable lifecycle history. Workflow writes add commits and use compare-and-swap leases. They do not rewind or delete history. Workflow artifacts remain readable for 90 days. Registry bytes, npm distribution tags, the immutable Git version tag, and the GitHub release are external facts.

The fresh-install proof establishes installation, extension loading, and `/slate` command registration. It does not establish interactive doctrine rendering, model routing, or tool registration. Optional npm build provenance remains outside this process.

No development action may run this workflow live or create or test a token. It may not bump a version, publish, promote, create a Git tag, or create a GitHub release. Every real release needs a separate user request and merge authorization.
