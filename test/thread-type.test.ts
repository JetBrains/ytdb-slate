import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SlateStore, THREAD_TYPES, type ThreadRecord } from "../extension/state.ts";
import { ThreadManager, type DispatchOptions } from "../extension/threads.ts";
import { registerSlateTools } from "../extension/tools.ts";

interface ManagerInternals {
  createThread(opts: DispatchOptions, plan: unknown): ThreadRecord;
  runDispatch: (...args: unknown[]) => Promise<unknown>;
}

function internals(manager: ThreadManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function record(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "t1",
    name: "legacy",
    type: "general",
    status: "cancelled",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function storeHarness(): { store: SlateStore; snapshots: Record<string, unknown>[] } {
  const snapshots: Record<string, unknown>[] = [];
  const pi = {
    appendEntry(_customType: string, data: Record<string, unknown>) {
      snapshots.push(data);
    },
  } as unknown as ExtensionAPI;
  return { store: new SlateStore(pi), snapshots };
}

interface RegisteredThreadTool {
  description: string;
  parameters: {
    properties: {
      type: { description: string };
    };
  };
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

function registeredThreadTool(status: "ok" | "failed" = "ok"): { tool: RegisteredThreadTool; calls: DispatchOptions[] } {
  let registered: unknown;
  const pi = {
    registerTool(tool: unknown) {
      const candidate = tool as { name?: string };
      if (candidate.name === "thread") registered = tool;
    },
  } as unknown as ExtensionAPI;
  const calls: DispatchOptions[] = [];
  const manager = {
    async dispatch(opts: DispatchOptions) {
      calls.push(opts);
      const thread = record({ type: opts.type });
      return {
        thread,
        episode: { id: "t1.e1", threadId: "t1", task: opts.task, status, file: "/tmp/e", createdAt: 1 },
        episodeText: "episode",
        warnings: [],
        usage: { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 },
      };
    },
  } as unknown as ThreadManager;
  registerSlateTools(pi, storeHarness().store, () => manager);
  assert.ok(registered);
  return { tool: registered as RegisteredThreadTool, calls };
}

const ctx = {} as ExtensionContext;

test("thread tool enforces the creation type and publishes the closed vocabulary", async () => {
  const { tool, calls } = registeredThreadTool();
  const allowed = "researcher, reviewer, adversarial, implementer, general";
  assert.match(tool.description, /See the `type` parameter for the thread-type choices and their meanings\./);
  assert.doesNotMatch(tool.description, /researcher, reviewer, adversarial, implementer/);
  assert.equal(
    tool.parameters.properties.type.description,
    "Required. Pick by main job: researcher investigates, reviewer judges work, adversarial seeks counterexamples, implementer makes the change, general is anything else. Slate adds its reviewer evidence charter to reviewer and adversarial threads.",
  );
  const descriptionBytes = Buffer.byteLength(tool.description, "utf8");
  const parameterSchemaBytes = Buffer.byteLength(JSON.stringify(tool.parameters), "utf8");
  assert.equal(descriptionBytes, 1_062, "thread description byte budget changed; update docs/context-budget.md in the same commit");
  assert.equal(parameterSchemaBytes, 1_246, "thread parameter schema byte budget changed; update docs/context-budget.md in the same commit");
  assert.equal(
    descriptionBytes + parameterSchemaBytes,
    2_308,
    "thread combined byte budget changed; update docs/context-budget.md in the same commit",
  );

  await assert.rejects(
    tool.execute("missing", { task: "x" }, undefined, undefined, ctx),
    new RegExp(`type is required.*Allowed values: ${allowed}`, "i"),
  );
  await assert.rejects(
    tool.execute("invalid", { task: "x", type: "observer" }, undefined, undefined, ctx),
    new RegExp(`Invalid thread type.*Allowed values: ${allowed}`, "i"),
  );

  for (const type of THREAD_TYPES) {
    await tool.execute(type, { task: `create ${type}`, type }, undefined, undefined, ctx);
  }
  assert.deepEqual(calls.map((call) => call.type), [...THREAD_TYPES]);
});

test("thread tool returns a failed episode with failed status", async () => {
  const { tool } = registeredThreadTool("failed");
  const result = await tool.execute("failed", { task: "x", type: "general" }, undefined, undefined, ctx) as {
    content: Array<{ text: string }>;
    details: { status: string; episodeId: string };
  };
  assert.match(result.content[0]?.text ?? "", /STATUS: FAILED/);
  assert.match(result.content[0]?.text ?? "", /episode/);
  assert.equal(result.details.status, "failed");
  assert.equal(result.details.episodeId, "t1.e1");
});

test("new records persist every valid type", () => {
  const { store } = storeHarness();
  const manager = new ThreadManager(store, {});
  const view = internals(manager);

  for (const type of THREAD_TYPES) {
    const created = view.createThread({ task: "x", type }, {});
    assert.equal(created.type, type);
    assert.equal(store.threads.get(created.id)?.type, type);
  }
});


test("public dispatch creates and persists every thread type", async () => {
  const { store } = storeHarness();
  const manager = new ThreadManager(store, {});
  const view = internals(manager);
  view.runDispatch = async (thread: unknown) => thread;

  for (const type of THREAD_TYPES) {
    const result = await manager.dispatch(
      { name: `fresh-${type}`, task: "x", type },
      {} as ExtensionContext,
      undefined,
    ) as unknown as ThreadRecord;
    assert.equal(result.name, `fresh-${type}`);
    assert.equal(result.type, type);
    assert.strictEqual(store.threads.get(result.id), result);
  }
});
