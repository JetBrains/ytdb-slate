import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCorpusProject } from "../extension/corpus.ts";
import { activateSlateStorage, createRuntimeAuthorityBackend } from "../extension/runtime-authority.ts";
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

function storeHarness(): { store: SlateStore } {
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.artifactSessionName = () => undefined;
  store.commit = () => ({ kind: "committed", binding: { policy: "durable-session-v1", identity: "20260820T010203Z-0123456789abcdef", name: "calm-otter-7f3a" } });
  return { store };
}

/**
 * THE PRODUCTION STORE over a real external namespace, with no stubbed save.
 *
 * The two tests below claim that a new record PERSISTS. A stubbed save cannot
 * support that claim: it returns success, stores nothing, and stays green when
 * the production save path breaks (TQ1505). These tests therefore read the
 * stored file back.
 */
function durableHarness(t: TestContext): { store: SlateStore; stored: () => Record<string, unknown> } {
  const root = mkdtempSync(join(tmpdir(), "slate-thread-type."));
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agent);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const project = resolveCorpusProject(cwd);
  const entries: Array<{ type: "custom"; customType: string; data: Record<string, unknown> }> = [];
  const pi = {
    appendEntry(customType: string, data: Record<string, unknown>) {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  activateSlateStorage({
    store,
    session: {
      key: "pi-session:thread-type",
      cwd,
      sessionDigest: "a".repeat(64),
      project,
      entries,
      branch: entries,
    },
    backend: createRuntimeAuthorityBackend(pi, { branch: () => entries }),
    report: () => {},
  });
  const stored = () => {
    const name = store.slateSessionName;
    assert.ok(name);
    return (JSON.parse(readFileSync(join(project.directory, name, "state.json"), "utf8")) as { runtime: Record<string, unknown> }).runtime;
  };
  return { store, stored };
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

test("new records persist every valid type", (t) => {
  const { store, stored } = durableHarness(t);
  const manager = new ThreadManager(store, {});
  const view = internals(manager);

  for (const type of THREAD_TYPES) {
    const created = view.createThread({ task: "x", type }, {});
    assert.equal(created.type, type);
    assert.equal(store.threads.get(created.id)?.type, type);
    // The stored file, not the in-memory map, is the persistence claim.
    const threads = stored().threads as ThreadRecord[];
    assert.equal(threads.find((thread) => thread.id === created.id)?.type, type);
  }
  assert.equal((stored().threads as ThreadRecord[]).length, THREAD_TYPES.length);
});


test("public dispatch creates and persists every thread type", async (t) => {
  const { store, stored } = durableHarness(t);
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
    // The accepted save keeps the identity of the record the dispatch holds, so a
    // later change of that record still reaches the store (BG1501/CN1501).
    assert.strictEqual(store.threads.get(result.id), result);
    const threads = stored().threads as ThreadRecord[];
    assert.equal(threads.find((thread) => thread.id === result.id)?.name, `fresh-${type}`);
  }
});
