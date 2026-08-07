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
  assert.equal(result.draftPRs, "unchanged");
  assert.equal(result.followUpIssues, true);
  assert.deepEqual(warnings, []);
});

test("workflow follow-up issues renders a symbol through the string fallback", () => {
  const { result, warnings } = sanitize({ followUpIssues: Symbol("unsupported") });
  assert.equal(result.followUpIssues, false);
  assert.deepEqual(warnings, [
    "slate: ignoring workflow.followUpIssues Symbol(unsupported). Expected true or false. Slate uses false.",
  ]);
});

test("workflow follow-up issues contains an unprintable fallback value", () => {
  const value = {
    toJSON: () => undefined,
    [Symbol.toPrimitive]: () => { throw new Error("cannot render"); },
  };
  const { result, warnings } = sanitize({ followUpIssues: value });
  assert.equal(result.followUpIssues, false);
  assert.deepEqual(warnings, [
    "slate: ignoring workflow.followUpIssues [unprintable object]. Expected true or false. Slate uses false.",
  ]);
});

test("workflow follow-up issues contains a deeply nested invalid value", () => {
  let value: Record<string, unknown> = {};
  for (let depth = 0; depth < 5_000; depth += 1) value = { nested: value };
  const { result, warnings } = sanitize({ followUpIssues: value });
  assert.equal(result.followUpIssues, false);
  assert.deepEqual(warnings, [
    "slate: ignoring workflow.followUpIssues [object Object]. Expected true or false. Slate uses false.",
  ]);
});

test("workflow follow-up issues ignores an inherited value", () => {
  const workflow = Object.create({ followUpIssues: true }) as Record<string, unknown>;
  const { result, warnings } = sanitize(workflow);
  assert.deepEqual(result, { followUpIssues: false });
  assert.deepEqual(warnings, []);
});

test("workflow sanitization drops inherited draftPRs", () => {
  const workflow = Object.create({ draftPRs: true }) as Record<string, unknown>;
  workflow.followUpIssues = false;
  const { result, warnings } = sanitize(workflow);
  assert.deepEqual(result, { followUpIssues: false });
  assert.equal(Object.prototype.hasOwnProperty.call(result, "draftPRs"), false);
  assert.deepEqual(warnings, []);
});
