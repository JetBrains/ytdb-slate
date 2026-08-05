import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SlateStore } from "../extension/state.ts";
import { ThreadManager, type DispatchProgress } from "../extension/threads.ts";

const compat = await import("@earendil-works/pi-ai/compat") as unknown as {
  piAiCompatStub: { complete: () => Promise<unknown> };
};
compat.piAiCompatStub.complete = async () => ({
  stopReason: "stop",
  content: [{ type: "text", text: "compressed" }],
  usage: { cost: { total: 0.75 } },
});

const root = mkdtempSync(join(tmpdir(), "slate-episode-persistence-probe."));
try {
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
    if (thread?.status === "idle" && thread.episodeSeq === 1 && store.episodes.size === 0) recoverySaves++;
    originalSave();
  };

  const manager = new ThreadManager(store, { episodeModel: "anthropic/claude-sonnet-5" });
  const messages: unknown[] = [];
  const subscribers = new Set<(event: unknown) => void>();
  const session = {
    messages,
    model: undefined,
    thinkingLevel: undefined,
    sessionFile,
    getContextUsage: () => undefined,
    subscribe: (listener: (event: unknown) => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    prompt: async () => {
      const message = {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "No findings." }],
        usage: { cost: { total: 1.25 } },
      };
      messages.push(message);
      for (const listener of subscribers) listener({ type: "message_end", message });
    },
  };
  const view = manager as unknown as {
    live: Map<string, unknown>;
    openWorkerFor(): Promise<{ session: unknown; baseline: unknown }>;
  };
  view.openWorkerFor = async () => {
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
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      getAvailable: async () => [model],
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
  } as unknown as ExtensionContext;

  await assert.rejects(
    manager.dispatch(
      { name: "review", type: "reviewer", task: "review" },
      ctx,
      undefined,
      (update) => progress.push(update),
    ),
    (error: unknown) => {
      assert.equal(String(error), "Error: slate could not store episode t1.e1.");
      assert.equal(String(error).includes(root), false);
      assert.doesNotMatch(String(error), /directory|regular|symbolic|E[A-Z]+/);
      return true;
    },
  );

  const thread = store.threads.get("t1");
  assert.equal(thread?.status, "idle");
  assert.equal(thread?.sessionFile, sessionFile);
  assert.equal(store.workerCostUsd, 2, "worker and compressor costs are each added once");
  assert.ok(saves >= 2, "dispatch state is saved");
  assert.equal(recoverySaves, 1, "episode-persistence recovery is saved exactly once");
  assert.equal(store.episodes.size, 0);
  assert.equal(existsSync(join(root, ".pi", "slate", "observations", "t1.e1.md")), false);
  assert.equal(progress.filter((update) => update.done).length, 1);
  assert.equal(progress.find((update) => update.done)?.status, "failed");
  assert.equal(progress.find((update) => update.done)?.lines.at(-1), "✗ slate could not store episode t1.e1.");
  process.stdout.write("episode-persistence-probe: PASS\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
