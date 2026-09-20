const TEST_ROUTE = { model: "fixture", reason: "test fixture" } as const;

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SlateStore } from "../extension/state.ts";
import { ThreadManager, type DispatchProgress } from "../extension/threads.ts";
import { bindFakeWorkerRequest } from "./worker-request-contract-fixture.ts";

const root = process.env.SLATE_PROBE_ROOT;
const observationMode = process.env.SLATE_OBSERVATION_MODE;
if (!root) throw new Error("SLATE_PROBE_ROOT is required");
if (observationMode !== "retained" && observationMode !== "removed") throw new Error("SLATE_OBSERVATION_MODE must be retained or removed");
mkdirSync(root, { recursive: true });

const compat = await import("@earendil-works/pi-ai/compat") as unknown as {
  piAiCompatStub: { complete: () => Promise<unknown> };
};
compat.piAiCompatStub.complete = async () => {
  if (observationMode === "removed") {
    const observations = join(root, ".pi", "slate", "observations");
    rmSync(observations, { recursive: true, force: true });
    writeFileSync(observations, "compression fixture replaced this directory");
  }
  return {
    stopReason: "stop",
    content: [{ type: "text", text: "compressed" }],
    usage: { cost: { total: 0.75 } },
  };
};

mkdirSync(join(root, ".pi", "slate", "episodes", "t1.e1.md"), { recursive: true });
const sessionFile = join(root, "worker.jsonl");
writeFileSync(sessionFile, "session");

const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
let saves = 0;
let recoverySaves = 0;
const originalSave = store.save.bind(store);
store.save = () => {
  saves++;
  const thread = store.threads.get("t1");
  if (thread?.status === "failed" && store.episodes.size === 0) recoverySaves++;
  originalSave();
};

const logicalRuntime = createLogicalRuntime({ trusted: true, projectConfig: { router: {
  models: { include: [], add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }], replace: [{ model: "claude-sonnet-5", preferredProvider: "anthropic", providers: { anthropic: "claude-sonnet-5" } }] },
  compressor: { models: [{ model: "claude-sonnet-5", effort: "medium" }] },
} } });
const manager = new ThreadManager(store, {}, undefined, Object.freeze({ ...logicalRuntime, validateRoute: async () => ({ ok: true } as const) }), { enabled: false, maxRetries: 0, baseDelayMs: 0 });
const messages: unknown[] = [];
const subscribers = new Set<(event: unknown) => void>();
const session = {
  messages,
  model: { provider: "test", id: "worker" },
  thinkingLevel: "off",
  sessionFile,
  getContextUsage: () => undefined,
  setThinkingLevel(level: string) { session.thinkingLevel = level; },
  subscribe: (listener: (event: unknown) => void) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
  prompt: async () => {
    const compaction = {
      type: "compaction_end",
      result: { usage: { input: 3, output: 2, cost: { total: 0.5 } } },
    };
    for (const listener of subscribers) listener(compaction);
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "service unavailable",
      content: [{ type: "text", text: "Partial findings." }],
      usage: { cost: { total: 1.25 } },
    };
    messages.push(message);
    for (const listener of subscribers) {
      listener({ type: "agent_end", willRetry: true });
      listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, errorMessage: "service unavailable" });
      listener({ type: "agent_end", willRetry: false });
      listener({ type: "auto_retry_end", success: false, attempt: 1 });
      listener({ type: "message_end", message });
    }
  },
};
const view = manager as unknown as {
  live: Map<string, unknown>;
  openWorkerFor(args: { requestContract: import("../extension/worker.ts").WorkerRequestContract }): Promise<{ session: unknown; baseline: unknown }>;
};
view.openWorkerFor = async ({ requestContract }) => {
  bindFakeWorkerRequest(session, requestContract);
  view.live.set("t1", session);
  return { session, baseline: {} };
};

const model = {
  provider: "anthropic",
  id: "claude-sonnet-5",
  api: "stub",
  contextWindow: 200_000,
  maxTokens: 8_192,
};
const progress: DispatchProgress[] = [];
const ctx = {
  cwd: root,
  hasUI: false,
  modelRegistry: {
    find: (provider: string, id: string) => provider === "test" && id === "worker" ? { provider, id } : provider === model.provider && id === model.id ? model : undefined,
    hasConfiguredAuth: () => true,
    getAvailable: async () => [model],
    getApiKeyAndHeaders: async () => ({ ok: true }),
  },
} as unknown as ExtensionContext;

await assert.rejects(
  manager.dispatch(
    { ...TEST_ROUTE, name: "review", type: "reviewer", task: "review" },
    ctx,
    undefined,
    (update) => progress.push(update),
  ),
  (error: unknown) => {
    assert.equal(
      String(error),
      "Error: Thread t1 failed: all permitted logical recovery routes were exhausted. Slate could not store episode t1.e1: slate refused an artifact file because that path is not a regular file.",
    );
    assert.match(String(error), /all permitted logical recovery routes were exhausted/);
    assert.match(String(error), /not a regular file/);
    assert.equal(String(error).includes(root), false);
    return true;
  },
);

const thread = store.threads.get("t1");
assert.equal(thread?.status, "failed");
assert.equal(thread?.episodeId, undefined);
assert.equal(store.workerCostUsd, 2.5, "worker, compressor, and compaction costs are each added once");
assert.ok(saves >= 2, "dispatch state is saved");
assert.equal(recoverySaves, 1, "episode-persistence recovery is saved exactly once");
assert.equal(store.episodes.size, 0);
const observationRetained = observationMode === "retained";
assert.equal(
  existsSync(join(root, ".pi", "slate", "observations", "t1.e1.md")),
  observationRetained,
  observationRetained
    ? "the observation remains after episode persistence fails"
    : "the external-removal fixture removes the observation",

);
const observationsParent = lstatSync(join(root, ".pi", "slate", "observations"));
assert.equal(observationsParent.isDirectory(), observationRetained, "the selected observation fixture has the expected final shape");
assert.equal(progress.filter((update) => update.done).length, 1);
assert.equal(progress.find((update) => update.done)?.status, "failed");
assert.equal(progress.find((update) => update.done)?.lines.at(-1), "✗ slate could not store episode t1.e1.");
process.stdout.write(`episode-persistence-probe: ${observationMode} PASS\n`);
