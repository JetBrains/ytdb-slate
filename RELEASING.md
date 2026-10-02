# Releasing ytdb-slate

The **Release** workflow prepares, checks, publishes, proves, promotes, tags, and records one release. A user creates and merges the prepared pull request. Automation never creates, approves, or merges that pull request.

## One-time setup

OpenID Connect (OIDC) lets GitHub Actions request short-lived npm authority without a stored npm token. Configure exactly two npm trusted publishers for package `ytdb-slate`. Set both to organization `JetBrains`, repository `ytdb-slate`, and workflow filename `release.yml`, not the full path. Set their environment fields as follows:

| Configuration | GitHub environment | Direct `npm publish` | Allow npm dist-tag |
| --- | --- | --- | --- |
| A: upload | `npm-release` | On | Off |
| B: promotion and recovery | `npm-promote` | Off | On |

To replace a configuration with different identity fields, delete it and recreate it. Set each allowed action explicitly. Before every release, inspect the complete list with `npm trust list ytdb-slate` or the npm web interface. Confirm that it contains exactly A and B with the values above. An extra configuration or an empty environment field can grant unintended authority.

In GitHub, open **Settings → Environments**. Create `npm-promote` and check `npm-release`. For each environment, select deployment branches and tags. Add a custom rule that permits branch `main` only. Do not permit tags.

npm permits staged publishing in every trusted publisher configuration, including B. This workflow never stages a version. Maintainers must never approve a staged version of `ytdb-slate`. B cannot publish a version directly. A cannot move the tag of an existing version. A still chooses the tag of the version it uploads.

Delete the `NPM_STAGE_ONLY_TOKEN` environment secret after the OIDC workflow is merged. Revoke the corresponding npm token. No workflow job reads an npm token secret. Never put credentials in workflow input, release notes, logs, artifacts, repository files, or chat.

Keep the current package policy for the first release that verifies OIDC promotion through B. After that release, enable **Require two-factor authentication and disallow tokens** in the npm package settings. Check the organization rules too. The effect of this setting on OIDC tag writes is undocumented. The first release after enabling it is the first proof. If npm refuses promotion because of this setting, a maintainer must turn it off and choose `recover` with the exact version and identity. Automation never relaxes policy.

Only upload, promote, and recover-promote have `id-token: write`. The first live release must prove trusted upload through A and OIDC promotion through B. Repository tests cannot prove external authentication or package policy.

## Stored control and workflow compatibility

Before merging this workflow interface, confirm that no release is prepared or in progress and no Release run is active. Do not rerun a preparation or claim run whose stored executor lacks `/-/npm/v1/oidc/token/exchange/`. GitHub permits reruns for 30 days.

Preparation copies its control modules to `release-state`. Inspect the stored executor with `git show origin/release-state:verification/release-job.mjs` after fetching that branch. The stored executor uses OIDC only when it contains `/-/npm/v1/oidc/token/exchange/`. An executor without that path uses the stored-token route. Such a release cannot promote with this workflow. Resolve any unknown effects, then use `close` without promotion. Start a fresh preparation to use OIDC.

Repository collaborators who may merge remain the trusted set. Existing collaborator, npm-writer, and Git version-tag authority outside this workflow is an accepted scope limit.

## Draft the release notes

The release agent drafts the notes before it starts `prepare`. Use the latest version tag reachable from the target branch as the start of the change list. Select the target branch before drafting notes. For a version `X.Y.Z`, use `release/X.Y` when that branch exists. Otherwise use `main`.

```sh
git fetch origin <target> --tags
git tag --merged origin/<target> -l 'v*' --sort=-v:refname | head -n 1
git log --first-parent --format='%h %s' v<last>..origin/<target>
```

The `git tag` command prints the latest version tag on the target branch. Replace `v<last>` with that tag. Each squash-merge title ends with a pull request number in the form `(#NNN)`. A title can contain more than one number. Use `gh pr view <number>` to check which pull request describes the change. Read the pull request when its title does not explain the effect for users.

If a commit title has no pull request number, read the change with `git show <commit>`. Include that commit when it changes behavior for users.

Find configuration changes in the same range:

