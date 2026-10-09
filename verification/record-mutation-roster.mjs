// Independent accepted mutation identities and fail-closed execution accounting.
const RECORD = [
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
	"log-report-retry-present-text-resent", "log-report-retry-partial-text-resent", "log-report-retry-before-inspection", "log-report-partial-correction-without-entry-name",
];
const RETENTION = [
	"remote-replaced", "remote-removed", "remote-record", "remote-namespace",
	"local-absence", "remote-absence", "remote-creation-qualifier", "disabled-push-ban",
	"normal-ancestry", "normal-lease", "preserving-self", "preserving-lifetime",
	"latest-binding", "tree-only", "untracked-sentence", "no-push-pause",
	"inspection-pointer", "explicit-push", "untargeted-push", "pr-branch-explicit-push",
	"pr-branch-no-retention", "lease-not-permission", "retry-read", "unresolved-read",
	"event-inspect", "event-push", "event-read-back", "event-record",
	"event-too-late", "waiver-publication", "private-preservation", "private-choice-permitted rewrite",
	"private-choice-limited explicit waiver", "private-choice-abandonment", "unexpected-record", "missing-record-duty",
	"reset-update-rules", "unexpected-discard", "unexpected-preservation", "recovery-force",
	"final-inspection", "handoff-earlier", "disabled-target", "disabled-markers",
	"disabled-earlier", "merge-earlier", "merge-inferred", "exact-binding",
	"inspection-site-event pushes", "inspection-site-preserving-reference pushes", "inspection-site-level updates", "inspection-site-retries",
	"RG4-reachability", "RG4-mapping", "RG4-unrecorded", "RG4-binding",
	"RG4-ancestry", "RG4-reviewed-replacement",
];
const CLEANUP = [
	"restored-inventory-conditions", "restored-inventory-acceptance-merges", "restored-inventory-comparisons-accounting", "restored-inventory-earlier-authorization",
	"restored-no-earlier-inventory", "restored-inventory-deletion-only", "restored-resume-permitted-observations", "restored-resume-no-authority",
	"restored-resume-inventory-count", "restored-resume-inventory-boundary", "restored-other-closure-conditions", "deleted-authorized-exclusion",
	"deleted-root-record", "deleted-continued-absence", "deleted-no-pause", "deleted-unrecorded-pause",
	"deleted-no-authority", "deleted-resume-exclusion", "deleted-resume-record-boundary", "deleted-resume-remaining-copies",
	"deleted-resume-absence", "deleted-any-missing", "deleted-unauthorized-inventory", "deleted-latest-only",
	"deleted-no-record", "deleted-resume-voided", "after-close", "inventory-early",
	"inventory-count-0", "inventory-count-2", "late-authorization", "source-chain",
	"inferred-binding", "passed-path", "inventory-refusal-record", "inventory-refusal-report",
	"remote-binding", "effective-fetch", "effective-push", "single-effective-URL",
	"URL-read-refusal", "URL-read-record", "URL-read-report", "userinfo-removal",
	"userinfo-identical", "credential-ban", "URL-mismatch-record", "URL-mismatch-report",
	"URL-either URL differs", "URL-the fetch and push URLs differ from each other", "check-ref-format", "prefix-slash",
	"namespace-old", "unlisted", "excluded-pull request branch", "excluded-local level branch",
	"excluded-default branch", "untargeted-prune", "untargeted-mirror", "untargeted-pattern",
	"untargeted-all-branches", "no-explicit-name", "missing-closure", "unmerged-level",
	"closure-refusal-record", "closure-refusal-report", "preservation-log-check", "unmarked-preservation",
	"unmarked-discard-choice", "marked-automatic", "marked-late-choice", "marked-general-choice",
	"inferred-copies", "existence-first", "symbolic-status", "symbolic-excluded",
	"live-read", "remote-first", "absence-first", "repeat-checks",
	"local-old-commit", "local-dereference", "short-name", "unquoted-placeholder",
	"lease---force", "lease---force-with-lease", "lease---force-with-lease=refs/remotes/<remote>/<name>:<inventory-commit>", "lease---force-with-lease=refs/heads/slate-retained/<change>/<other-name>:<inventory-commit>",
	"lease-no-commit", "plus-refspec", "disabled-remote", "initial-missing",
	"continuation-exception-scope", "continuation-evidence", "continuation-live-read", "continuation-local-checks",
	"continuation-present-or-failed", "observation-not-authority", "inventory-authority", "local-retry-read",
	"local-retry-checks", "local-retry-outcomes", "local-retry-report", "retry-read",
	"retry-outcome-0", "retry-outcome-1", "retry-outcome-2", "retry-outcome-3",
	"local-only", "one-sided", "confirmation", "deleted-kept-record",
	"incomplete-Kept copies", "incomplete-failures", "incomplete-unresolved deletions", "incomplete-a failed confirmation listing",
	"incomplete-user-report", "incomplete-observation", "incomplete-record-state", "interruption-report",
	"interruption-open", "abandonment-auto", "ordinary", "publishing-authority",
	"reviewed-state-owner-removal", "void-new track", "void-fix", "void-decision",
	"void-merge-result binding", "void-abandonment withdrawal", "void-handoff state summary", "void-check-before each deletion",
	"void-check-on resume", "void-check-before each retry", "safe-temporary start copy", "safe-separate temporary append texts",
	"safe-`>>`", "safe-whole-record comparison", "safe-retry inspection", "observation-closure evidence",
	"observation-the inventory", "observation-a mark", "observation-a user choice", "record-kind-list",
	"append-limit", "other-write-another record", "other-write-a source folder", "actor",
	"inventory-folder-field", "close-writer", "pointer-order", "disabled-recording",
	"abandonment-recording", "latest-refusal-0", "latest-refusal-1", "latest-refusal-2",
	"latest-refusal-3", "latest-refusal-4", "latest-refusal-5", "latest-refusal-6",
	"latest-refusal-7", "latest-refusal-8", "latest-refusal-9", "latest-refusal-10",
	"latest-refusal-11", "latest-refusal-12", "latest-refusal-13", "latest-refusal-14",
	"report-choice-0", "report-choice-1", "report-choice-2", "report-choice-3",
	"report-choice-4", "report-choice-5", "report-choice-6", "report-choice-7",
	"report-choice-8", "report-choice-9", "report-choice-10", "report-choice-11",
	"report-choice-12", "report-choice-13", "keep-restart-new user report", "keep-restart-a retry choice recorded after that report",
	"resume-abandonment-0", "resume-abandonment-1", "resume-abandonment-2", "resume-abandonment-3",
	"resume-abandonment-4", "resume-abandonment-5", "resume-abandonment-6", "resume-abandonment-7",
	"resume-abandonment-8", "resume-abandonment-9", "inventory-close-barrier", "listing-remote namespace when publishing is enabled",
	"listing-local inventory names in either setting",
];
const numbered = (id, count) => Array.from({ length: count }, (_, index) => `${id}/${index}`);
const combinations = (ids, kinds) => ids.flatMap((id) => kinds.map((kind) => `${id}/${kind}`));
const recordUnits = ["identifiers-ranges", "tool-records-and-recovery", "resume-forks", "handoff-pointer", "marker-identity", "resume-order", "general-handoff", "closed-range-feedback"];
const relations = { loading: 5, nested: 7, records: 3, "status-trigger": 1, "canonical-grammar": 1, "repair-records": 1, "append-only": 2, "resume-entry": 1, "repair-rounds": 1, "repair-consultations": 1, "child-fix-title": 2, "child-attribution": 1 };
const levelCounts = { "publishing-intro": 6, "level-publishing": 22, "publishing-after-merge": 11, "publishing-creation": 39,
 activation: 5, "accepted-history": 14, "cleanup-retention": 2, history: 443, "cleanup-pointer": 1, "private-set": 12,
 "history-owner-pointers": 1, ready: 10, "ready-history": 5, "ready-description": 1, "merge-acceptance": 6,
 "description-scope": 3, "description-record": 3, table: 2, sync: 6, transfer: 13, "disabled-preservation": 3, configuration: 3 };
