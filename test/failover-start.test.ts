import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBaseModelTracker } from "../extension/base-model.ts";
import { registerOrchestratorFailover, SAVED_DEFAULT_RESOURCE_KEY } from "../extension/failover.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";

for (const boundary of ["aborted", "paused", "replaced", "matched", "pre-send-paused"] as const) test(`continuation acknowledgement respects ${boundary}`, { timeout: 2000 }, async () => {
  const handlers = new Map<string, any>();
  const notices: string[] = [];
  const messages: any[] = [];
  let effort: any = "max";
  let paused = boundary === "pre-send-paused";
  let epoch = 0;
  const controller = new AbortController();
  const primary = { provider: "p1", id: "m1", reasoning: true, thinkingLevelMap: { max: "max" } };
  const fallback = { provider: "p2", id: "m2", reasoning: true, thinkingLevelMap: { max: "max" } };
  const ctx: any = { cwd: "/tmp", model: primary, hasUI: true, signal: controller.signal,
    ui: { notify: (text: string) => notices.push(text) },
    modelRegistry: { find: () => fallback, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) } };
  const pi = { on(name: string, fn: any) { handlers.set(name, fn); },
    getThinkingLevel: () => effort, setThinkingLevel(value: any) { effort = value; },
    setModel: async (model: any) => { ctx.model = model; return true; },
    sendMessage(message: any) { messages.push(message); } } as unknown as ExtensionAPI;
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { replace: [{
    model: "luna-6", preferredProvider: "p1", providers: { p1: "m1", p2: "m2" }
  }] } } } });
  const base = createBaseModelTracker({ warn() {} });
  base.seed(primary, "max");
  const recovery = registerOrchestratorFailover(pi, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime,
    () => ({ enabled: true, maxRetries: 0, baseDelayMs: 0 }), () => epoch, undefined, () => paused);
  await handlers.get("turn_end")({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary timeout" } }, ctx);
  await handlers.get("agent_settled")({}, ctx);
  if (boundary === "pre-send-paused") {
    assert.equal(messages.length, 0);
    assert.match(notices.join("\n"), /recovery stopped.*\/slate resume, then ask to continue/);
    assert.equal(recovery.recovering(), false);
    const lease = runtime.ownership.acquire("handoff", SAVED_DEFAULT_RESOURCE_KEY);
    assert.equal(lease.kind, "acquired", "recovery releases route ownership");
    if (lease.kind === "acquired") lease.lease.release();
    return;
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].display, false, "continuation instructions stay hidden");
  assert.equal(notices.length, 0, "sending is not acknowledgement");
  const message = { ...messages[0], role: "custom" };
  await handlers.get("message_start")({ message: { ...message, details: { attemptId: "wrong" } } }, ctx);
  assert.equal(notices.length, 0);
  if (boundary === "aborted") controller.abort();
  if (boundary === "paused") paused = true;
  if (boundary === "replaced") epoch++;
  await handlers.get("message_start")({ message }, ctx);
  await handlers.get("message_start")({ message }, ctx);
  assert.equal(notices.length, boundary === "matched" ? 1 : 0);
  assert.equal(recovery.recovering(), true, "acknowledgement alone never publishes success");
  assert.equal(Object.keys(runtime.rememberedSelections().providers ?? {}).length, 0);
});