```sh
git diff --name-status v<last>..origin/<target> -- .pi/slate.json extension/ docs/ README.md
git diff v<last>..origin/<target> -- docs/configuration.md
```

Read relevant diffs under `extension/` and `docs/`. `docs/configuration.md` lists configuration keys and defaults. Look for added, removed, renamed, or ignored keys and changed defaults. State any action users need to take to keep Slate working.

Check the package manifest for pi software development kit (SDK) changes:

```sh
git diff v<last>..origin/<target> -- package.json
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

The pi software development kit (SDK) <supported versions and the evidence for them>.
```

Follow the writing convention in `AGENTS.md` and `docs/writing-guidance.md`. Release notes may describe removals as change records. Keep tokens out of the notes as required in **One-time setup**. The workflow checks only that the notes are not empty. The structure above is a rule for the release agent, not a workflow format check.

Show the complete notes to the user. Wait for explicit approval before running `prepare`. Enter the approved text unchanged in the `notes` input. The notes hash becomes part of the request identity, so the notes cannot change after preparation.

## Maintain a release line

After the first verified promotion of line `X.Y`, an administrator creates `release/X.Y` at that release tag commit. The administrator updates the exact branch name in the merge-queue ruleset. The administrator locks the previous release branch. Do not create a branch while a request for the same line is open. Only the administrator creates or deletes release branches.

Merge a fix into `main` first. Then open a backport pull request into `release/X.Y`. Leave release request records out of backports. The release branch uses the same trusted group as `main`: every collaborator with write access. Its ruleset requires a pull request, CI checks and a merge queue for the current line. It requires no approval and permits no force push or bypass. No ruleset restricts branch creation or deletion. A collaborator can recreate a release branch at unreviewed content. The project accepts this risk and relies on developer responsibility.

A push to a release branch runs CI after that branch carries the CI push trigger. A branch-creation push runs tests without patch coverage and reports the skip. Before the first release from `release/0.12`, merge `main` into that branch in one follow-up pull request. This gives the branch the CI trigger and the check roster's report mode. Do not merge that pull request while `main` holds work for the next release line.

Do not merge a change to the interface between the Release workflow definition and stored control code on `main` while a release holds the lane.

## Start a release

1. Open the **Release** workflow on branch `main`.
2. Choose `prepare`.
3. Enter one unused semantic version and the approved Markdown release notes from **Draft the release notes**. The version must be higher than every version in npm's version list and publication-time map.
4. Run the workflow once. Leave the authorization identity input empty for preparation.

Each preparation dispatch creates a new authorization generation. A rerun of that same workflow run keeps the generation. Preparation checks the full release-state history at the commit named by its write lease. It refuses any identity that has ended, including one from an earlier run. A history read failure also stops preparation. A later dispatch creates a new request identity even when the version, notes, and base are unchanged. One authorization generation can have only one identity. A release branch may move between attempts. A repeated attempt refuses when its recorded base no longer matches the branch head. A repeated attempt with no recorded release-branch base also refuses.

Preparation reads the single release lane on `release-state`. It checks npm version order after that read. It writes the request with a compare-and-swap lease. The request binds its target branch. It then creates a request branch at the recorded target head. The workflow prints the target and a compare link. Use that link to create the pull request. Check the target before merge. If the target is wrong, abandon the unmerged request and prepare again after correcting the branch setup. A repeated preparation attempt uses its recorded base. If it refuses because the target moved, abandon the prepared request and start a new dispatch. If no request was stored, start a new dispatch.

Review the exact metadata-only diff. A first request normally changes `package.json`, `package-lock.json`, and three files under `release/requests/<version>/`. A corrected request may change a subset of the three request files when the bound target branch already names the same unused version. It must change `request.json`. The other request files must still match the reviewed request content. A request that changes the version must change both manifests and `request.json`. No executable-code path receives a coverage exception.

Use the repository's enabled squash merge or merge queue. For a `main` target, the workflow examines every commit in the resulting push. It selects the exact release commit, its own parent and diff, and its associated merged pull request. An unrelated commit in the same grouped push does not become the release identity. For a release-branch target, check that its check roster offers report mode before merge. The report mode runs checks without receiving a request record.

