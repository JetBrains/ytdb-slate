// Independent accepted mutation identities and fail-closed execution accounting.
const numbered = (id, count) => Array.from({ length: count }, (_, index) => `${id}/${index}`);
const combinations = (ids, kinds) => ids.flatMap((id) => kinds.map((kind) => `${id}/${kind}`));
const headingCounts = {"identifiers-ranges": 32, "manual-records": 137, "resume-forks": 21, "handoff-pointer": 3, "resume-order": 19, "general-handoff": 3, "closed-range-feedback": 18, "repairs": 58, "aggregate": 21, "sources": 74, "workflow-accounting": 73, "notes-accounting": 23, "publishing-sync": 7, "public-roadmap": 21, "repair-escalation": 49, "repair-rounds-owner": 52, "repair-consultations-owner": 26, "child-fix-title-owner": 12, "P13-authoring": 28};
export const EXPECTED_MUTATIONS = {
 "review-history": ["design-body", "architecture-body", "review-collapse", "review-combine", "routine-rewrite", "ordinary-rebase", "approved-design-body", "prior-review-combine", "review-before-user", "permitted-rebase", "forbidden-separate-fixes", "body-before-commit", "present-single-commit", "consolidate-corrections", "rebase-until-review", "forbidden-individual-fixes", "fold-corrections"],
 "surviving-safeguards": [
  "reviewed-state", "aggregate-no-authority", "preserve-before-rewrite", "reconcile-references",
  "original-marker-evidence", "missing-history-pause", "exact-recovery", "no-substitute",
  "no-invented-marker", "recovery-choice", "waiver-limit", "linear-history",
  "contiguous-owner", "pause-no-commits", "no-interleaving", "pause-preserves-evidence",
  "branch-lifetime", "exact-reviewed-head", "reviewed-binding-immutable", "rewrite-condition-pause",
  "conflict-keeps-reference", "privacy-history", "privacy-untracked", "privacy-pause",
  "privacy-choice", "privacy-preservation", "waiver-no-permission", "explicit-branch",
  "private-accounting", "local-own-head", "local-all-markers", "local-not-earlier",
  "accept-before-merge", "accept-owning-log", "accept-order", "ready-no-bypass",
  "local-keep-branches", "local-verification-resume", "local-history-privacy", "local-match-pause",
  "local-user-choice", "local-renew-acceptance", "local-marker-order", "local-no-rewrite",
  "local-records", "local-user-deletes", "handoff-exact-head", "handoff-fresh-check",
  "host-merged-head", "host-no-inference", "merge-record-evidence", "remaining-differences",
  "final-agreement"
 ],
 "boundary-regression": [
  "G1-mandatory-section/restored-rule", "G1-mandatory-section/benign-control", "G1-mandatory-section/wrapped-restored-rule", "G3-tracks-table/restored-rule",
  "G3-tracks-table/benign-control", "G3-tracks-table/wrapped-restored-rule", "G4-root-only/restored-rule", "G4-root-only/benign-control",
  "G4-root-only/wrapped-restored-rule", "G4-after-flip/restored-rule", "G4-after-flip/benign-control", "G4-after-flip/wrapped-restored-rule",
  "G8-description-target/restored-rule", "G8-description-target/benign-control", "G8-description-target/wrapped-restored-rule", "G8-delivery-target/restored-rule",
  "G8-delivery-target/benign-control", "G8-delivery-target/wrapped-restored-rule", "G8-measured-exception/restored-rule", "G8-measured-exception/benign-control",
  "G8-measured-exception/wrapped-restored-rule", "G9-untracked-closure/restored-rule", "G9-untracked-closure/benign-control", "G9-untracked-closure/wrapped-restored-rule",
  "normalization-weakening"
 ],
 "delivery-boundaries": [
  "local-delivery/final-squash", "local-delivery/delivery-authority", "first-deferred/suppress-concerns", "first-deferred/redirect-record",
  "scope-outcome/redirect-record", "scope-outcome/omit-record", "note-route/redirect-record", "note-route/omit-record",
  "template-applicability/disabled-exemption", "template-applicability/disabled-template", "template-applicability/publishing-duty", "commit-discipline/design-body-restoration"
 ],
 "delivery-rules": [
  ...numbered("repairs", 58), ...numbered("aggregate", 21), ...numbered("issues", 15), ...numbered("sources", 74),
  ...numbered("workflow-accounting", 73), ...numbered("notes-accounting", 23), ...numbered("publishing-sync", 7), ...numbered("public-workflow", 29),
  ...numbered("public-roadmap", 21)
 ],
 "transfer": [
  ...numbered("transfer", 5)
 ],
 "sequential-acceptance": [
  "subtree-merged-before-root-without-marker-distinction", "root-recreates-earlier-subtree-marker", "root-adds-marker-for-every-accepted-subtree"
 ],
 "level-rules": [
  ...numbered("level-publishing", 20), ...numbered("publishing-creation", 19), ...numbered("publishing-after-merge", 19), ...numbered("sync", 7),
  ...numbered("ready", 31), ...numbered("post-flip", 18), ...numbered("merge-advice", 12), ...numbered("description-scope", 15),
  ...numbered("default-template", 4), ...numbered("migration", 12), ...numbered("accepted-history", 22), ...numbered("history", 25),
  ...numbered("disabled-preservation", 23), ...numbered("private-set", 14), ...numbered("workflow-accounting", 73)
 ],
 "safety-removals": [
  ...numbered("level-publishing", 20), ...numbered("publishing-creation", 19), ...numbered("publishing-after-merge", 19), ...numbered("sync", 7),
  ...numbered("ready", 31), ...numbered("post-flip", 18), ...numbered("merge-advice", 12), ...numbered("description-scope", 15),
  ...numbered("default-template", 4), ...numbered("migration", 12), ...numbered("accepted-history", 22), ...numbered("history", 25),
  ...numbered("disabled-preservation", 23), ...numbered("private-set", 14), ...numbered("workflow-accounting", 73)
 ],
 "ordering": [
  "before-first-range", "after-descendant-ranges", "resume-completed-dependency", "open-range-interleaving"
 ],
 "peer-pins": [
  "level-publishing/exception", "publishing-creation/exception", "publishing-after-merge/exception", "sync/exception",
  "ready/exception", "post-flip/exception", "merge-advice/exception", "description-scope/exception",
  "default-template/exception", "migration/exception", "accepted-history/exception", "history/exception",
  "disabled-preservation/exception", "private-set/exception", "workflow-accounting/exception", "pr-publishing/document-addition",
  "track-workflow/document-addition", "delivery-packages/document-addition"
 ],
 "heading-policy": Object.entries(headingCounts).flatMap(([id, count]) => combinations([id], ["missing", "duplicate", "empty", "empty-duplicate", "closed-heading-duplicate", "peer-truncation", ...[1, 2, 3, 4, 5].map((index) => `higher-truncation-${index}`), ...Array.from({ length: count }, (_, index) => `sentence-${index}`)])),
 "common-guidance": [
  "worker-supplied-folder-removed", "action-scratch-scope-narrowed", "lasting-file-in-action-folder", "temporary-owner-transfer-rule-removed",
  "temporary-content-authority", "folder-privacy-or-publishing-weakened"
 ],
 "common-temporary-rules": [
  "common-verification-folder-precedence-removed", "common-verification-folder-retention-overridden", "common-worker-delete-before-check", "common-worker-delete-without-passed-check"
 ],
 "reviewer-destinations": [
  "reviewer-owned-diff-exception-removed", "reviewer-no-change-fallback-removed", "reviewer-no-change-deletion-removed", "reviewer-design-bytes-denied",
  "reviewer-manual-fallback-removed", "reviewer-extra-write-limit-removed", "reviewer-action-path-private-reference"
 ],
 "reviewer-inputs": [
  "reviewer-contract-design-grant", "reviewer-contract-folder-restriction", "reviewer-contract-outside-range-grant", "reviewer-reads-other-action",
  ...numbered("reviewer-contract-stage-paragraph-changed", 8), "reviewer-contract-sibling-heading-grant", "reviewer-write-scope-weakened"
 ],
 "worker-guidance": [
  "worker-change-preamble-removed", "worker-change-preamble-rules-weakened", "reviewer-preamble-extra-write", "worker-delete-before-check",
  "worker-delete-without-passed-check", "verification-folder-precedence-removed", "verification-folder-retention-overridden", "alternate-payload-destination",
  "reviewer-owned-diff-exception-removed"
 ],
 "report-guidance": [
  "failed-record-check-report-removed"
 ],
 "record-contract": [
  "append-only-operator-removed", "permit-truncating-redirection", "permit-write-tool", "permit-edit-tool",
  "permit-sed-in-place", "design-copy-cp-n-removed", "design-copy-cmp-removed", "design-copy-exit-status-authority",
  "direct-write-block-missing", "direct-write-block-contradictory", "direct-write-block-duplicate", "omit-transcript-limit",
  "record-only-task-record-names-removed", "record-only-task-assigned-method-removed", "record-only-task-source-rule-removed", "start-copy-removed",
  "start-copy-location-inside-records", "start-copy-after-first-write", "new-record-empty-start-copy-removed", "new-text-temporary-file-removed",
  "new-text-temporary-file-shared", "new-text-temporary-file-inside-records", "new-text-temporary-file-after-write", "new-log-first-temporary-append-removed",
  "new-report-first-temporary-append-removed", "append-temporary-file-removed", "append-temporary-file-operator-removed", "status-rewrite-temporary-copy-removed",
  "new-design-temporary-copy-removed", "final-check-before-last-write", "final-check-whole-record-removed", "final-check-once-per-record-removed",
  "append-equality-start-copy-removed", "append-equality-every-temporary-file-removed", "append-equality-temporary-order-removed", "append-equality-cat-removed",
  "append-equality-cmp-removed", "status-final-temporary-equality-removed", "new-design-final-temporary-equality-removed", "status-final-cmp-removed",
  "new-design-final-cmp-removed", "changed-design-diff-removed", "changed-design-verified-copy-removed", "changed-design-intended-differences-removed",
  "check-report-per-record-removed", "check-report-final-response-removed", "check-report-exact-task-path-removed", "check-report-comparison-description-removed",
  "check-report-result-removed", "count-incomplete-check-report", "unreported-written-record-read-removed", "unreported-read-extended-to-read-only-records",
  "unreported-read-depends-on-tool-warning", "unreported-read-after-another-write", "failed-check-retry-route-removed", "failed-final-check-end-only-inspection",
  "required-retry-reads-addition-removed", "required-retry-reads-replacement-permitted", "status-retry-complete-rewrite-removed", "unequal-versioned-copy-refusal-removed",
  "missing-versioned-copy-refusal-removed", "invalid-versioned-copy-existing-file-protection-removed", "versioned-copy-retry-next-unused-name-removed", "versioned-copy-retry-cmp-before-design-change-removed",
  "failed-design-edit-comparison-removed", "unclear-design-edit-comparison-removed", "design-retry-verified-copy-comparison-removed", "design-retry-before-orchestrator-cmp",
  "unchanged-design-edit-only-retry-removed", "partial-design-restore-removed", "partial-design-restore-cp-removed", "partial-design-restore-cmp-removed",
  "partial-design-retry-before-restoration-comparison", "change-start-while-record-writer-permitted", "change-close-while-record-writer-permitted", "log-report-retry-missing-text-not-resent",
  "log-report-retry-present-text-resent", "log-report-retry-partial-text-resent", "log-report-retry-before-inspection", "log-report-partial-correction-without-entry-name"
 ],
 "named-rules": [
  "record-only-task-record-names-removed", "record-only-task-assigned-method-removed", "record-only-task-source-rule-removed", "start-copy-removed",
  "start-copy-location-inside-records", "start-copy-after-first-write", "new-record-empty-start-copy-removed", "new-text-temporary-file-removed",
  "new-text-temporary-file-shared", "new-text-temporary-file-inside-records", "new-text-temporary-file-after-write", "new-log-first-temporary-append-removed",
  "new-report-first-temporary-append-removed", "append-temporary-file-removed", "append-temporary-file-operator-removed", "status-rewrite-temporary-copy-removed",
  "new-design-temporary-copy-removed", "final-check-before-last-write", "final-check-whole-record-removed", "final-check-once-per-record-removed",
  "append-equality-start-copy-removed", "append-equality-every-temporary-file-removed", "append-equality-temporary-order-removed", "append-equality-cat-removed",
  "append-equality-cmp-removed", "status-final-temporary-equality-removed", "new-design-final-temporary-equality-removed", "status-final-cmp-removed",
  "new-design-final-cmp-removed", "changed-design-diff-removed", "changed-design-verified-copy-removed", "changed-design-intended-differences-removed",
  "check-report-per-record-removed", "check-report-final-response-removed", "check-report-exact-task-path-removed", "check-report-comparison-description-removed",
  "check-report-result-removed", "count-incomplete-check-report", "unreported-written-record-read-removed", "unreported-read-extended-to-read-only-records",
  "unreported-read-depends-on-tool-warning", "unreported-read-after-another-write", "failed-check-retry-route-removed", "failed-final-check-end-only-inspection",
  "required-retry-reads-addition-removed", "required-retry-reads-replacement-permitted", "status-retry-complete-rewrite-removed", "unequal-versioned-copy-refusal-removed",
  "missing-versioned-copy-refusal-removed", "invalid-versioned-copy-existing-file-protection-removed", "versioned-copy-retry-next-unused-name-removed", "versioned-copy-retry-cmp-before-design-change-removed",
  "failed-design-edit-comparison-removed", "unclear-design-edit-comparison-removed", "design-retry-verified-copy-comparison-removed", "design-retry-before-orchestrator-cmp",
  "unchanged-design-edit-only-retry-removed", "partial-design-restore-removed", "partial-design-restore-cp-removed", "partial-design-restore-cmp-removed",
  "partial-design-retry-before-restoration-comparison", "change-start-while-record-writer-permitted", "change-close-while-record-writer-permitted", "log-report-retry-missing-text-not-resent",
  "log-report-retry-present-text-resent", "log-report-retry-partial-text-resent", "log-report-retry-before-inspection", "log-report-partial-correction-without-entry-name"
 ],
 "record-units": [
  "identifiers-ranges/contradiction", "identifiers-ranges/missing", "identifiers-ranges/duplicate", "tool-records-and-recovery/contradiction",
  "tool-records-and-recovery/missing", "tool-records-and-recovery/duplicate", "resume-forks/contradiction", "resume-forks/missing",
  "resume-forks/duplicate", "handoff-pointer/contradiction", "handoff-pointer/missing", "handoff-pointer/duplicate",
  "marker-identity/contradiction", "marker-identity/missing", "marker-identity/duplicate", "resume-order/contradiction",
  "resume-order/missing", "resume-order/duplicate", "general-handoff/contradiction", "general-handoff/missing",
  "general-handoff/duplicate", "closed-range-feedback/contradiction", "closed-range-feedback/missing", "closed-range-feedback/duplicate"
 ],
 "relations": [
  "loading/0/summary", "loading/0/owner", "loading/1/summary", "loading/1/owner",
  "loading/2/summary", "loading/2/owner", "loading/3/summary", "loading/3/owner",
  "loading/4/summary", "loading/4/owner", "nested/0/summary", "nested/0/owner",
  "nested/1/summary", "nested/1/owner", "nested/2/summary", "nested/2/owner",
  "nested/3/summary", "nested/3/owner", "nested/4/summary", "nested/4/owner",
  "nested/5/summary", "nested/5/owner", "nested/6/summary", "nested/6/owner",
  "records/0/summary", "records/0/owner", "records/1/summary", "records/1/owner",
  "records/2/summary", "records/2/owner", "status-trigger/0/summary", "status-trigger/0/owner",
  "canonical-grammar/0/summary", "canonical-grammar/0/owner", "repair-records/0/summary", "repair-records/0/owner",
  "append-only/0/summary", "append-only/0/owner", "append-only/1/summary", "append-only/1/owner",
  "resume-entry/0/summary", "resume-entry/0/owner", "repair-rounds/0/summary", "repair-rounds/0/owner",
  "repair-consultations/0/summary", "repair-consultations/0/owner", "child-fix-title/0/summary", "child-fix-title/0/owner",
  "child-fix-title/1/summary", "child-fix-title/1/owner", "child-attribution/0/summary", "child-attribution/0/owner"
 ],
 "readers": [
  "root-authority", "publishing-authority", "delivery-authority", "version-bytes"
 ],
 "markers": [
  "NN", "padded-integer", "padded-dotted", "multiline-hidden",
  "hidden", "duplicate", "missing-title", "misplaced-title",
  "double-quoted"
 ],
 "change-identity": [
  "0/missing-title-rule", "0/misplaced-title-rule", "0/mutable-title", "1/base-merge-exemption",
  "body-0/missing", "body-0/misplaced", "body-0/dropped", "body-0/changed",
  "body-1/missing", "body-1/misplaced", "body-1/dropped", "body-1/changed",
  "body-2/missing", "body-2/misplaced"
 ],
 "recipes": [
  "common", "nested", "lifecycle", "dispatch"
 ],
 "repairs": [
  "grant", "override-grant-event", "inheritance", "common-inheritance",
  "requirement-count", "sibling-identity", "log-before-cell", "automatic-lowering",
  "investigation-trigger-record", "leftover-repairs", "budget-disclosure"
 ],
 "warnings": [
  "warning-session", "warning-perms", "warning-issue"
 ],
 "common-complete": [
  "title", "authority", "scope", "section",
  "hidden-policy", "before-body", "after-body", "harmless-outside"
 ],
 "nested-pointers": [
  "identifiers/missing", "identifiers/duplicate", "identifiers/empty", "identifiers/contradictory",
  "identifiers/wrong-document", "identifiers/wrong-section", "identifiers/added-policy", "records/missing",
  "records/duplicate", "records/empty", "records/contradictory", "records/wrong-document",
  "records/wrong-section", "records/added-policy", "privacy/missing", "privacy/duplicate",
  "privacy/empty", "privacy/contradictory", "privacy/wrong-document", "privacy/wrong-section",
  "privacy/added-policy"
 ],
 "pointer-comparisons": [
  "identifiers", "records", "privacy"
 ],
 "nested-complete": [
  "weaker-record-rule", "privacy-permission"
 ],
 "audit-repairs": [
  "configuration-draft-row", "recursive-publishing-pointer", "delivery-host-accepted-head", "delivery-every-method",
  "delivery-result-before-closure", "delivery-later-push", "readme-merge-advice", "readme-squash-loss",
  "readme-rebase-loss", "readme-accepted-loss"
 ],
 "one-branch-rules": [
  "accepted-head-before-handoff", "every-merge-method", "source-not-target", "host-unavailable-pause",
  "later-push-new-acceptance-head", "branch-lifetime", "local-verification-resume", "migration-evidence",
  "migration-no-automatic-delete", "migration-stacked-rewrite-pause", "migration-leftovers", "every-push-and-delivery-privacy",
  "explicit-branch", "forbidden-push-forms", "private-match-pause", "rewrite-or-waiver",
  "base-merge-between-ranges", "base-merge-no-owner-title", "no-rebase-after-review", "pause-between-ranges",
  "pause-after-descendants", "no-open-range-interleaving", "late-dependency-replan", "merge-advice",
  "accepted-loss", "no-required-method-settings", "no-target-marker-or-map", "remaining-differences",
  "later-owner", "final-agreement", "root-acceptance-before-merge", "one-draft-change-branch"
 ],
 "history-moves": [
  "no-open-range-interleaving", "late-dependency-replan", "base-merge-between-ranges", "base-merge-no-owner-title",
  "no-rebase-after-review"
 ],
 "ordering-wrapped": [
  "pause-between-ranges", "pause-after-descendants", "no-open-range-interleaving"
 ],

};
export function createMutationAudit(expected = EXPECTED_MUTATIONS) {
 const executed = new Map();
 const crashes = [];
 const record = (family, rows, identity = (row) => row.id) => {
  const entries = executed.get(family) ?? [];
  executed.set(family, entries);
  for (const [index, row] of rows.entries()) {
   try {
    entries.push({ id: identity(row, index), complete: row.changed === true && row.rejected === true
     && row.intended !== false && row.retained !== false
     && (row.originalRuleCount === undefined || row.originalRuleCount === 1)
     && (row.mutatedRuleCount === undefined || row.mutatedRuleCount === 0) });
   } catch { entries.push({ id: "<crashed>", complete: false }); }
  }
 };
 const crash = (error) => crashes.push(String(error));
 const inspect = () => {
  const problems = [...crashes.map((error) => ({ crash: error }))];
  for (const [family, ids] of Object.entries(expected)) {
   const rows = executed.get(family) ?? [];
   const actual = rows.map((row) => row.id);
   if (new Set(ids).size !== ids.length || JSON.stringify(actual) !== JSON.stringify(ids)
    || new Set(actual).size !== actual.length || rows.some((row) => !row.complete))
    problems.push({ family, expected: ids.length, executed: rows.length,
     missing: ids.filter((id) => !actual.includes(id)), failed: rows.filter((row) => !row.complete), actual });
  }
  for (const family of executed.keys()) if (!Object.hasOwn(expected, family)) problems.push({ unexpected: family });
  return { ok: problems.length === 0, problems,
   counts: Object.fromEntries([...executed].map(([family, rows]) => [family, rows.length])) };
 };
 return { record, crash, inspect };
}
export async function loadWithMutationAudit(audit, load) {
 try { return { module: await load() }; }
 catch (error) { audit.crash(error); return { error }; }
}
export async function mutationAuditControls() {
 const good = { id: "a", changed: true, rejected: true };
 return Object.entries({ valid: [good], missing: [], duplicate: [good, good], skipped: [{ id: "a" }], crashed: [undefined], "wrong-protection": [{ ...good, intended: false }] })
  .map(([id, rows]) => {
   const audit = createMutationAudit({ fixture: ["a"] });
   audit.record("fixture", rows);
   return { id, discriminates: audit.inspect().ok === (id === "valid") };
  }).concat(await (async () => {
   const audit = createMutationAudit({ fixture: ["a"] });
   const result = await loadWithMutationAudit(audit, () => import('data:text/javascript,throw new Error("production import control")'));
   audit.record("fixture", [good]);
   return [{ id: "production-throw", discriminates: result.error?.message === "production import control"
    && result.module === undefined && audit.inspect().problems.some(({ crash }) => crash?.includes("production import control")) }];
  })());
}
