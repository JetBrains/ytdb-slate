import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSlateHandoff, type HandoffPurpose } from "../extension/handoff.ts";
import { SlateStore } from "../extension/state.ts";
import { createBaseModelTracker } from "../extension/base-model.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";

function fixture(manager = SessionManager.inMemory("/tmp"), allowed = true, shared = false, identity = true) {
  const handlers = new Map<string, any>();
  const messages: any[] = [];
  const warnings: string[] = [];
  let effort = "max";
  const model = { provider: "openai", id: "gpt-6-luna" };
  const pi = {
    on(name: string, fn: any) { handlers.set(name, fn); },
    appendEntry(name: string, data: any) { manager.appendCustomEntry(name, data); },
    getThinkingLevel: () => effort,
    setThinkingLevel(value: string) { effort = value; },
    setModel: async () => true,
    sendMessage(message: any) {
      messages.push(message);
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  store.orchestratorMode = true;
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: shared ? { router: { models: { add: [{ model: "shared-alias", capabilityRating: 45, costRating: 11, effort: "max", preferredProvider: "openai", providers: { openai: "gpt-6-luna" }, guidelines: [], cautions: [] }] } } } : undefined });
  const base = createBaseModelTracker({ warn() {} });
  base.seed(model, "max");
  if (identity) base.adoptLogicalIdentity("luna-6");
  const hooks = registerSlateHandoff(pi, store, () => ({ preserveGlobalModelDefault: false }), () => base, () => allowed ? runtime : undefined);
  const ctx: any = {
    cwd: "/tmp", model, hasUI: true, ui: { notify: (text: string) => warnings.push(text) },
    sessionManager: manager, isProjectTrusted: () => false,
    waitForIdle: async () => {}, modelRegistry: { find: () => model },
  };
  return { pi, store, hooks, ctx, handlers, manager, messages, warnings, runtime, base };
}

async function transfer(parent: ReturnType<typeof fixture>, options: { allowed?: boolean; reject?: boolean; failSave?: boolean; shared?: boolean } = {}, purpose?: HandoffPurpose) {
  const child = fixture(undefined, options.allowed ?? true, options.shared);
  let turns = 0;
  parent.ctx.newSession = async (request: any) => {
    await request.setup(child.manager);
    if (options.failSave) {
      let saves = 0;
      const original = child.pi.appendEntry;
      child.pi.appendEntry = (name, data) => {
        if (name === "slate-state" && ++saves === 2) throw new Error("unpause save failed");
        original(name, data);
      };
    }
    await child.handlers.get("session_start")({}, child.ctx);
    await request.withSession({
      ...child.ctx,
      sendMessage: async (message: any, delivery: any) => {
        if (options.reject && message.customType === "slate-kickoff") throw new Error("fresh send refused");
        child.pi.sendMessage(message);
        if (delivery?.triggerTurn) {
          assert.equal(child.store.paused, false);
          assert.equal(child.ctx.model.id, "gpt-6-luna");
          assert.equal(child.pi.getThinkingLevel(), "max");
          turns++;
        }
      },
    });
    return { cancelled: false };
  };
  await parent.hooks.startHandoff(parent.ctx, undefined, undefined, purpose);
  return { child, turns };
}

test("adoption gates the hidden kickoff and resume delivers it once across reload", { timeout: 2000 }, async () => {
  const { child, turns } = await transfer(fixture(), { allowed: false }, "track-boundary");
  assert.equal(turns, 0);
  assert.equal(child.messages.some((m) => m.customType === "slate-kickoff"), false);
  assert.match(child.warnings.join("\n"), /Choose a permitted model and effort, then run \/slate resume/);
  const resumed = fixture(child.manager);
  resumed.store.restore(resumed.ctx);
  assert.equal(resumed.store.paused, true);
  assert.equal(await resumed.hooks.resume!(resumed.ctx), true);
  const kickoff = resumed.messages.filter((m) => m.customType === "slate-kickoff");
  assert.equal(kickoff.length, 1);
  assert.equal(kickoff[0].display, false);
  assert.match(kickoff[0].content, /track-boundary/);
  const reloaded = fixture(child.manager);
  reloaded.store.restore(reloaded.ctx);
  await reloaded.hooks.resume!(reloaded.ctx);
  assert.equal(reloaded.messages.some((m) => m.customType === "slate-kickoff"), false);
});