A `main` merge authorizes publication. A release-branch merge also needs a `publish` dispatch on `main`. Enter the exact version and request identity from `release-state`. A forgotten dispatch leaves the lane prepared. Dispatch `publish` later or retire the merged request. A release does not depend on branch continuous integration (CI) runs. Do not edit the durable request or notes after preparation. Do not change npm `latest` manually while release automation is active.

## Automatic publication

Jobs that run the release commit's check roster or package content hold no persisted checkout credential and save no dependency cache. On a `main` release, identify, claim, and seal run control code from the main release commit. Claim and seal write `release-state` with a persisted checkout credential.

For release-branch publication, identify, claim, the coverage decision, seal, upload, registry and installation proofs, recorders, promotion, and finalization use control code from `release-state`. Recover and close also use stored control code. Abandon and retire use current control code from the dispatch commit on `main` for operator checks. Some of their state transitions use stored control code.

The workflow performs these actions in order:

1. It claims the exact request identity only while the durable owner matches the identity found at launch. Only another attempt of the owning workflow run may repeat a claim. A claim after retirement or new preparation is refused.
2. It runs every executable release check in `verification/release-checks.sh` against the exact commit and parent. A failure, refusal, unsupported result, missing verdict, or `NOT RUN` stops publication.
3. It accepts a coverage `WARN` only when the changed paths follow the reviewed request path rule. The paths must be a subset of the permitted set and include `request.json`. A version-changing request must also change both manifests. It records the request identity, parent, and head with that disposition.
4. It packs and fingerprints one archive without repository-write or npm authority.
5. It saves the archive and a unique workflow run and run-attempt pair before upload. The saved state becomes unknown before the upload command.
6. The protected upload job publishes that archive once under the internal `slate-candidate` npm distribution tag. It uses OpenID Connect. It runs no install, package test, lifecycle script, or extension code.
7. Read-only jobs compare the registry bytes with the saved archive. They install the exact version with an empty cache and require one packaged `/slate` command with no extension error.
8. The workflow records promotion intent and the observed `latest` value. The protected promotion job uses OIDC through configuration B to move `latest` to the same proved version. Stored control code defines how the job observes the result.
9. Only a verified promotion permits the immutable Git version tag and GitHub release at the exact release commit.

The internal npm tag is an automation pointer, not a consumer guarantee. Before proof, the version can be reached by exact version, by the internal tag, and by matching ranges that do not select the current `latest`. Default `latest` selection is the protection boundary.

npm distribution-tag writes are unconditional. The workflow serializes and fences its own writers. It performs no write when the guard read sees another selection. It never rolls back another observed selection. It cannot close the race with an independent npm writer between its reads and write. The operating rule against manual `latest` changes reduces this accepted risk but does not provide global compare-and-swap protection.

## Announce the release

The release agent writes an announcement only after a successful release. Confirm that promotion of npm `latest` is verified and that the Git version tag exists. Confirm the GitHub release with `gh release view v<version> --json url`.

Write a short message for social networks. Name the notable changes from `Highlights` and `Breaking changes`, when present. Link to the release notes at `https://github.com/JetBrains/ytdb-slate/releases/tag/v<version>`. Follow the writing convention in `AGENTS.md` and `docs/writing-guidance.md`.

Give the message to the user. Do not post it. Do not write an announcement for a failed, retired, or closed release.

## Failure, retirement, and recovery

Read the failed job and the `release-state` history before acting. Download retained artifacts when needed. They contain check logs, archive evidence, registry observations, the attempt-keyed `install-failure-<attempt>` artifact, install proof, and promotion observations. The `release-state` history stores validated installation failures under `install-failures/`.

### Before upload

A branch-creation retry for the exact same prepared request is idempotent. Copy the exact request identity from the active `release-state` record into the workflow authorization identity input. Choose `abandon` only for an unmerged prepared request with no upload attempt. The workflow reads every page of GitHub pull requests. It accepts only pull requests from this repository and the identity-bound branch into the bound target. It refuses a merged match or an incomplete or malformed read. It closes only open exact matches. It also accepts no match or several unmerged matches. It tolerates a missing branch and records abandonment. Do not close or delete the branch first.

