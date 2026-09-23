import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { getAgentDir, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBaseModelTracker } from "../extension/base-model.ts";
import { SAVED_DEFAULT_RESOURCE_KEY } from "../extension/failover.ts";
import { effectiveContextBudgetTokens, registerSlateHandoff } from "../extension/handoff.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SLATE_STATE_FORMAT, SlateStore } from "../extension/state.ts";

// TQ4: the budget fixture below reaches SettingsManager, which reads a settings
// file and takes a lock beside it. Without isolation that file is the
// developer's own ~/.pi/agent/settings.json, so the suite both reads global
// state and writes a lock directory into it. Every fixture therefore runs
// against a private agent directory, a private project directory and a private
// settings file created here.
const ISOLATED_RESERVE_TOKENS = 1234;
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const scratch = mkdtempSync(join(tmpdir(), "slate-handoff-test-"));
const agentDir = join(scratch, "agent");
const projectDir = join(scratch, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(projectDir, ".pi"), { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: ISOLATED_RESERVE_TOKENS } }));
writeFileSync(join(projectDir, ".pi", "settings.json"), "{}");

after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Run one fixture against the private agent directory. The variable is restored
 * in a finally block, so an assertion failure inside `run` cannot leak the
 * override into a later test.
 */
async function isolated<T>(run: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, AGENT_DIR_ENV);
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    return await run();
  } finally {
    if (had && previous !== undefined) process.env[AGENT_DIR_ENV] = previous;
    else delete process.env[AGENT_DIR_ENV];
  }
}

// Exact save contract, in order, shared by both delivery sites. The literal
// lives here and not in an import, so a production edit must be repeated here
// on purpose (TQ1/TQ5).
const SAVE_CONTRACT = [
  "Do not start other user work. Save the project state in the research log through exactly one worker at a time.",
  "Wait for that worker result and verify that it reports success before writing the final HANDOFF BRIEF.",
  "If preparation fails or is incomplete, report that fact instead of claiming that the state was saved.",
  "Reply with a concise HANDOFF BRIEF — overall goal, per-thread state with episode ids, immediate next actions.",
];

function assertPauseContract(content: string, headline: string): string[] {
  const lines = content.split("\n");
  assert.equal(lines[0], headline, "the headline must open the pause message");
  assert.deepEqual(lines.slice(1, 1 + SAVE_CONTRACT.length), SAVE_CONTRACT, "the save contract must follow the headline in order");
  assert.match(lines[1 + SAVE_CONTRACT.length] ?? "", /^Then instruct the user to run \/slate handoff \[optional focus]/);
  assert.match(lines[2 + SAVE_CONTRACT.length] ?? "", /^Alternatively, start a new pi session manually/);
  return lines;
}

function handoffEntry(sessionId: string, data: Record<string, unknown>) {
  return { type: "custom" as const, customType: "slate-handoff", data: { sessionId, ...data } };
}

function fixture(config: Record<string, unknown>, usage?: { percent: number; tokens: number | null; contextWindow: number }, model?: { provider: string; id: string }) {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  const hooks = registerSlateHandoff(pi, store, () => config as any, () => ({}) as any);
  const ctx = {
    cwd: projectDir,
    hasUI: false,
    isProjectTrusted: () => false,
    ...(model ? { model } : {}),
    getContextUsage: () => usage ?? { percent: 100, tokens: 10, contextWindow: 1000 },
  } as unknown as ExtensionContext;
  return { handlers, sent, store, ctx, hooks };
}

test("the pinned SDK resolves the agent directory at call time, so the fixture isolation holds", async () => {
  // slate calls getAgentDir() inside reserveTokens, and the pinned pi 0.83.0
  // reads process.env[PI_CODING_AGENT_DIR] inside that function. The value is
  // therefore never captured at import time, and the override above cannot
  // depend on when this module was loaded.
  const before = getAgentDir();
  const inside = await isolated(async () => getAgentDir());
  assert.equal(inside, agentDir);
  assert.equal(getAgentDir(), before, "the override must not survive the fixture");
});

test("budget pause instructions allow one verified state-save worker", async () => {
  await isolated(async () => {
    const f = fixture({ pauseThresholdPercent: 1 });
    await f.handlers.get("turn_end")!({}, f.ctx);
    assert.equal(f.store.paused, true);
    assert.equal(f.sent.length, 1);
    assertPauseContract(
      f.sent[0]!.message.content as string,
      "[slate] Context is at 100% — over the 1% budget. Slate auto-paused: user prompts are refused, and state-save workers remain available.",
    );
    assert.deepEqual(f.sent[0]!.options, { deliverAs: "steer", triggerTurn: true });
  });
});