const headingCounts = { "identifiers-ranges": 33, "manual-records": 122, "resume-forks": 21, "handoff-pointer": 3,
 "resume-order": 19, "general-handoff": 3, "closed-range-feedback": 17, repairs: 60, aggregate: 21, sources: 70,
 "workflow-accounting": 61, "notes-accounting": 22, "publishing-sync": 6, "public-roadmap": 20, "repair-escalation": 45,
 "repair-rounds-owner": 51, "repair-consultations-owner": 26, "child-fix-title-owner": 7, "P13-authoring": 28 };
const sentenceIds = (counts) => Object.entries(counts).flatMap(([id, count]) => numbered(id, count));
const ordering = ["history", "roadmap-pause", "resume-pause", "design-first-base", "design-first-history", "design-first-roadmap",
 "foundation-base", "foundation-merge", "merge-actor", "level-completion-recursive", "dependent-acceptance-recursive",
 "level-completion-publishing", "dependent-acceptance-publishing", "pause-decision", "pause-resume", "event-review",
 "event-acceptance", "event-trigger", "history-scope", "plan-scope", "current-scope", "proposed-scope", "design-scope",
 "review-fix-scope", "local-lifetime", "disabled-remote-duty", "ordering-retention-copy", "ordinary-history-enabled",
 "ordinary-plan-enabled", "ordinary-history-disabled", "ordinary-plan-disabled"];