Do not rerun an abandonment run that started before pull request #458 merged. Start a new abandonment dispatch from `main` instead.

After a merged authorization fails before upload, correct the cause in normal development. Re-run the failed workflow jobs when that is enough. If the authorization must be revoked, enter its exact version and request identity, then choose `retire`. A prepared request needs exactly one merged pull request into its bound target from this repository and its identity-bound branch. A failed or malformed GitHub read leaves the state unchanged. An unmerged prepared request can only be abandoned. Retirement also accepts an exact claimed authorization with no upload attempt. Retirement uses the current control code for a prepared request. It keeps empty claim fields, preserves history, and permanently revokes that identity.

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

Promotion observation reads npm's `latest` distribution tag, which selects the default package version. New stored control declares `PROMOTION_OBSERVATION = "bounded-latest-v1"` in both control modules. Recovery selects this route only when both declarations match. When both declarations are absent, recovery selects the legacy route described below. One declaration or an unsupported value fails visibly without changing state.

A guard read checks `latest` before a promotion write. On the bounded route, missing GitHub OIDC request variables save `not-attempted` with the existing cause `missing-token`. A failed or malformed guard read fails the job without an npm write or state change. It does not save `not-attempted` with cause `latest-read-failed`. A guard read that sees the release version verifies promotion without writing. Only the saved earlier value permits a write. Another valid version starts observation without a write.

Only an authorized write branch requests the GitHub ID token, exchanges it at npm, and sends the tag write. Node sends these requests with built-in `fetch`, not an npm write process. The registry origin is fixed to `https://registry.npmjs.org`. The GitHub token URL must use HTTPS. Requests reject redirects and each has a ten-second timeout. The exchange endpoint is documented. The tag PUT endpoint follows npm CLI behavior but has no public API specification. This protocol is an accepted compatibility risk.

The executor masks each returned token immediately. Tokens stay in memory and never enter child-process environments or saved results. Errors contain only closed codes, not response bodies. An authorized write starts the shared bounded observer even when a credential request or the tag write fails. After a failed write, an observation of the release version saves `verified`. Every other outcome saves `refused` with a recognized npm error code or the fixed value `unknown`. A completed observation adds its actual selection as `after`. A failed observation still saves `refused`, without `after`. The guard value never substitutes for a read after the write. The result contains no error message or token text.

Reads carry no npm token or GitHub OIDC request variables. They use two distinct empty temporary npm configuration files. Their isolated working directory has no project `.npmrc` file. Observation allows 60 seconds, including reads, waits, and npm retries. Polls wait at most five seconds. Each read has a timeout within the remaining allowance. No read starts with less than one second left. The observer then classifies its last valid read. A started read that fails, returns malformed data, or times out cannot use an earlier read. Such failures leave state unchanged except after a failed write, which still saves `refused`.

Observation stops when it sees the release version and saves `verified`. At the time limit, the saved earlier value gives `unchanged`. A third version gives `superseded`. `unchanged` describes the observed selection. It does not prove that npm never accepted the write. Every non-verified result emits a fixed GitHub error annotation. The recorder can still save the result. Only `verified` permits final records.

The recorder validates the complete result shape before saving it. It preserves the release identity and saved earlier value. `refused`, `unchanged`, and `not-attempted` return the release to `proved` and clear the promoter. Stop any earlier promoter before choosing `recover` with the exact version and identity. Recovery uses the same bounded observer for unknown outcomes and these resolved results. If it sees the release version, it records `verified` and can finish final records. If it observes `unchanged`, it authorizes a new protected attempt with the same earlier value. That promoter checks the value again before writing. `superseded` permits no retry or rollback.

The legacy route uses the policy stored for that release. Its guard conflict saves `conflict` without a write. Missing-token and failed-first-read handling may save `not-attempted` when stored control supports that result. The failed-first-read cause is `latest-read-failed`. Legacy recovery retries `refused` or supported `not-attempted` only when one read equals the saved earlier value. Another value stops that retry. For an unknown outcome, one read verifies the release version or records `superseded`. The saved earlier value also gives `superseded` on this legacy path. Historical `refused` records without error codes and historical `conflict` records remain valid. A resolved non-verified release may use `close` after confirming no promoter is active.

