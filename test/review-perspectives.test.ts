import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ThreadManager, type DispatchOptions } from "../extension/threads.ts";
import { SlateStore } from "../extension/state.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { REVIEW_PERSPECTIVES, validateReviewPerspectives } from "../extension/review-perspectives.ts";
import { REVIEW_COMMON_POLICY_DOC, REVIEW_IMPLEMENTATION_INPUT_DOC, REVIEW_NL_DOC, REVIEW_CB_DOC, WRITING_CHECKER, WRITING_GUIDANCE_DOC } from "../extension/paths.ts";
import { REVIEWER_CHARTER, workerPreamble, workerSystemPromptBlocks } from "../extension/worker.ts";

const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }] } } } });
const admittedRuntime = Object.freeze({ ...runtime, validateRoute: async () => ({ ok: true } as const) });
const ctx = { cwd: process.cwd(), modelRegistry: { find: () => ({ provider: "test", id: "worker" }), hasConfiguredAuth: () => true, getAvailable: async () => [] } } as unknown as ExtensionContext;
const base = { task: "review this approved range", type: "reviewer", model: "fixture", reason: "review" } as const;
function harness(read?: (file: string) => string) {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, {}, undefined, admittedRuntime, undefined, {}, read);
  const calls: Array<{ opts: DispatchOptions; guidance: string | undefined }> = [];
  (manager as unknown as { runDispatch: (...args: unknown[]) => unknown }).runDispatch = (_thread: unknown, opts: unknown, _prompt: unknown, _ctx: unknown, _signal: unknown, _progress: unknown, _admission: unknown, _route: unknown, guidance: unknown) => {
    calls.push({ opts: opts as DispatchOptions, guidance: guidance as string | undefined });
    return _thread;
  };
  return { manager, store, calls };
}
const occurrences = (whole: string, part: string) => whole.split(part).length - 1;

test("invalid selections refuse before a thread or worker exists", { timeout: 5000 }, async () => {
  const { manager, store, calls } = harness();
  const invalid: Array<[unknown, string, RegExp]> = [
    [[], "reviewer", /non-empty list/], ["Reviewer I", "reviewer", /non-empty list/],
    [["Reviewer I", 3], "reviewer", /non-empty list/],
    [["Other reviewer"], "reviewer", /Unknown review perspective/],
    [["CN"], "reviewer", /Unknown review perspective/],
    [null, "reviewer", /non-empty list/],
    [{ name: "Reviewer I" }, "reviewer", /non-empty list/],
    [["Security reviewer", "Security reviewer"], "reviewer", /Duplicate/],
    [["Reviewer I", "Security reviewer"], "reviewer", /one-item/],
    [["Security reviewer", "Reviewer I"], "reviewer", /one-item/],
    [["Test-quality and structure reviewer", "Security reviewer"], "reviewer", /one-item/],
    [["Reviewer I"], "adversarial", /requires thread type reviewer/],
    [["Reviewer I"], "general", /requires thread type reviewer/],
    [["Reviewer I"], "implementer", /requires thread type reviewer/],
  ];
  for (const [reviewPerspectives, type, error] of invalid) {
    await assert.rejects(manager.dispatch({ ...base, type: type as "reviewer", reviewPerspectives }, ctx, undefined), error);
    assert.equal(store.threads.size, 0);
    assert.equal(calls.length, 0);
  }
  assert.equal(validateReviewPerspectives(["Security reviewer", "Prose reviewer"], "reviewer")?.length, 2);
  assert.deepEqual(validateReviewPerspectives(["Test-quality and structure reviewer"], "reviewer"), ["Test-quality and structure reviewer"]);
});

test("every missing, unreadable, or blank required file refuses before thread creation", { timeout: 5000 }, async () => {
  const required = [REVIEW_COMMON_POLICY_DOC, REVIEW_IMPLEMENTATION_INPUT_DOC, REVIEW_NL_DOC, REVIEW_CB_DOC];
  for (const file of required) {
    for (const failure of ["missing", "unreadable", "blank"] as const) {
      const { manager, store, calls } = harness((path) => {
        if (path === file) {
          if (failure === "blank") return " \n\t";
          throw Object.assign(new Error(failure === "missing" ? "ENOENT" : "EACCES"), { code: failure === "missing" ? "ENOENT" : "EACCES" });
        }
        return readFileSync(path, "utf8");
      });
      await assert.rejects(manager.dispatch({ ...base, reviewPerspectives: ["Non-local logic defect reviewer", "Consumer contract break reviewer"] }, ctx, undefined), (error: Error) => {
        assert.match(error.message, new RegExp(file.split("/").at(-1)!.replace(".", "\\.")));
        assert.match(error.message, failure === "blank" ? /empty after whitespace trimming/ : failure === "missing" ? /ENOENT/ : /EACCES/);
        return true;
      });
      assert.equal(store.threads.size, 0);
      assert.equal(calls.length, 0);
    }
  }
});

