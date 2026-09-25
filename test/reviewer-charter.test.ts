import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "../verification/test-hooks.mjs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REVIEW_COMMON_POLICY_DOC, REVIEW_IMPLEMENTATION_INPUT_DOC, WRITING_CHECKER, WRITING_GUIDANCE_DOC } from "../extension/paths.ts";
import { REVIEW_PERSPECTIVES } from "../extension/review-perspectives.ts";
import { SlateStore, THREAD_TYPES, type ThreadRecord, type ThreadType } from "../extension/state.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import type { WorkerSession } from "../extension/worker.ts";

const codingAgentModule = await import("@earendil-works/pi-coding-agent") as unknown as {
  codingAgentStub: {
    createAgentSession(options: Record<string, unknown>): Promise<{ session: WorkerSession }>;
  };
};
const { codingAgentStub } = codingAgentModule;
const originalCreateAgentSession = codingAgentStub.createAgentSession;
const { ThreadManager } = await import("../extension/threads.ts");
const {
  REVIEWER_CHARTER,
  workerPreamble,
  WORKER_PREAMBLE,
  WORKER_WRITING_GUIDANCE,
} = await import("../extension/worker.ts");

interface ManagerInternals {
  openWorkerFor(args: {
    thread: ThreadRecord;
    ctx: ExtensionContext;
    open: Record<string, never>;
    tools: string[] | undefined;
    report: (message: string) => void;
  }): Promise<unknown>;
}

function record(id: string, type?: ThreadType): ThreadRecord {
  return {
    id,
    name: id,
    status: "cancelled",
    type: type ?? "general",
    createdAt: 1,
    updatedAt: 1,
  };
}

const EXPECTED_CHARTER_BY_THREAD_TYPE = {
  researcher: false,
  reviewer: true,
  adversarial: true,
  implementer: false,
  general: false,
} as const satisfies Record<ThreadType, boolean>;

const PARALLEL_TOOL_RULE =
  "Issue all independent tool calls simultaneously in one worker turn. Use separate turns only when results depend on each other or conflict.";
const COST_REASON_SENTENCES = [
  "The harness runs calls issued in one turn at the same time.",
  "Cumulative token cost grows with the square of the number of turns because each turn resends the conversation history.",
] as const;