The protected retry needs configuration B and GitHub OIDC request authority. A normal rerun of the earlier promoter does not own a new intent. No recovery route repeats the package upload.

If promotion is verified, recovery may create only missing Git and GitHub records. It refuses an existing tag or release that points elsewhere. It never moves an existing Git tag.

Use `close` in either of two cases. The first case is a published and proved release that cannot be promoted. The second case is a registry-verified published release with a recorded installation failure. For the second case, confirm that `record-install-failure` succeeded and that `release-state` contains the matching entry under `install-failures/`. If the recorder failed, choose `recover` again. Do not rerun only `record-install-failure`, because its artifact name uses the new run-attempt number. If installation fails again, the failure recorder uses the same new run attempt. If installation succeeds, the failure recorder is skipped. The release can continue only after the required proofs succeed. In both cases, first resolve every unknown upload or promotion outcome and ensure that no publisher or promoter is active. Then enter the exact version and request identity and choose `close`. This terminal action preserves the consumed version, archive, registry evidence, installation attempts, and other evidence. It creates no npm promotion, success Git tag, or GitHub release. It permanently revokes the old authorization and frees the lane for a later version. A late installation result cannot reopen the closed identity. The consumed version cannot be reused.

If GitHub OIDC request variables are missing, check that the promoter recorded `not-attempted` and the recorder saved it in `release-state`. Check `id-token: write` and the environment binding. If npm refuses a request, check that the recorder saved `refused`. Check configuration B and package policy. Correct the cause, then choose `recover` for a new protected attempt when `latest` still equals the saved expected value. Policy changes require a maintainer decision as described in **One-time setup**.

If the promoter produced a `promotion-result` or `recovered-promotion-result` artifact but its recorder failed, rerun only the failed promotion recorder job first. Do so only while the result artifact exists and the original promotion intent still owns `release-state`. Do not choose `recover` before the recorder succeeds. Recovery must not replace a result that is available for recording. The legacy route records `superseded` for an unknown outcome when `latest` remains at the saved earlier value. That legacy result permits only `close`.

Never rerun the promoter. Promotion artifact names do not include the run attempt, so the recorder can download the earlier artifact. The attempt-keyed `install-failure-<attempt>` artifact differs. A rerun of only `record-install-failure` cannot read its earlier artifact and must instead rerun the failed installation job and its recorder together.

The `not-attempted` route applies only when the control code copied to `release-state` at preparation recognizes it. In Bash, run `set -o pipefail` and `git fetch origin release-state`. Run `git show origin/release-state:verification/release-job.mjs | awk '/result:"not-attempted"/ { n++ } END { print n+0 }'` and `git show origin/release-state:verification/release-control.mjs | awk '/"not-attempted"/ { n++ } END { print n+0 }'`. A positive count in both files means the route applies. Zero in either count means it does not apply.

Stop if a command fails. Inspect `executePromotion` to confirm its supported causes. OIDC bounded control saves this result only for missing GitHub OIDC request variables. Legacy control may also save it for a failed first read. Inspect the control module for result support. Do not rerun a workflow run whose checked-out `.github/workflows/release.yml` lacks the `not-attempted` retry condition in `recover` for a release whose stored control code supports it. Check the workflow file at that run's commit, not just the current `main` branch.

## Evidence and limits

The `release-state` branch is the durable lifecycle history. Workflow writes add commits and use compare-and-swap leases. They do not rewind or delete history. Workflow artifacts remain readable for 90 days. Registry bytes, npm distribution tags, the immutable Git version tag, and the GitHub release are external facts.

The fresh-install proof establishes installation, extension loading, and `/slate` command registration. It does not establish interactive doctrine rendering, model routing, or tool registration. Optional npm build provenance remains outside this process.

No development action may run this workflow live or create or test a token. It may not bump a version, publish, promote, create a Git tag, or create a GitHub release. Every real release needs a separate user request and merge authorization.