test("the token-budget pause reports the same save contract in its headline", async () => {
  await isolated(async () => {
    const f = fixture(
      { contextBudget: { tokens: 100 } },
      { percent: 20, tokens: 200_000, contextWindow: 1_000_000 },
      { provider: "test-provider", id: "test-model" },
    );
    await f.handlers.get("turn_end")!({}, f.ctx);
    assert.equal(f.store.paused, true);
    assert.equal(f.sent.length, 1);
    assertPauseContract(
      f.sent[0]!.message.content as string,
      "[slate] Context is at 200,000 tokens — over the 100-token budget. Slate auto-paused: user prompts are refused, and state-save workers remain available.",
    );
  });
});

test("the clamped token budget reads the private settings file and names both numbers", async () => {
  await isolated(async () => {
    const contextWindow = 1_000_000;
    const configured = 999_000;
    const cap = effectiveContextBudgetTokens(configured, contextWindow, ISOLATED_RESERVE_TOKENS);
    assert.ok(cap < configured, "the fixture must engage the clamp");
    // The same call with pi's default reserve of 16,384 gives a different cap.
    // This assertion therefore fails if the isolation breaks and the real
    // settings file is read instead of the private one.
    assert.notEqual(cap, effectiveContextBudgetTokens(configured, contextWindow, 16_384));
    const f = fixture(
      { contextBudget: { tokens: configured } },
      { percent: 99, tokens: configured, contextWindow },
      { provider: "test-provider", id: "test-model" },
    );
    await f.handlers.get("turn_end")!({}, f.ctx);
    assert.equal(f.store.paused, true);
    assert.equal(f.sent.length, 1);
    assertPauseContract(
      f.sent[0]!.message.content as string,
      `[slate] Context is at 999,000 tokens — over the ${cap.toLocaleString("en-US")}-token budget (configured 999,000, clamped for this model's context window). Slate auto-paused: user prompts are refused, and state-save workers remain available.`,
    );
  });
});

test("every budget path resolves live model reserves with Pi precedence and unchanged bounds", { timeout: 5_000 }, async () => {
  await isolated(async () => {
    const globalFile = join(agentDir, "settings.json");
    const projectFile = join(projectDir, ".pi", "settings.json");
    const before = [readFileSync(globalFile, "utf8"), readFileSync(projectFile, "utf8")];
    const globalJson = JSON.stringify({ compaction: { reserveTokens: 20_000, modelOverrides: {
      "p/a": { reserveTokens: 100_000 }, "p/b": { reserveTokens: 60_000 },
      "p/zero": { reserveTokens: 0 }, "p/floor": { reserveTokens: 200_000 },
      "p/bad": { reserveTokens: -1 },
    } } });
    const projectJson = JSON.stringify({ compaction: { reserveTokens: 30_000, modelOverrides: {
      "p/a": { reserveTokens: 110_000 }, "p/b": { keepRecentTokens: 123 },
    } } });
    try {
      writeFileSync(globalFile, globalJson);
      writeFileSync(projectFile, projectJson);
      for (const trusted of [false, true]) {
        const usage = { percent: 90, tokens: 0, contextWindow: 272_000 };
        const f = fixture({ contextBudget: 256_000 }, usage);
        f.ctx.isProjectTrusted = () => trusted;
        assert.equal(f.hooks.effectiveContextBudget(usage.contextWindow, f.ctx), undefined);
        const cases = [
          ["p", "a", trusted ? 129_232 : 139_232], ["p", "b", 179_232],
          ["p", "unmatched", trusted ? 209_232 : 219_232], ["other", "a", trusted ? 209_232 : 219_232],
          ["p", "zero", 239_232], ["p", "floor", 136_000],
          ["p", "bad", 222_848], ["p", "a", trusted ? 129_232 : 139_232],
        ] as const;
        for (const [provider, id, rawExpected] of cases) {
          // The 110k reserve engages the existing half-window floor, not a new policy.
          const expected = Math.max(rawExpected, 136_000);
          f.ctx.model = { provider, id } as NonNullable<ExtensionContext["model"]>;
          assert.equal(f.hooks.effectiveContextBudget(usage.contextWindow, f.ctx), expected, `${trusted}/${provider}/${id}`);
          for (const event of ["turn_end", "agent_end"]) {
            f.store.paused = false;
            usage.tokens = expected - 1;
            await f.handlers.get(event)!({}, f.ctx);
            assert.equal(f.store.paused, false, `${event} must not pause below the live threshold`);
            usage.tokens = expected;
            await f.handlers.get(event)!({}, f.ctx);
            assert.equal(f.store.paused, true, `${event} must pause at the live threshold`);
            assert.match(f.sent.at(-1)!.message.content, new RegExp(`${expected.toLocaleString("en-US")}-token budget`));
          }
        }
      }
      assert.equal(readFileSync(globalFile, "utf8"), globalJson);
      assert.equal(readFileSync(projectFile, "utf8"), projectJson);
      for (const settings of [{}, { compaction: { reserveTokens: -1 } }]) {
        writeFileSync(globalFile, JSON.stringify(settings));
        const f = fixture({}, undefined, { provider: "p", id: "a" });
        assert.equal(f.hooks.effectiveContextBudget(272_000, f.ctx), 222_848, "absent or unreadable reserve keeps 16,384 fallback");
      }
    } finally {
      writeFileSync(globalFile, before[0]!);
      writeFileSync(projectFile, before[1]!);
    }
  });
});