test("workerPreamble keeps unchanged reviewer guidance independent of writing trust", () => {
  const untrusted = workerPreamble(false, false);
  const trusted = workerPreamble(true, false);
  const untrustedReviewer = workerPreamble(false, true);
  const trustedReviewer = workerPreamble(true, true);

  assert.equal(untrusted, WORKER_PREAMBLE);
  assert.equal(trusted, `${WORKER_PREAMBLE} ${WORKER_WRITING_GUIDANCE}`);
  assert.ok(WORKER_WRITING_GUIDANCE.includes("Describe only the current state in the README, docs, code comments and the project's own agent instruction file, not removed features or past behavior, but allow change records such as pull request descriptions, delivery commit bodies, release notes and issues to describe removals and past behavior."));
  assert.equal(untrustedReviewer, `${WORKER_PREAMBLE}\n${REVIEWER_CHARTER}`);
  assert.equal(trustedReviewer, `${WORKER_PREAMBLE} ${WORKER_WRITING_GUIDANCE}\n${REVIEWER_CHARTER}`);
  for (const preamble of [untrusted, trusted, untrustedReviewer, trustedReviewer]) {
    assert.equal(preamble.split(PARALLEL_TOOL_RULE).length - 1, 1);
    for (const sentence of COST_REASON_SENTENCES) assert.equal(preamble.split(sentence).length - 1, 1);
  }
  assert.deepEqual(
    [untrusted, trusted, untrustedReviewer, trustedReviewer].map((preamble) => Buffer.byteLength(preamble)),
    [544, 1097, 2699, 3252],
  );
  assert.equal(untrustedReviewer.match(/^- /gm)?.length, 10);
  assert.equal(trustedReviewer.match(/^- /gm)?.length, 10);
  assert.doesNotMatch(untrusted, /Trace, don't guess/);
  assert.doesNotMatch(trusted, /Trace, don't guess/);
  assert.match(untrustedReviewer, /Trace, don't guess/);
  assert.match(trustedReviewer, /Trace, don't guess/);
});

test("real worker assembly delivers the charter only to review thread types", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-reviewer-charter-test."));
  const opened: Array<Record<string, unknown>> = [];
  const reports: string[] = [];
  const fakeSession = {
    model: undefined,
    thinkingLevel: "medium",
    modelRuntime: { getRegisteredProviderIds: () => [] },
    async bindExtensions() {},
    extensionRunner: { async emit() {} },
    dispose() {},
    agent: { state: { tools: [] } },
  } as unknown as WorkerSession;
  codingAgentStub.createAgentSession = async (options) => {
    opened.push(options);
    return { session: fakeSession };
  };
  const ctx = {
    cwd: root,
    model: undefined,
    isProjectTrusted: () => true,
    modelRegistry: {
      getRegisteredProviderIds: () => [],
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    },
  } as unknown as ExtensionContext;
  const manager = new ThreadManager({} as never, { writing: { check: false, remind: false } });
  const view = manager as unknown as ManagerInternals;
  const cases: Array<[ThreadType | undefined, boolean]> = [
    ...THREAD_TYPES.map((type): [ThreadType, boolean] => [type, EXPECTED_CHARTER_BY_THREAD_TYPE[type]]),
    [undefined, false],
  ];

  try {
    assert.ok(
      cases.some(([type, hasCharter]) => type === undefined && hasCharter === false),
      "cases include the untyped legacy thread",
    );
    for (const [type, hasCharter] of cases) {
      await view.openWorkerFor({
        thread: record(`thread-${type ?? "untyped"}`, type),
        ctx,
        open: {},
        tools: undefined,
        report: (message) => reports.push(message),
      });
      const loader = opened.at(-1)?.resourceLoader as { options?: { appendSystemPrompt?: unknown[] } } | undefined;
      const appendSystemPrompt = loader?.options?.appendSystemPrompt;
      assert.deepEqual(appendSystemPrompt, [workerPreamble(true, hasCharter)], type ?? "untyped");
      const assembled = appendSystemPrompt?.[0];
      assert.equal(typeof assembled === "string" && assembled.includes(REVIEWER_CHARTER), hasCharter, type ?? "untyped");
      assert.equal(typeof assembled === "string" && assembled.includes(PARALLEL_TOOL_RULE), true, type ?? "untyped");
    }
    assert.equal(opened.length, cases.length);
    assert.deepEqual(reports, []);
  } finally {
    codingAgentStub.createAgentSession = originalCreateAgentSession;
    rmSync(root, { recursive: true, force: true });
  }
});


test("public dispatch delivers selected guidance to the worker loader and leaves manual reviews alone", { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-selected-review-test."));
  const optionsSeen: Array<Record<string, unknown>> = [];
  const common = readFileSync(REVIEW_COMMON_POLICY_DOC, "utf8").trim()
    .replaceAll("<installed-writing-checker>", WRITING_CHECKER)
    .replaceAll("<installed-writing-guidance>", WRITING_GUIDANCE_DOC);
  const input = readFileSync(REVIEW_IMPLEMENTATION_INPUT_DOC, "utf8").trim();
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [
    { model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] },
  ] } } } });
  const admittedRuntime = Object.freeze({ ...runtime, validateRoute: async () => ({ ok: true } as const) });
  const ctx = { cwd: root, model: undefined, isProjectTrusted: () => true, modelRegistry: {
    find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id } : undefined,
    getRegisteredProviderIds: () => [], getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => undefined,
  } } as unknown as ExtensionContext;
  try {
    for (const selected of [["Reviewer I"], ["Consumer contract break reviewer", "Non-local logic defect reviewer"], undefined] as const) {
      const abort = new AbortController();
      const openingBefore = optionsSeen.length;
      codingAgentStub.createAgentSession = async (options) => {
        optionsSeen.push(options);
        // Stop after the real loader was built. No provider or compressor is needed.
        abort.abort();
        return { session: {
          messages: [], model: undefined, thinkingLevel: "medium", modelRuntime: { getRegisteredProviderIds: () => [] },
          agent: { state: { tools: [] }, streamFunction: async () => ({}) },
          subscribe: () => () => {}, async abort() {}, async waitForIdle() {},
          async bindExtensions() {}, extensionRunner: { async emit() {} }, dispose() {},
        } as unknown as WorkerSession };
      };
      const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
      const manager = new ThreadManager(store, {}, undefined, admittedRuntime, undefined, {},
        selected === undefined ? () => { throw new Error("manual review read an automatic policy file"); } : undefined);
      await assert.rejects(manager.dispatch({
        task: "review this range", type: "reviewer", model: "fixture", reason: "review",
        ...(selected === undefined ? {} : { reviewPerspectives: [...selected] }),
      }, ctx, abort.signal), /cancelled by the caller/);
      assert.equal(optionsSeen.length, openingBefore + 1);
      const loader = optionsSeen.at(-1)?.resourceLoader as { options?: { appendSystemPrompt?: string[] } } | undefined;
      const blocks = loader?.options?.appendSystemPrompt;
      const expected = selected === undefined ? undefined : [common, input, ...selected.map((name) =>
        readFileSync(REVIEW_PERSPECTIVES.find((role) => role.name === name)!.file, "utf8").trim(),
      )].join("\n\n");
      assert.deepEqual(blocks, expected === undefined ? [workerPreamble(true, true)] : [workerPreamble(true, true), expected]);
      assert.equal((blocks?.[0]?.split(REVIEWER_CHARTER).length ?? 0) - 1, 1);
      if (selected !== undefined && expected !== undefined) {
        assert.equal(expected.split(common).length - 1, 1);
        assert.equal(expected.split(input).length - 1, 1);
        for (const name of selected) {
          const charter = readFileSync(REVIEW_PERSPECTIVES.find((role) => role.name === name)!.file, "utf8").trim();
          assert.equal(expected.split(charter).length - 1, 1);
        }
      }
      assert.equal(store.episodes.size, 0);
    }
  } finally {
    codingAgentStub.createAgentSession = originalCreateAgentSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker assembly restores the shared SDK session stub", () => {
  assert.strictEqual(codingAgentStub.createAgentSession, originalCreateAgentSession);
});