test("selected guidance reaches the worker system blocks in selection order, once per file", { timeout: 5000 }, async () => {
  const common = readFileSync(REVIEW_COMMON_POLICY_DOC, "utf8").trim()
    .replaceAll("<installed-writing-checker>", WRITING_CHECKER)
    .replaceAll("<installed-writing-guidance>", WRITING_GUIDANCE_DOC);
  const input = readFileSync(REVIEW_IMPLEMENTATION_INPUT_DOC, "utf8").trim();
  for (const selected of [["Reviewer I"], ["Consumer contract break reviewer", "Non-local logic defect reviewer"], ["Unreported failure reviewer"]] as const) {
    const { manager, calls } = harness();
    await manager.dispatch({ ...base, reviewPerspectives: [...selected] }, ctx, undefined);
    assert.equal(calls.length, 1);
    const expected = [common, input, ...selected.map((name) => readFileSync(REVIEW_PERSPECTIVES.find((role) => role.name === name)!.file, "utf8").trim())].join("\n\n");
    assert.equal(calls[0]!.guidance, expected);
    const blocks = workerSystemPromptBlocks(true, true, calls[0]!.guidance, []);
    assert.deepEqual(blocks, [workerPreamble(true, true), expected]);
    assert.equal(occurrences(blocks.join("\n\n"), REVIEWER_CHARTER.trim().slice(0, 22)), 1);
    assert.equal(occurrences(expected, "## Common review policy"), 1);
    assert.equal(occurrences(expected, "## Implementation-review inputs"), 1);
    assert.equal(occurrences(expected, "### Implementation design quality"), 1);
    assert.ok(expected.indexOf("### Implementation design quality") > expected.indexOf("## Common review policy"));
    for (const name of selected) {
      assert.equal(occurrences(expected, `# ${name}\n`), 1);
      assert.ok(expected.indexOf("### Implementation design quality") < expected.indexOf(`# ${name}\n`));
      const charter = readFileSync(REVIEW_PERSPECTIVES.find((role) => role.name === name)!.file, "utf8");
      assert.ok(charter.indexOf("**Charter.**") < charter.indexOf("**Design-quality questions**"));
      assert.ok(charter.indexOf("**Design-quality questions**") < charter.indexOf("**Examples of useful evidence**"));
    }
    // These independent duties fail when the source is lost, even if both generated copies agree.
    assert.match(expected, /Do not seek these private sources/);
    assert.match(expected, /A design concern is a finding only when evidence links it to a concrete adverse effect/);
    assert.match(expected, /These questions change no trigger, boundary, reviewer count, merge rule, gate, or user authority/);
    if (selected[0] === "Reviewer I") assert.match(expected, /does not absorb an absent specialist charter/);
    if (selected[0] === "Consumer contract break reviewer") {
      assert.match(expected, /record written by the review base and read by the candidate/);
      assert.match(expected, /first run, a repeat run, an interrupted run and a restart/);
    }
    if (selected[0] === "Unreported failure reviewer") {
      assert.match(expected, /Can a fallback, retry, default, partial result, ignored status, or unchecked effect appear to be full success\?/);
      assert.match(expected, /These are examples, not required checks or artifacts/);
    }
  }
});

test("omitted selection preserves the manual route without automatic policy", { timeout: 5000 }, async () => {
  const { manager, calls, store } = harness(() => { throw new Error("manual dispatch must not read review files"); });
  await manager.dispatch(base, ctx, undefined);
  assert.equal(store.threads.size, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.guidance, undefined);
  assert.deepEqual(workerSystemPromptBlocks(true, true, calls[0]!.guidance, []), [workerPreamble(true, true)]);
  assert.doesNotMatch(workerSystemPromptBlocks(true, true, calls[0]!.guidance, []).join("\n"), /Implementation design quality|Design-quality questions/);
});
