import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "../verification/test-hooks.mjs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { THREAD_TYPES, type ThreadRecord, type ThreadType } from "../extension/state.ts";
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

test("workerPreamble gates writing guidance on trust and composes reviewer guidance independently", () => {
  const untrusted = workerPreamble(false, false);
  const trusted = workerPreamble(true, false);
  const untrustedReviewer = workerPreamble(false, true);
  const trustedReviewer = workerPreamble(true, true);

  assert.equal(untrusted, WORKER_PREAMBLE);
  assert.equal(trusted, `${WORKER_PREAMBLE} ${WORKER_WRITING_GUIDANCE}`);
  assert.equal(untrustedReviewer, `${WORKER_PREAMBLE}\n${REVIEWER_CHARTER}`);
  assert.equal(trustedReviewer, `${WORKER_PREAMBLE} ${WORKER_WRITING_GUIDANCE}\n${REVIEWER_CHARTER}`);
  for (const preamble of [untrusted, trusted, untrustedReviewer, trustedReviewer]) {
    assert.equal(preamble.split(PARALLEL_TOOL_RULE).length - 1, 1);
  }
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
  const fakeSession = { model: undefined, thinkingLevel: "medium" } as unknown as WorkerSession;
  codingAgentStub.createAgentSession = async (options) => {
    opened.push(options);
    return { session: fakeSession };
  };
  const ctx = {
    cwd: root,
    model: undefined,
    isProjectTrusted: () => true,
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


test("worker assembly restores the shared SDK session stub", () => {
  assert.strictEqual(codingAgentStub.createAgentSession, originalCreateAgentSession);
});