test("successful adoption starts exactly one hidden kickoff and consumes the inherited purpose", { timeout: 2000 }, async () => {
  const { child, turns } = await transfer(fixture(), {}, "track-boundary");
  assert.equal(turns, 1);
  const first = child.messages.find((m) => m.customType === "slate-kickoff");
  assert.equal(first.display, false);
  const claims = child.messages.filter((m) => m.customType === "slate-kickoff-claimed");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].display, false);
  assert.match(first.content, /track-boundary/);
  const next = await transfer(child);
  assert.equal(next.turns, 1);
  const second = next.child.messages.find((m) => m.customType === "slate-kickoff");
  assert.match(second.content, /user-request/);
  assert.doesNotMatch(second.content, /track-boundary|reached its context budget/);
});

for (const interrupted of ["cancel", "idle-failure", "transfer-failure"] as const) test(`${interrupted} and restart retain only the same boundary purpose for retry`, { timeout: 2000 }, async () => {
  const parent = fixture();
  parent.ctx.newSession = async () => { if (interrupted === "transfer-failure") throw new Error("transfer failed"); return { cancelled: true }; };
  parent.ctx.waitForIdle = async () => { if (interrupted === "idle-failure") throw new Error("idle failed"); };
  if (interrupted === "cancel") await parent.hooks.startHandoff(parent.ctx, undefined, undefined, "post-check");
  else await assert.rejects(parent.hooks.startHandoff(parent.ctx, undefined, undefined, "post-check"), /failed/);
  const restarted = fixture(parent.manager);
  restarted.store.restore(restarted.ctx);
  const { child } = await transfer(restarted);
  assert.match(child.messages.find((m) => m.customType === "slate-kickoff").content, /post-check/);
});

test("a budget pause and boundary purpose both appear without changing old state causes", { timeout: 2000 }, async () => {
  const parent = fixture();
  parent.store.paused = true;
  parent.store.pauseReason = "context-budget";
  const result = await transfer(parent, {}, "track-boundary");
  const text = result.child.messages.find((m) => m.customType === "slate-kickoff").content;
  assert.match(text, /track-boundary/);
  assert.match(text, /reached its context budget/);
  const old = fixture();
  const snapshot = old.store.snapshot();
  delete snapshot.pauseReason;
  old.store.adoptSnapshot(snapshot, old.ctx);
  assert.equal(old.store.pauseReason, undefined);
  const plain = await transfer(old);
  assert.doesNotMatch(plain.child.messages.find((m) => m.customType === "slate-kickoff").content, /reached its context budget/);
});

test("failed unpause save retains the kickoff and cannot duplicate it after reload", { timeout: 2000 }, async () => {
  const { child, turns } = await transfer(fixture(), { failSave: true });
  assert.equal(turns, 0);
  const resumed = fixture(child.manager);
  resumed.store.restore(resumed.ctx);
  assert.equal(resumed.store.paused, true);
  await resumed.hooks.resume!(resumed.ctx);
  await resumed.hooks.resume!(resumed.ctx);
  assert.equal(resumed.messages.filter((m) => m.customType === "slate-kickoff").length, 1);
});

test("shared-route adoption and failed unpause save resume with the trusted identity exactly once", { timeout: 2000 }, async () => {
  const { child, turns } = await transfer(fixture(), { shared: true, failSave: true });
  assert.equal(turns, 0);
  assert.equal(child.store.paused, true);
  assert.equal(child.base.currentLogicalIdentity(), "luna-6");
  assert.equal(await child.hooks.resume!(child.ctx), true);
  assert.equal(await child.hooks.resume!(child.ctx), true);
  assert.equal(child.messages.filter((m) => m.customType === "slate-kickoff").length, 1);
});