test("budget settings snapshot reads once and retains the fallback after creation failure", { timeout: 5_000 }, async (t) => {
  await isolated(async () => {
    const create = t.mock.method(SettingsManager, "create", () => { throw new Error("reader unavailable"); });
    const f = fixture({}, undefined, { provider: "p", id: "a" });
    assert.equal(f.hooks.effectiveContextBudget(272_000, f.ctx), 222_848);
    f.ctx.model = { provider: "p", id: "b" } as NonNullable<ExtensionContext["model"]>;
    assert.equal(f.hooks.effectiveContextBudget(272_000, f.ctx), 222_848);
    assert.equal(create.mock.callCount(), 1, "a per-turn fallback must not repeat disk reads");
  });
});

test("handoff adoption keeps completed state while busy and unpauses only after allowed fixed effort", { timeout: 2_000 }, async () => {
  await isolated(async () => {
    const stateFile = join(projectDir, ".pi", "slate", "episodes", "t1.e1.md");
    mkdirSync(join(projectDir, ".pi", "slate", "episodes"), { recursive: true });
    writeFileSync(stateFile, "completed worker result");
    const snapshot = {
      format: SLATE_STATE_FORMAT,
      threads: [{ id: "t1", name: "done", status: "successful", type: "general", episodeId: "t1.e1", createdAt: 1, updatedAt: 1 }],
      episodes: [{ id: "t1.e1", threadId: "t1", task: "done", status: "ok", file: stateFile, createdAt: 1 }],
      orchestratorMode: true, paused: true, workerCostUsd: 0, carriedCostUsd: 0,
    };
    const run = async (busy: boolean) => {
      const runtime = createLogicalRuntime({ trusted: true });
      const base = createBaseModelTracker({ warn() {} });
      const target = { provider: "openai", id: "gpt-6-luna" };
      base.seed(target, "max"); base.adoptLogicalIdentity("luna-6");
      let thinking = busy ? "low" : "max";
      let modelSwitches = 0;
      let thinkingSwitches = 0;
      const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown>>();
      const pi = {
        on(event: string, handler: any) { handlers.set(event, handler); },
        getThinkingLevel() { return thinking; }, setThinkingLevel(level: string) { thinkingSwitches++; thinking = level; },
        async setModel() { modelSwitches++; return true; }, appendEntry() {},
      } as unknown as ExtensionAPI;
      const store = new SlateStore(pi);
      registerSlateHandoff(pi, store, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime);
      const entries = [handoffEntry("successor", { model: target, thinkingLevel: "low", logicalModel: "luna-6", snapshot })];
      const held = busy ? runtime.ownership.acquire("main", SAVED_DEFAULT_RESOURCE_KEY) : undefined;
      const ctx = {
        cwd: projectDir, hasUI: false, model: target, isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "successor", getBranch: () => entries },
        modelRegistry: { find: () => target },
      } as unknown as ExtensionContext;
      await handlers.get("session_start")!({}, ctx);
      assert.equal(store.episodes.get("t1.e1")?.file, stateFile, "completed worker result survives adoption");
      assert.equal(store.writingReminder.forceNext, true);
      assert.equal(modelSwitches, 0, "the equality guard does not perform a redundant model switch");
      if (busy) {
        assert.equal(store.paused, true);
        assert.equal(thinking, "low", "busy adoption performs no effort switch");
        if (held?.kind === "acquired") held.lease.release();
      } else {
        assert.equal(store.paused, false);
        assert.equal(thinking, "max");
        assert.equal(thinkingSwitches, 0, "the exact route and fixed effort no-op calls no Pi setter");
        assert.equal(base.currentLogicalIdentity(), "luna-6");
      }
    };
    await run(true);
    await run(false);
  });
});

