import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeWorkflowConfig } from "../extension/state.ts";

function sanitize(raw: unknown): { result: ReturnType<typeof sanitizeWorkflowConfig>; warnings: string[] } {
  const warnings: string[] = [];
  const result = sanitizeWorkflowConfig(raw, (warning) => warnings.push(warning));
  return { result, warnings };
}

test("workflow follow-up issues accepts true", () => {
  const { result, warnings } = sanitize({ followUpIssues: true });
  assert.equal(result.followUpIssues, true);
  assert.deepEqual(warnings, []);
});

test("workflow follow-up issues accepts false", () => {
  const { result, warnings } = sanitize({ followUpIssues: false });
  assert.equal(result.followUpIssues, false);
  assert.deepEqual(warnings, []);
});

test("workflow follow-up issues defaults to false when the key is absent", () => {
  const { result, warnings } = sanitize({});
  assert.equal(result.followUpIssues, false);
  assert.deepEqual(warnings, []);
});

test("workflow follow-up issues defaults to false when workflow is absent", () => {
  const { result, warnings } = sanitize(undefined);
  assert.deepEqual(result, { followUpIssues: false });
  assert.deepEqual(warnings, []);
});

test("workflow follow-up issues defaults to false when workflow is not an object", () => {
  const { result, warnings } = sanitize("invalid workflow");
  assert.deepEqual(result, { followUpIssues: false });
  assert.deepEqual(warnings, []);
});

test("workflow follow-up issues warns and defaults to false for a non-boolean value", () => {
  const { result, warnings } = sanitize({ followUpIssues: "yes" });
  assert.equal(result.followUpIssues, false);
  assert.deepEqual(warnings, [
    'slate: ignoring workflow.followUpIssues "yes". Expected true or false. Slate uses false.',
  ]);
});

test("workflow sanitization preserves draftPRs beside follow-up issues", () => {
  const { result, warnings } = sanitize({ draftPRs: "unchanged", followUpIssues: true });
  assert.equal((result as { draftPRs?: unknown }).draftPRs, "unchanged");
  assert.equal(result.followUpIssues, true);
  assert.deepEqual(warnings, []);
});