for (const invalid of ["runtime", "model", "unmapped", "ambiguous", "effort"] as const) test(`adoption resume refuses invalid ${invalid} without claiming the pending kickoff`, { timeout: 2000 }, async () => {
  const { child } = await transfer(fixture(), { allowed: false });
  const resumed = fixture(child.manager, invalid !== "runtime", invalid === "ambiguous", invalid !== "ambiguous");
  resumed.store.restore(resumed.ctx);
  if (invalid === "model") resumed.ctx.model = undefined;
  if (invalid === "unmapped") resumed.ctx.model = { provider: "unknown", id: "unknown" };
  if (invalid === "effort") resumed.pi.setThinkingLevel("low");
  assert.equal(await resumed.hooks.resume!(resumed.ctx), false);
  assert.equal(resumed.store.paused, true);
  assert.equal(resumed.store.pauseReason, "adoption");
  const durable = fixture(child.manager);
  durable.store.restore(durable.ctx);
  assert.equal(durable.store.paused, true);
  assert.match(resumed.warnings.join("\n"), /Choose a permitted model and effort, then run \/slate resume/);
  assert.equal(resumed.messages.length, 0);
  assert.equal(child.manager.getBranch().some((e) => e.type === "custom_message" && e.customType === "slate-kickoff-claimed"), false);
  assert.equal(await durable.hooks.resume!(durable.ctx), true);
  assert.equal(durable.messages.filter((m) => m.customType === "slate-kickoff").length, 1);
});

test("budget and unpaused resume accept unmapped models without a runtime", { timeout: 2000 }, async () => {
  const parent = fixture(undefined, false);
  parent.ctx.model = { provider: "custom", id: "custom" };
  parent.store.paused = true;
  parent.store.pauseReason = "context-budget";
  assert.equal(await parent.hooks.resume!(parent.ctx), true);
  assert.equal(parent.store.paused, false);
  assert.equal(parent.store.pauseReason, undefined);
  assert.equal(await parent.hooks.resume!(parent.ctx), true);
});

test("resume save failure restores the durable adoption pause and sends nothing", { timeout: 2000 }, async () => {
  const { child } = await transfer(fixture(), { allowed: false });
  const resumed = fixture(child.manager);
  resumed.store.restore(resumed.ctx);
  resumed.store.save = () => { throw new Error("resume save refused"); };
  assert.equal(await resumed.hooks.resume!(resumed.ctx), false);
  assert.equal(resumed.store.paused, true);
  assert.equal(resumed.store.pauseReason, "adoption");
  assert.match(resumed.warnings.join("\n"), /could not save.*resume save refused.*\/slate resume to retry/);
  assert.equal(resumed.messages.length, 0);
  const durable = fixture(child.manager);
  durable.store.restore(durable.ctx);
  assert.equal(durable.store.paused, true);
  assert.equal(await durable.hooks.resume!(durable.ctx), true);
  assert.equal(durable.messages.filter((m) => m.customType === "slate-kickoff").length, 1);
});

test("revisiting a successfully transferred parent does not reuse its purpose", { timeout: 2000 }, async () => {
  const parent = fixture();
  await transfer(parent, {}, "track-boundary");
  const revisited = fixture(parent.manager);
  const { child } = await transfer(revisited);
  const text = child.messages.find((m) => m.customType === "slate-kickoff").content;
  assert.match(text, /user-request/);
  assert.doesNotMatch(text, /track-boundary/);
});

for (const failed of [false, true]) test(`budget pause cleared by ${failed ? "failure" : "cancel"} leaves no later budget cause`, { timeout: 2000 }, async () => {
  const parent = fixture();
  parent.store.paused = true;
  parent.store.pauseReason = "context-budget";
  parent.ctx.newSession = async () => { if (failed) throw new Error("replacement failed"); return { cancelled: true }; };
  if (failed) await assert.rejects(parent.hooks.startHandoff(parent.ctx), /replacement failed/);
  else await parent.hooks.startHandoff(parent.ctx);
  assert.equal(parent.store.paused, false);
  assert.equal(parent.store.pauseReason, undefined);
  const { child } = await transfer(parent);
  assert.doesNotMatch(child.messages.find((m) => m.customType === "slate-kickoff").content, /reached its context budget/);
});

test("fresh kickoff rejection reports through the fresh context and never replays", { timeout: 2000 }, async () => {
  const parent = fixture();
  const { child, turns } = await transfer(parent, { reject: true });
  assert.equal(turns, 0);
  assert.match(child.warnings.join("\n"), /kickoff failed:.*fresh send refused/);
  assert.doesNotMatch(parent.warnings.join("\n"), /kickoff failed/);
  const reloaded = fixture(child.manager);
  reloaded.store.restore(reloaded.ctx);
  await reloaded.hooks.resume!(reloaded.ctx);
  assert.equal(reloaded.messages.some((m) => m.customType === "slate-kickoff"), false);
});