test("handoff adoption reports persistence failures and preserves a safe pause boundary", { timeout: 2_000 }, async () => {
  await isolated(async () => {
    const snapshot = {
      format: SLATE_STATE_FORMAT, threads: [], episodes: [], orchestratorMode: true, paused: true,
      workerCostUsd: 0, carriedCostUsd: 0,
    };
    const target = { provider: "openai", id: "gpt-6-luna" };
    const run = async (failAt?: number) => {
      const cwd = join(projectDir, `persistence-${failAt ?? "success"}`);
      mkdirSync(join(cwd, ".pi", "slate"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
      const entries = [handoffEntry("successor", { model: target, logicalModel: "luna-6", snapshot })];
      const runtime = createLogicalRuntime({ trusted: true });
      const base = createBaseModelTracker({ warn() {} });
      let appends = 0;
      const durablePaused: boolean[] = [];
      const handlers = new Map<string, any>();
      const pi = {
        on(event: string, handler: any) { handlers.set(event, handler); },
        appendEntry(_type: string, state: Record<string, unknown>) {
          appends++;
          if (appends === failAt) throw new Error(`append ${appends} failed`);
          durablePaused.push(state.paused as boolean);
        },
        getThinkingLevel: () => "max",
        setThinkingLevel() { throw new Error("unexpected effort switch"); },
        async setModel() { throw new Error("unexpected model switch"); },
      } as unknown as ExtensionAPI;
      const store = new SlateStore(pi);
      registerSlateHandoff(pi, store, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime);
      const ctx = {
        cwd, hasUI: false, model: target, isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "successor", getBranch: () => entries },
        modelRegistry: { find: () => target },
      } as unknown as ExtensionContext;
      const warnings: string[] = [];
      const old = console.warn; console.warn = (value?: unknown) => warnings.push(String(value));
      try { await handlers.get("session_start")({}, ctx); } finally { console.warn = old; }
      return { appends, durablePaused, entries, paused: store.paused, warnings };
    };

    const first = await run(1);
    assert.equal(first.appends, 1);
    assert.deepEqual(first.durablePaused, []);
    assert.equal(first.paused, true);
    assert.equal(first.entries.length, 1, "a failed adoption commit leaves the entry available for retry");
    assert.match(first.warnings.join("\n"), /could not persist restored handoff state.*append 1 failed.*remains paused\. Reload can retry/s);

    const second = await run(2);
    assert.equal(second.appends, 2);
    assert.deepEqual(second.durablePaused, [true], "the durable adoption remains paused");
    assert.equal(second.paused, true, "failed unpause persistence restores the safe live pause");
    assert.equal(second.entries.length, 1, "adoption never deletes the successor entry");
    assert.match(second.warnings.join("\n"), /could not persist the unpaused handoff state.*append 2 failed.*remains paused/s);

    const success = await run();
    assert.equal(success.appends, 2);
    assert.deepEqual(success.durablePaused, [true, false]);
    assert.equal(success.paused, false);
    assert.equal(success.entries.length, 1);
    assert.deepEqual(success.warnings, []);
  });
});

test("handoff adoption keeps restored state paused on every identity and setter failure", { timeout: 2_000 }, async () => {
  await isolated(async () => {
    const snapshot = {
      format: SLATE_STATE_FORMAT, threads: [], episodes: [], orchestratorMode: true, paused: true,
      workerCostUsd: 0, carriedCostUsd: 0,
    };
    const target = { provider: "openai", id: "gpt-6-luna" };
    const cases = [
      ["missing-runtime", /not one unambiguous allowed logical choice/],
      ["ambiguous", /not one unambiguous allowed logical choice/],
      ["missing-effort", /no allowed fixed effort/],
      ["missing-model", /without a usable model identity/],
      ["registry-miss", /unknown or no auth/],
      ["setter-false", /unknown or no auth/],
      ["setter-throw", /could not restore model.*setter failed/s],
      ["effort-throw", /could not apply fixed effort.*effort failed/s],
      ["effort-clamp", /clamped effort/],
    ] as const;
    for (const [mode, expected] of cases) {
      const cwd = join(projectDir, mode);
      mkdirSync(join(cwd, ".pi", "slate"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
      const ordinary = createLogicalRuntime({
        trusted: true,
        projectConfig: mode === "ambiguous" ? { router: { models: { add: [{ model: "alias", capabilityRating: 40, costRating: 40, effort: "max", preferredProvider: "openai", providers: { openai: "gpt-6-luna" }, guidelines: [], cautions: [] }] } } } : undefined,
      });
      let runtime: any = mode === "missing-runtime" ? undefined : ordinary;
      if (mode === "missing-effort") runtime = { ...ordinary, effortFor: () => undefined };
      const base = createBaseModelTracker({ warn() {} });
      let thinking: any = "low";
      const handlers = new Map<string, any>();
      const pi = {
        on(event: string, handler: any) { handlers.set(event, handler); }, appendEntry() {}, getThinkingLevel: () => thinking,
        setThinkingLevel(level: string) { if (mode === "effort-throw") throw new Error("effort failed"); if (mode !== "effort-clamp") thinking = level; },
        async setModel() { if (mode === "setter-throw") throw new Error("setter failed"); return mode !== "setter-false"; },
      } as unknown as ExtensionAPI;
      const store = new SlateStore(pi);
      registerSlateHandoff(pi, store, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime);
      const entries = [handoffEntry("successor", {
        ...(mode === "missing-model" ? {} : { model: target }), logicalModel: mode === "ambiguous" ? undefined : "luna-6", snapshot,
      })];
      const ctx = {
        cwd, hasUI: false, model: { provider: "other", id: "current" }, isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "successor", getBranch: () => entries },
        modelRegistry: { find: () => mode === "registry-miss" ? undefined : target },
      } as unknown as ExtensionContext;
      const warnings: string[] = [];
      const old = console.warn; console.warn = (value?: unknown) => warnings.push(String(value));
      try { await handlers.get("session_start")({}, ctx); } finally { console.warn = old; }
      assert.equal(store.paused, true, mode);
      assert.match(warnings.join("\n"), expected, mode);
      const available = runtime?.ownership.acquire("after", SAVED_DEFAULT_RESOURCE_KEY);
      assert.equal(available?.kind ?? "acquired", "acquired", `${mode} releases ownership`);
      if (available?.kind === "acquired") available.lease.release();
    }
  });
});

test("successor ID, restored state, reload, legacy file and parallel handoffs keep ownership", { timeout: 2_000 }, async () => {
  await isolated(async () => {
    const snapshot = (cost: number) => ({ format: SLATE_STATE_FORMAT, threads: [], episodes: [], orchestratorMode: true, paused: true, workerCostUsd: cost, carriedCostUsd: 0 });
    const first = handoffEntry("successor-a", { snapshot: snapshot(7) });
    const second = handoffEntry("successor-b", { snapshot: snapshot(9) });
    const legacy = join(projectDir, ".pi", "slate", "pending-handoff.json");
    mkdirSync(join(projectDir, ".pi", "slate"), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ parentSession: "old", snapshot: snapshot(99) }));
    for (const [id, entries, expected] of [
      ["successor-a", [first, second], 7], ["successor-b", [first, second], 9],
      ["fork", [first], 0], ["clone", [second], 0], ["legacy-only", [], 0],
    ] as const) {
      const handlers = new Map<string, any>();
      const saved: Array<{ type: string; data: any }> = [];
      const pi = { on(event: string, handler: any) { handlers.set(event, handler); }, appendEntry(type: string, data: unknown) { saved.push({ type, data }); } } as unknown as ExtensionAPI;
      const store = new SlateStore(pi);
      registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
      const ctx = { cwd: projectDir, hasUI: false, isProjectTrusted: () => true, sessionManager: { getSessionId: () => id, getHeader: () => ({ parentSession: "old" }), getBranch: () => [...entries, ...saved.map(({ data }) => ({ type: "custom", customType: "slate-state", data }))], getEntries: () => [...entries, ...saved.map(({ data }) => ({ type: "custom", customType: "slate-state", data }))] } } as unknown as ExtensionContext;
      const oldWarn = console.warn; console.warn = () => {};
      try {
        await handlers.get("session_start")({}, ctx);
        assert.equal(store.workerCostUsd, expected, id);
        if (expected) {
          assert.equal(saved[0]?.type, "slate-state", "adoption commits state");
          const count = saved.length;
          store.restore(ctx);
          await handlers.get("session_start")({}, ctx);
          assert.equal(saved.length, count, "saved state wins on later restore");
          assert.equal(store.workerCostUsd, expected, "saved state stays authoritative");
        }
      } finally { console.warn = oldWarn; }
    }
    assert.equal(readFileSync(legacy, "utf8"), JSON.stringify({ parentSession: "old", snapshot: snapshot(99) }), "legacy file is neither read nor deleted");
    const existingHandlers = new Map<string, any>();
    const existingPi = { on(event: string, handler: any) { existingHandlers.set(event, handler); }, appendEntry() { throw new Error("saved entry must win"); } } as unknown as ExtensionAPI;
    const existingStore = new SlateStore(existingPi);
    registerSlateHandoff(existingPi, existingStore, () => ({}), () => createBaseModelTracker({ warn() {} }));
    const existingCtx = { cwd: projectDir, hasUI: false, sessionManager: { getSessionId: () => "successor-a", getBranch: () => [first, { type: "custom", customType: "slate-state", data: snapshot(23) }], getEntries: () => [] } } as unknown as ExtensionContext;
    existingStore.restore(existingCtx);
    await existingHandlers.get("session_start")({}, existingCtx);
    assert.equal(existingStore.workerCostUsd, 23, "saved state wins before the first adoption attempt");
    const retry = handoffEntry("retry", { snapshot: snapshot(11) });
    const handlers = new Map<string, any>();
    const pi = { on(event: string, handler: any) { handlers.set(event, handler); }, appendEntry() { throw new Error("disk unavailable"); } } as unknown as ExtensionAPI;
    const store = new SlateStore(pi);
    registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
    const ctx = { cwd: projectDir, hasUI: false, sessionManager: { getSessionId: () => "retry", getBranch: () => [retry], getEntries: () => [retry] } } as unknown as ExtensionContext;
    const oldWarn = console.warn; console.warn = () => {};
    try {
      await handlers.get("session_start")({}, ctx);
      store.restore(ctx);
      await handlers.get("session_start")({}, ctx);
      assert.equal(store.workerCostUsd, 11, "reload without saved state retries adoption");
    } finally { console.warn = oldWarn; }
  });
});