const peers = ["publishing", "delivery", "lifecycle"];
const escapeKinds = ["extra-scoped-pointer", "ordinary-pointer", "every-change-pointer", "reviewed-binding-move", "verbatim-owner",
 "recovery-before-record", "delete-retained", "delete-reviewed-branch", "delete-branch-before-name", "gate-remove", "gate-drop",
 "discard-reviewed", "purge-reviewed", "prune-reviewed", "erase-reviewed", "new-heading-removal", "new-heading-drop",
 "new-heading-discard", "new-heading-purge", "new-heading-prune", "new-heading-erase", "narrow-private-content", "publish-private-path",
 "privacy-citation", "history-fragment", "privacy-fragment",
 ...["track-3-reviewed", "track-3.1-fix2-reviewed", "track-<number>-reviewed", "track-<number>-fix<r>-reviewed",
 "slate-retained/change/track-3-reviewed", "retained reference", "reviewed reference"].flatMap((name) => [
 `name-only-${name}`, ...["delete", "remove", "drop", "discard", "purge", "prune", "erase", "reset", "move", "rename", "force", "overwrite", "replace", "rewrite"]
 .flatMap((verb) => [`verb-first-${verb}-${name}`, `name-first-${verb}-${name}`])])];
export const EXPECTED_MUTATIONS = {
 "delivery-rules": sentenceIds({ repairs: 60, aggregate: 21, issues: 14, sources: 70, "workflow-accounting": 61,
 "notes-accounting": 22, "publishing-sync": 6, "public-workflow": 24, "public-roadmap": 20 }),
 transfer: numbered("transfer", 5),
 "sequential-acceptance": ["subtree-merged-before-root-without-marker-distinction", "root-recreates-earlier-subtree-marker", "root-adds-marker-for-every-accepted-subtree"],
 "level-rules": sentenceIds(levelCounts),
 "safety-removals": sentenceIds({ ...levelCounts, "lifecycle-planning": 38, "resume-order": 19, "public-roadmap": 20 }),
 ordering,
 "ordering-wrapped": [0, 1, 2].flatMap((index) => ordering.map((id) => `${index}/${id}`)),
 mergeability: sentenceIds({ lifecycle: 5, publishing: 5, focus: 5 }),
 "peer-retention": sentenceIds({ nested: 4, common: 4, publishing: 4, delivery: 4, lifecycle: 4 }),
 "peer-escape": combinations(peers, escapeKinds),
 "owner-copies": sentenceIds({ publishing: 455, delivery: 455, lifecycle: 455 }),
 "peer-pins": [["publishing", 8, 3], ["delivery", 7, 1], ["lifecycle", 13, 4]].flatMap(([id, headings, contexts]) =>
 [0, 1, 2, 3, 4, 5].flatMap((rule) => [...numbered("heading", headings).map((name) => name.replace("/", "-")),
 "end", "new-heading", ...numbered("context", contexts).map((name) => name.replace("/", "-"))].map((position) => `${id}/${rule}/${position}`))),
 pointers: [["publishing", "ready-history"], ["delivery", "transfer"], ["lifecycle", "accepted-history"], ["lifecycle", "cleanup-pointer"]]
 .flatMap(([id, unit]) => ["scope", "destination", ...(unit === "transfer" ? ["disabled"] : [])].map((kind) => `${id}/${unit}/${kind}`)),
 "history-moves": ["event", "inspection", "wrapped-event", "wrapped-lifecycle-scope", "wrapped-dependency-base"],
 "heading-policy": Object.entries(headingCounts).flatMap(([id, count]) => combinations([id], ["missing", "duplicate", "empty",
 "empty-duplicate", "closed-heading-duplicate", "peer-truncation", ...[1, 2, 3, 4, 5].map((index) => `higher-truncation-${index}`),
 ...Array.from({ length: count }, (_, index) => `sentence-${index}`)])),
 "record-contract": RECORD,
 "named-rules": RECORD.slice(12),
 "record-units": combinations(recordUnits, ["contradiction", "missing", "duplicate"]),
 relations: Object.entries(relations).flatMap(([id, count]) => combinations(numbered(id, count), ["summary", "owner"])),
 readers: ["root-authority", "publishing-authority", "delivery-authority", "version-bytes"],
 markers: ["NN", "padded-integer", "padded-dotted", "multiline-hidden", "hidden", "duplicate"],
 recipes: ["common", "nested", "lifecycle", "dispatch"],
 repairs: ["grant", "override-grant-event", "inheritance", "common-inheritance", "requirement-count", "sibling-identity", "log-before-cell", "automatic-lowering", "investigation-trigger-record", "leftover-repairs", "budget-disclosure"],
 warnings: ["warning-session", "warning-perms", "warning-issue"],
 "common-complete": ["title", "authority", "scope", "section", "hidden-policy", "before-body", "after-body", "harmless-outside"],
 "nested-pointers": combinations(["identifiers", "records", "privacy"], ["missing", "duplicate", "empty", "contradictory", "wrong-document", "wrong-section", "added-policy"]),
 "pointer-comparisons": ["identifiers", "records", "privacy"],
 "nested-complete": ["weaker-record-rule", "privacy-permission"],
 "citation-destination": ["label", "document", "section", "missing", "duplicate", "destination-missing", "destination-duplicate", "destination-changed"],
 retention: RETENTION,
 "retention-wrapped": RETENTION,
 cleanup: CLEANUP,
 "cleanup-wrapped": Array.from({ length: 13 }, (_, index) => CLEANUP.map((id) => `${index}/${id}`)).flat(),
 "cleanup-routes": ["post-close-write", "closing-exception", "later-session", "validated-closed-folder", "nested-manual-records"],
 "cleanup-routes-wrapped": combinations(["post-close-write", "closing-exception", "later-session", "validated-closed-folder"], ["<!-- level-history-policy:end -->", "## Identifiers, code ranges, and design markers", "## Manual records and safe writes", "document-end"]),
 "cleanup-outside": numbered("outside", 7),
 "cleanup-pointer": ["For changes that load the nested sections", "retention inventory", "cleanup before close"],
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
