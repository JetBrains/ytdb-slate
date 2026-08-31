import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "../verification/test-hooks.mjs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const codingAgentModule = await import("@earendil-works/pi-coding-agent") as unknown as {
  codingAgentStub: {
    createAgentSession(options: Record<string, unknown>): Promise<{ session: unknown }>;
  };
};
const { codingAgentStub } = codingAgentModule;
const originalCreateAgentSession = codingAgentStub.createAgentSession;
const { ThreadManager } = await import("../extension/threads.ts");
const { SlateStore, THREAD_TYPES } = await import("../extension/state.ts");

function session(counter: { disposed: number }) {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const messages: unknown[] = [];
  return {
    messages,
    model: undefined,
    thinkingLevel: "medium",
    sessionFile: undefined,
    subscribe(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      messages.push({ role: "user", content: text });
      const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
      messages.push(message);
      for (const listener of listeners) listener({ type: "message_end", message });
    },
    async abort() {},
    dispose() { counter.disposed++; },
    async setModel() {},
    setThinkingLevel() {},
    getContextUsage() { return undefined; },
  };
}

test("each completed action opens and disposes a distinct real worker session", { timeout: 2000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "slate-session-lifetime-"));
  const opened: unknown[] = [];
  const counter = { disposed: 0 };
  codingAgentStub.createAgentSession = async () => {
    const created = session(counter);
    opened.push(created);
    return { session: created };
  };
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  const manager = new ThreadManager(store, { cacheKeyEnabled: false });
  const ctx = {
    cwd,
    model: undefined,
    hasUI: false,
    isProjectTrusted: () => true,
    modelRegistry: { find() { return undefined; }, hasConfiguredAuth() { return false; }, async getAvailable() { return []; } },
  } as unknown as ExtensionContext;
  try {
    for (const type of THREAD_TYPES) {
      const before = opened.length;
      await manager.dispatch({ type, task: `${type} first` }, ctx, undefined);
      await manager.dispatch({ type, task: `${type} second` }, ctx, undefined);
      assert.notStrictEqual(opened[before], opened[before + 1], `${type} actions must not reuse a session`);
    }
    assert.equal(opened.length, THREAD_TYPES.length * 2);
    assert.equal(new Set(opened).size, opened.length);
    assert.equal(counter.disposed, opened.length);
    assert.equal((manager as unknown as { live: Map<string, unknown> }).live.size, 0);
  } finally {
    codingAgentStub.createAgentSession = originalCreateAgentSession;
    rmSync(cwd, { recursive: true, force: true });
  }
});