test("a session without handoff entries never asks for successor identity", async () => {
  const handlers = new Map<string, any>();
  const pi = { on(event: string, handler: any) { handlers.set(event, handler); }, appendEntry() { throw new Error("no handoff to save"); } } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
  const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => { throw new Error("no ID needed"); } } } as unknown as ExtensionContext;
  const oldWarn = console.warn; const warnings: string[] = []; console.warn = (value?: unknown) => warnings.push(String(value));
  try { await handlers.get("session_start")({}, ctx); } finally { console.warn = oldWarn; }
  assert.deepEqual(warnings, []);
  assert.equal(store.orchestratorMode, false);
});

test("invalid successor snapshot reports a refusal and does not save state", async () => {
  const handlers = new Map<string, any>();
  const pi = { on(event: string, handler: any) { handlers.set(event, handler); }, appendEntry() { throw new Error("invalid data reached save"); } } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "target", getBranch: () => [handoffEntry("target", { snapshot: { format: "invalid" } })] } } as unknown as ExtensionContext;
  const warnings: string[] = [];
  const oldWarn = console.warn; console.warn = (value?: unknown) => warnings.push(String(value));
  try { await handlers.get("session_start")({}, ctx); } finally { console.warn = oldWarn; }
  assert.equal(store.orchestratorMode, false);
  assert.match(warnings.join("\n"), /invalid successor handoff state/);
});

