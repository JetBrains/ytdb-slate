import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { REVIEW_RI_DOC } from "../extension/paths.ts";

const read = (file: string) => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const reviews = read("docs/review-rules.md");
const workflow = read("docs/track-workflow.md");
const records = read("docs/change-records.md");
const maps = read("docs/maps.md");
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const once = (source: string, rule: string) => normalize(source).split(normalize(rule)).length === 2;

test("both approval owners require the user before repair at every severity", () => {
  const confirmation = "At every severity, obtain user design-update approval before a fix adds goals or non-goals, or changes approved guarantees, assumptions or reasoning. Without approval, stop that repair. Record the decision in the owning research log. Existing waiver, deferral and scope routes do not bypass termination.";
  const ordered = "2. Separately, at every severity, obtain user approval before applying a fix that adds a goal or non-goal, or changes an approved guarantee, assumption or reasoning. Use the Confirmation gate design-update approval, not a new escalation event. Without approval, stop that repair. Record the decision in the owning research log. Use existing waiver, deferral or scope routes without bypassing termination.";
  const five = "Five cases require a user decision: a waiver, a scope exception, a pre-existing defect, lowering a blocker, and an implementation-level finding without a recommended fix.";
  const accepts = (w: string, r: string) => once(w, confirmation) && once(w, five) && once(r, ordered)
    && r.indexOf(ordered) < r.indexOf("3. Apply recommended fixes")
    && once(r, "1. Route the five mandatory user cases before automatic repair.");
  assert.ok(accepts(workflow, reviews));
  for (const [source, rule] of [[workflow, confirmation], [reviews, ordered]] as const) {
    for (const term of ["every severity", "user", "before", "goal", "non-goal", "guarantee", "assumption", "reasoning", "Without approval", "stop", "waiver", "deferral", "scope", "termination", "that repair", "Record the decision in the owning research log"]) {
      const changed = normalize(source).replace(rule, rule.replace(term, "REMOVED"));
      assert.notEqual(changed, normalize(source), term);
      assert.equal(source === workflow ? accepts(changed, reviews) : accepts(workflow, changed), false, term);
    }
  }
  assert.equal(accepts(normalize(workflow).replace(confirmation, ""), reviews), false);
  assert.equal(accepts(workflow, reviews.replace(ordered, "")), false);
  assert.ok(accepts(workflow + "\nUnrelated appendix.", reviews));
  assert.ok(once(reviews, "never lower it because a design approved the behavior"));
  assert.ok(once(reviews, "Record design-level triage with the finding identifier in the owning research log, without adding a finding field."));
  assert.ok(once(workflow, "Record every design-level change in the design update or track package."));
});

test("access delegation and checker readers agree with role-limited map inputs", () => {
  const readerRules = [
    "Authorized checkers also read this reference.",
    "Design adversaries check baseline facts after independent review.",
    "Reviewer I checks supplied implementation-map facts after independent range review.",
    "Agentic fix gates check only fixer-selected statements and their related questions.",
    "Other implementation specialists and user-review fix-range gates receive no implementation-map input.",
    "Stuck-fix consultations gain no separate map input.",
    "Questions are map content, not implementer reasoning.",
    "Partial recipients receive only questions tied to supplied statements.",
    "A separate question list grants no wider access.",
  ];
  const inputRules = [
    "It reviews independently before checking baseline facts.",
    "Only Reviewer I receives an implementation map.",
    "The fixer names the map statements its fix relies on.",
    "The orchestrator passes them unread to the agentic fix gate.",
    "A user-review fix-range gate receives no map statements.",
    "Questions follow authorized map inputs.",
    "Partial recipients receive only questions tied to supplied statements.",
    "No separate list expands access.",
  ];
  const accepts = (m: string, r: string) => readerRules.every((rule) => once(m, rule)) && inputRules.every((rule) => once(r, rule));
  assert.ok(accepts(maps, reviews));
  for (const rule of readerRules) assert.equal(accepts(maps.replace(rule, ""), reviews), false);
  for (const rule of inputRules) assert.equal(accepts(maps, reviews.replace(rule, "")), false);
  for (const source of [workflow, records]) {
    assert.match(source, /Reviewer access.*\[review-rules.md\]\(review-rules.md\) § Reviewer input contract/);
    assert.doesNotMatch(source, /Exclude their references and contents from reviewer inputs|approved standalone design remains available to its required design reviewers/);
  }
  assert.match(read("docs/recursive-workflow.md"), /Use \[change-records.md\]\(change-records.md\) § Design authority and privacy/);
  assert.ok(once(workflow, "An empty set adds no map reviewer."));
  assert.ok(once(readFileSync(REVIEW_RI_DOC, "utf8"), "Review the range independently first, then check facts in any supplied implementation map."));
});

test("map prohibition survives in authority and delivered shared input", () => {
  const rule = "Without map authorization, do not read or seek an implementation map, including its question list.";
  const input = read("docs/review-implementation-input.md");
  const accepts = (authority: string, delivered: string) => once(authority, rule) && once(delivered, rule);
  assert.ok(accepts(reviews, input));
  assert.equal(accepts(reviews.replace(rule, ""), input), false);
  assert.equal(accepts(reviews, input.replace(rule, "")), false);
  assert.ok(accepts(reviews + "\nUnrelated appendix.", input));
});

test("fixer dispatch, response and coverage expose their duties", () => {
  assert.ok(once(reviews, "It re-reads affected source and names the map statements its fix relies on."));
  assert.ok(once(workflow, "names any map statements its fix relies on and ends with approximate counted lines"));
  const coverage = workflow.split("## Review coverage\n\n")[1]!.split("\n### ")[0]!;
  const pointer = "Use [review-rules.md](review-rules.md) § Reviewer input contract.";
  assert.ok(once(coverage, pointer));
  assert.equal(once(coverage.replace(pointer, ""), pointer), false);
});

test("all review dispatch routes preserve the input authority and unread checking reference", () => {
  for (const rule of [
    "Manual reviews use this input contract, the common policy and applicable charter. Name [maps.md](maps.md) in authorized map-checking tasks without reading it.",
    "Supply stage-authorized inputs under § Reviewer input contract. Name the map reference in authorized checking tasks without reading it.",
    "diff and authorized designs and map statements under § Reviewer input contract. Name the map reference for checking without reading it.",
    "Supply applicable approved designs under § Reviewer input contract.",
  ]) assert.ok(once(reviews, rule), rule);
  assert.ok(once(workflow, "Stuck-fix consultation uses [review-rules.md](review-rules.md) § Reviewer input contract: applicable approved designs, intact episodes, no separate risk record or area proof."));
});
