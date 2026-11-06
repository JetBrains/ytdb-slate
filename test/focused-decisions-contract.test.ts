import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const duties: Record<string, string[]> = {
  "track-workflow.md": [
    "Omit the before phase only when approval state covers the track design.",
    "Approval state is the last approved version plus recorded changes that need no approval.",
    "Presentation alone grants no approval.",
    "Present each design, plan, and implementation explanation fully once.",
    "Apply this rule to a baseline map when one is supplied.",
    "For later presentations, compare with the last shown version, else the last approved or accepted version.",
    "Retain the comparison versions in the state summary across handoffs.",
    "Show only changes. If unchanged, give one short no-change sentence.",
    "Neither presentation nor a no-change statement grants approval.",
    "Give a full recap on request.",
    "Each question names the earlier content and gives the context needed for that decision.",
    "Explain a needed workflow artifact at its first use in each session.",
    "Keep no explanation-history register across handoffs.",
    "Put all open decisions in one section with separate choices for each decision.",
    "present a short plan for approval of behavior, scope, and necessary user choices.",
    "chooses the split without approval.",
    "Announce each added track and its reason, then complete its applicable gates.",
    "The announcement authorizes neither a scope exception nor a changed design.",
    "Lead each request with one recommended outcome and its reason.",
    "List the other allowed outcomes and their consequences.",
    "Let the user accept or reject each fix separately. Keep one commit per fix.",
    "A single-track change sends one change package without a track name and asks only final acceptance.",
    "Show references only for decisions.",
    "Follow [review-rules.md](review-rules.md) § Findings and output for severity, required fixes, minor dispositions, and moot or rejected findings in both review phases.",
  ],
  "delivery-packages.md": [
    "Lead with the track or change intention.",
    "Keep failed checks, unmet targets, missing measurements, and known limits that affect acceptance visible.",
    "Show names, finding details, and accounting references only when a decision needs them.",
    "The package asks for blocking track acceptance for every code track in a multi-track change, regardless of proved areas.",
    "Final change acceptance remains separate.",
    "A single-track change sends one completion message using the change package.",
    "Use no track name and ask only for final change acceptance.",
    "Do not send a separate track package.",
    "Keep a no-advice result only in the research log and omit the field.",
    "Link the diff only when a decision needs it.",
    "Disclose merge state and unmerged dependencies when acceptance needs them.",
    "Report delivery state only when a decision needs it.",
    "Show record and range references only when a decision needs them.",
  ],
  "user-notes.md": [
    "- the action to take. - when the action will happen. - its effect on other work.",
    "Show identifiers and internal routes only when a decision needs them.",
    "Keep repeated post-drain cycles internal until escalation needs a choice.",
    "Only the owning research log carries the ignored-finding index.",
    "Do not copy routine minor findings, dispositions, or reasons to pull requests or delivery records.",
    "A mandatory exception still discloses the information its decision needs.",
    "A single-track change sends one change package without a track name and asks only final acceptance.",
    "Show record and diff references only when a decision needs them.",
    "A single-track change sends no separate track package.",
  ],
  "pr-publishing.md": [
    "Author and maintain it without presenting it for approval.",
    "With a high-level design, create it after final design approval.",
    "Ask for ready-for-review permission.",
    "Keep commits, accounting, and the ignored-finding index in the owning research log.",
    "The behavior summary replaces presentation of the final description.",
    "The description remains available on request.",
    "Before merge, summarize behavior changes since the previous summary.",
    "Keep the skipped late-area design-gate record visible at final acceptance.",
    "Ask one batch acceptance question with each fix separately selectable.",
    "Report delivery state only when a decision needs it.",
    "Record the observed delivery result and accepted-head comparison only in the owning research log.",
    "Ready status and the merge act supply no missing whole-subtree or root final acceptance.",
  ],
  "configuration.md": [
    "Show the field only when records support advice.",
    "Keep no-advice results in the research log. Never edit routing files.",
  ],
  "model-routing.md": [
    "change package includes its routing field only when records support advice.",
    "offer routing advice before final acceptance only when records support a recommendation.",
    "Keep a no-advice result only in the research log. Do not invent a recommendation.",
  ],
  "context-budget.md": [
    "Its 28,039 portable characters exceed the whole-doctrine ceiling by 1,739.",
  ],
  "change-records.md": [
    "Keep that endpoint in the owning research log.",
    "Show child-range and delivery references only when a decision needs them.",
  ],
  "recursive-workflow.md": [
    "Show design, child-evidence, and delivery references only when the decision needs them.",
    "Keep the change delivery state in the owning research log.",
  ],
  "design-principles.md": [
    "**P15 — Hide workflow details unless needed.**",
    "Show a workflow detail only when a decision or required user action needs it.",
    "**P16 — Present only what the current need requires.**",
    "Presentation grants no approval.",
  ],
};

const unconditionalCopies: Record<string, string[]> = {
  "pr-publishing.md": ["The root final package lists every level delivery.", "Report the delivery state in the next applicable package."],
  "user-notes.md": ["The package references those records and the diff.", "A single-track change uses the combined package"],
  "delivery-packages.md": ["Reference those owning records and accepted ranges.", "A design package distinguishes merged levels from every level waiting for merge", "Report the delivery state in the next applicable package."],
  "track-workflow.md": ["Intermediate packages reference those sources", "Every completed track reaches the user through the track package"],
  "recursive-workflow.md": ["It identifies the approved design, accepted child evidence, and every subtree level delivery.", "Use its § Change package for the root's complete level-delivery list."],
  "change-records.md": ["Record that exact endpoint in the final package.", "Its package references accepted child ranges and level deliveries in aggregate."],
};

test("package copies reject unconditional reference and single-track duties", () => {
  for (const [file, forbidden] of Object.entries(unconditionalCopies)) {
    const source = normalize(readFileSync(new URL(`../docs/${file}`, import.meta.url), "utf8"));
    const accepts = (text: string) => forbidden.every((rule) => !text.includes(rule));
    assert.ok(accepts(source), file);
    for (const rule of forbidden) assert.equal(accepts(`${source} ${rule}`), false, rule);
  }
});

for (const [file, rules] of Object.entries(duties)) {
  test(`focused decisions preserve each duty in ${file}`, () => {
    const source = normalize(readFileSync(new URL(`../docs/${file}`, import.meta.url), "utf8"));
    const accepts = (text: string) => rules.every((rule) => text.includes(rule));
    assert.ok(accepts(source));
    for (const rule of rules) {
      const mutated = source.replaceAll(rule, "Contradictory policy.");
      assert.notEqual(mutated, source, rule);
      assert.equal(accepts(mutated), false, rule);
    }
  });
}