test("cancel and setup failure keep the legacy file and the parent state", async () => {
  await isolated(async () => {
    const legacy = join(projectDir, ".pi", "slate", "pending-handoff.json");
    mkdirSync(join(projectDir, ".pi", "slate"), { recursive: true });
    writeFileSync(legacy, "legacy sentinel");
    for (const mode of ["cancel", "setup-error"] as const) {
      const parent = SessionManager.inMemory(projectDir);
      parent.appendCustomEntry("slate-state", {
        format: SLATE_STATE_FORMAT, threads: [], episodes: [], orchestratorMode: true,
        paused: true, workerCostUsd: 13, carriedCostUsd: 0,
      });
      const successor = SessionManager.inMemory(projectDir);
      const saved: string[] = [];
      let parentActive = true;
      const pi = { on() {}, appendEntry(type: string) {
        if (!parentActive) throw new Error("old extension runner was disposed");
        saved.push(type);
      } } as unknown as ExtensionAPI;
      const store = new SlateStore(pi);
      store.paused = true;
      const hooks = registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
      const ctx = { cwd: projectDir, model: undefined, hasUI: false, isProjectTrusted: () => false,
        waitForIdle: async () => {}, sessionManager: parent,
        newSession: async (options: any) => {
          if (mode === "cancel") return { cancelled: true };
          parentActive = false; // Pi disposes the old runner before successor setup.
          await options.setup(successor);
          throw new Error("session replacement failed");
        },
      } as any;
      if (mode === "setup-error") {
        await assert.rejects(hooks.startHandoff(ctx), /session replacement failed/);
        assert.equal(successor.getBranch().some((item) => item.type === "custom" && item.customType === "slate-handoff"), true);
      } else await hooks.startHandoff(ctx);
      assert.deepEqual(saved, mode === "cancel" ? ["slate-state"] : [], `${mode}: only a live parent can save`);
      if (mode === "cancel") assert.equal(store.paused, false);
      assert.equal(parent.getBranch().length, 1, `${mode}: the parent keeps only its last saved state`);
      assert.equal((parent.getBranch()[0] as any).data.workerCostUsd, 13, `${mode}: saved parent cost survives`);
      assert.equal(readFileSync(legacy, "utf8"), "legacy sentinel", mode);
    }
  });
});

