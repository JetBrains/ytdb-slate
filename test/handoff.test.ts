import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effectiveContextBudgetTokens, registerSlateHandoff } from "../extension/handoff.ts";
import { SlateStore } from "../extension/state.ts";

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

function fixture(config: Record<string, unknown>, usage?: { percent: number; tokens: number | null; contextWindow: number }, model?: { provider: string; id: string }) {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.orchestratorMode = true;
  registerSlateHandoff(pi, store, () => config as any, () => ({}) as any);
  const ctx = {
    cwd: projectDir,
    hasUI: false,
    isProjectTrusted: () => false,
    ...(model ? { model } : {}),
    getContextUsage: () => usage ?? { percent: 100, tokens: 10, contextWindow: 1000 },
  } as unknown as ExtensionContext;
  return { handlers, sent, store, ctx };
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