test("setup writes the successor-bound entry before session_start even without a session file", async () => {
  await isolated(async () => {
    const successor = SessionManager.inMemory(projectDir);
    const parent = SessionManager.inMemory(projectDir);
    const handlers = new Map<string, any>();
    let setupObserved = false;
    let kickoff = "";
    const pi = { on(event: string, handler: any) { handlers.set(event, handler); }, getThinkingLevel: () => "max", appendEntry() {} } as unknown as ExtensionAPI;
    const store = new SlateStore(pi);
    store.orchestratorMode = true;
    const hooks = registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
    const ctx = { cwd: projectDir, model: undefined, hasUI: false, isProjectTrusted: () => false,
      waitForIdle: async () => {}, sessionManager: parent,
      newSession: async (options: any) => {
        assert.equal(options.parentSession, undefined, "no persistence is required");
        await options.setup(successor);
        setupObserved = true;
        const entry = successor.getBranch().find((item) => item.type === "custom" && item.customType === "slate-handoff");
        assert.equal((entry as any)?.data.sessionId, successor.getSessionId(), "setup binds the new ID");
        assert.equal((entry as any)?.data.snapshot.orchestratorMode, true);
        const successorStore = new SlateStore(pi);
        const successorHandlers = new Map<string, any>();
        const successorPi = { on(event: string, handler: any) { successorHandlers.set(event, handler); }, appendEntry() {} } as unknown as ExtensionAPI;
        registerSlateHandoff(successorPi, successorStore, () => ({}), () => createBaseModelTracker({ warn() {} }));
        const freshCtx = { cwd: projectDir, hasUI: false, sessionManager: successor } as unknown as ExtensionContext;
        const oldWarn = console.warn; console.warn = () => {};
        try { await successorHandlers.get("session_start")({}, freshCtx); } finally { console.warn = oldWarn; }
        assert.equal(successorStore.orchestratorMode, true, "real adoption handler reads the setup entry");
        await options.withSession({ sendUserMessage: async (text: string) => { kickoff = text; } });
        return { cancelled: false };
      },
    } as any;
    await hooks.startHandoff(ctx);
    assert.equal(setupObserved, true);
    assert.match(kickoff, /threads.*episode/);
  });
});

test("a saved parent keeps its state and identifies the successor parent link", async () => {
  await isolated(async () => {
    const dir = join(scratch, "saved-parent-proof");
    mkdirSync(dir, { recursive: true });
    const parent = SessionManager.create(projectDir, dir);
    parent.appendCustomEntry("slate-state", { format: SLATE_STATE_FORMAT, threads: [], episodes: [], orchestratorMode: true });
    parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "brief" }], provider: "p", model: "m" } as any);
    const originalFile = parent.getSessionFile()!;
    const successor = SessionManager.create(projectDir, dir);
    const pi = { on() {}, appendEntry() {} } as unknown as ExtensionAPI;
    const store = new SlateStore(pi);
    store.orchestratorMode = true;
    const hooks = registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
    await hooks.startHandoff({ cwd: projectDir, model: undefined, hasUI: false, isProjectTrusted: () => true,
      waitForIdle: async () => {}, sessionManager: parent,
      newSession: async (options: any) => {
        assert.equal(options.parentSession, originalFile);
        await options.setup(successor);
        return { cancelled: false };
      },
    } as any);
    assert.match(readFileSync(originalFile, "utf8"), /slate-state/, "the parent keeps its saved state");
    assert.equal((successor.getBranch()[0] as any).data.sessionId, successor.getSessionId());
  });
});

test("two parent handoffs in one project write separate successor sessions", async () => {
  await isolated(async () => {
    const successors = await Promise.all([7, 9].map(async (cost) => {
      const successor = SessionManager.inMemory(projectDir);
      const parent = SessionManager.inMemory(projectDir);
      const pi = { on() {}, appendEntry() {} } as unknown as ExtensionAPI;
      const store = new SlateStore(pi);
      store.orchestratorMode = true;
      store.workerCostUsd = cost;
      const hooks = registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
      await hooks.startHandoff({ cwd: projectDir, hasUI: false, model: undefined,
        isProjectTrusted: () => true, waitForIdle: async () => {}, sessionManager: parent,
        newSession: async (options: any) => { await options.setup(successor); return { cancelled: false }; },
      } as any);
      return successor;
    }));
    assert.notEqual(successors[0]!.getSessionId(), successors[1]!.getSessionId());
    const entries = successors.map((successor) => successor.getBranch()[0]);
    assert.equal((entries[0] as any).data.snapshot.workerCostUsd, 7);
    assert.equal((entries[1] as any).data.snapshot.workerCostUsd, 9);
    // Use one real adoption handler per successor, not a direct snapshot copy.
    for (const [index, successor] of successors.entries()) {
      const handlers = new Map<string, any>();
      const pi = { on(event: string, handler: any) { handlers.set(event, handler); }, appendEntry() {} } as unknown as ExtensionAPI;
      const store = new SlateStore(pi);
      registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
      const ctx = { cwd: projectDir, hasUI: false, sessionManager: successor } as unknown as ExtensionContext;
      const oldWarn = console.warn; console.warn = () => {};
      try { await handlers.get("session_start")({}, ctx); } finally { console.warn = oldWarn; }
      assert.equal(store.workerCostUsd, index === 0 ? 7 : 9);
    }
  });
});

test("Pi fork and clone copy the entry but assign different session IDs", async () => {
  const sessions = join(scratch, "identity-proof");
  mkdirSync(sessions, { recursive: true });
  const source = SessionManager.create(projectDir, sessions);
  const originalId = source.getSessionId();
  const handoffId = source.appendCustomEntry("slate-handoff", { sessionId: originalId, snapshot: {
    format: SLATE_STATE_FORMAT, threads: [], episodes: [], orchestratorMode: true,
    paused: true, workerCostUsd: 17, carriedCostUsd: 0,
  } });
  source.appendMessage({ role: "assistant", content: [{ type: "text", text: "seed" }], provider: "p", model: "m" } as any);
  const sourceFile = source.getSessionFile()!;
  assert.equal(readFileSync(sourceFile, "utf8").includes("slate-handoff"), true, "the saved session contains the entry");
  const clone = SessionManager.forkFrom(sourceFile, projectDir, join(scratch, "identity-clone"));
  assert.notEqual(clone.getSessionId(), originalId);
  assert.equal((clone.getBranch().find((e) => e.type === "custom" && e.customType === "slate-handoff") as any)?.data.sessionId, originalId);
  const fork = SessionManager.open(sourceFile);
  fork.createBranchedSession(handoffId);
  assert.notEqual(fork.getSessionId(), originalId);
  assert.equal((fork.getBranch().find((e) => e.type === "custom" && e.customType === "slate-handoff") as any)?.data.sessionId, originalId);
  for (const copied of [clone, fork]) {
    const handlers = new Map<string, any>();
    const pi = { on(event: string, handler: any) { handlers.set(event, handler); }, appendEntry() { throw new Error("a copy adopted the handoff"); } } as unknown as ExtensionAPI;
    const store = new SlateStore(pi);
    registerSlateHandoff(pi, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
    const ctx = { cwd: projectDir, hasUI: false, sessionManager: copied } as unknown as ExtensionContext;
    // A clone and a branch fork carry the custom entry on their active branch.
    // Both must refuse it because Pi assigned a new ID.
    assert.equal(copied.getBranch().some((e) => e.type === "custom" && e.customType === "slate-handoff"), true);
    await handlers.get("session_start")({}, ctx);
    assert.equal(store.orchestratorMode, false);
    assert.equal(store.workerCostUsd, 0, "a copied entry must not adopt its original owner's cost");
  }
});

test("threshold compaction pause keeps the same save instructions", async () => {
  await isolated(async () => {
    const f = fixture({ contextBudget: { tokens: 100 } });
    const result = await f.handlers.get("session_before_compact")!({ reason: "threshold" }, f.ctx);
    assert.deepEqual(result, { cancel: true });
    assert.equal(f.store.paused, true);
    assert.equal(f.sent.length, 1);
    const lines = assertPauseContract(
      f.sent[0]!.message.content as string,
      "[slate] pi hit its auto-compaction threshold; slate cancelled the compaction and auto-paused instead: user prompts are refused, and state-save workers remain available. (While paused, a repeat compaction passes through as the escape valve.)",
    );
    assert.equal(lines.at(-1), "(If slate has since been resumed or unpaused, disregard this message.)");
    assert.deepEqual(f.sent[0]!.options, { deliverAs: "steer" });
  });
});
