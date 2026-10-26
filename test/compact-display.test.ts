import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { registerSlateTools } from "../extension/tools.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { sanitizeThreadDevMode, SlateStore } from "../extension/state.ts";
import type { ThreadManager } from "../extension/threads.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import { ActionDisplayProgress, protectDisplay, renderCompactCall, renderCompactResult } from "../extension/render.ts";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const forbidden = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufff9-\ufffb]/;
const hostile = '\x1b]52;c;YQ==\x07\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\\x1b[31m\x00\x01\x08\x0b\x0c\x1f\x7f\x9d52;c;x\x9c\x9b31m\u061c\u200e\u200f\u202a\u202e\u2066\u2069\ufff9\ufffa\ufffb';
const links = '[trusted](https://evil.test/path) <https://evil.test/auto>';
const tools = ["thread", "threads", "episode", "slate_change"];
function output(component: { render(width: number): string[] }, width = 120) {
  return component.render(width).map((line) => line.trimEnd()).join("\n");
}

for (const tool of tools) {
  test(`${tool} protects every call and result view without changing evidence`, () => {
    const args = { name: `name\r\n\t${hostile}`, action: hostile, task: `${hostile}${links}`, context: [hostile], model: hostile };
    const lines = Array.from({ length: 20 }, (_, n) => `progress-${n} ${hostile}`);
    const result = { content: [{ type: "text", text: `${hostile}${links}\nFULL RESULT` }], details: {
      threadName: args.name, done: false, status: "failed", lines,
      displayActivity: hostile, displayFailure: hostile, warnings: [hostile], extra: hostile,
    } };
    const before = JSON.stringify({ args, result });
    for (const expanded of [false, true]) {
      for (const isPartial of [false, true]) {
        for (const width of [40, 120]) {
          const call = output(renderCompactCall(tool, args, theme, { expanded, isPartial }), width);
          const rendered = output(renderCompactResult(tool, result, { expanded, isPartial }, theme, { isError: true }), width);
          assert.doesNotMatch(call + rendered, forbidden);
          assert.match(rendered, /failed/);
          assert.doesNotMatch(rendered, /running/);
          if (!expanded) {
            assert.doesNotMatch(call, /FULL RESULT|trusted|model|task|progress-/);
            assert.doesNotMatch(rendered, /FULL RESULT|trusted|progress-/);
          } else {
            // Destination remains literal text, not an OSC 8 terminal hyperlink.
            assert.match(call.replace(/\n/g, ""), /https:\/\/evil\.test\/path/);
            assert.match(rendered.replace(/\n/g, ""), /https:\/\/evil\.test\/auto/);
            assert.match(rendered, /FULL RESULT/);
            assert.match(rendered, /progress-0/);
            assert.match(rendered, /progress-19/);
          }
        }
      }
    }
    assert.equal(JSON.stringify({ args, result }), before);
  });

  test(`${tool} handles missing and malformed result details and arguments`, () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const throwing = { get name(): string { throw new Error(hostile); }, get details(): never { throw new Error(hostile); } };
    for (const value of [undefined, null, 42, "bad", [], cyclic, throwing, { content: [null, { type: "text", text: 42 }], details: { lines: 42 } }]) {
      for (const expanded of [false, true]) {
        const call = output(renderCompactCall(tool, value, theme, { expanded }));
        const result = output(renderCompactResult(tool, value, { expanded }, theme, { isError: true }));
        assert.doesNotMatch(call + result, forbidden);
        assert.match(result, /failed|invalid display data/);
        assert.doesNotMatch(result, /running/);
      }
    }
    assert.match(output(renderCompactResult(tool, { content: [{ type: "text", text: `Error: ${hostile}failure` }] }, { expanded: false }, theme, { isError: true })), /failure/);
    assert.doesNotMatch(output(renderCompactResult(tool, {}, { expanded: false }, theme)), /running/);
  });
}


test("threadDevMode accepts only booleans and defaults to false", () => {
  for (const value of [undefined, false, true, null, 0, 1, "true", [], {}]) {
    const warnings: string[] = [];
    assert.equal(sanitizeThreadDevMode(value, (message) => warnings.push(message)), value === true);
    const invalid = value !== undefined && typeof value !== "boolean";
    assert.deepEqual(warnings, invalid ? ["slate: threadDevMode must be a boolean. Using false."] : []);
  }
});

test("collapsed thread diagnostics preserve other warnings in both modes", () => {
  for (const threadDevMode of [false, true]) for (const isPartial of [false, true]) {
    for (const other of [undefined, "", "Check routing."]) for (const toolFirst of [false, true]) {
      const state = new ActionDisplayProgress();
      state.toolFailed("read");
      const toolWarning = "slate: completed tool calls failed: read (1).";
      const markTool = () => state.warn(toolWarning, 1, true);
      if (toolFirst) markTool();
      if (other !== undefined) state.warn(other);
      if (!toolFirst) markTool();
      const result = { content: [{ type: "text", text: toolWarning }], details: {
        ...state.details(), done: !isPartial, lines: [toolWarning], warnings: [toolWarning],
      } };
      const before = JSON.stringify(result);
      const rendered = output(renderCompactResult("thread", result, { expanded: false, isPartial, threadDevMode }, theme));
      assert.equal(rendered.includes("Tool failed: read"), threadDevMode);
      assert.equal(rendered.includes("⚠"), threadDevMode || other !== undefined);
      if (!threadDevMode) {
        assert.doesNotMatch(rendered, /completed tool calls failed/);
        if (other !== undefined) assert.match(rendered, other ? /Check routing/ : /Action warning/);
      } else {
        assert.ok(rendered.includes(state.warningSummary));
      }
      const expanded = (mode: boolean) => output(renderCompactResult("thread", result,
        { expanded: true, isPartial, threadDevMode: mode }, theme), 10000);
      assert.equal(expanded(false), expanded(true));
      assert.match(expanded(false), /completed tool calls failed/);
      assert.equal(JSON.stringify(result), before);
      for (const tool of ["threads", "episode"]) {
        const view = (mode: boolean) => output(renderCompactResult(tool, result,
          { expanded: false, isPartial, threadDevMode: mode }, theme));
        assert.equal(view(false), view(true));
        assert.match(view(false), /Tool failed: read/);
      }
    }
  }
});

test("failed thread keeps a reason when its tool failure mark is hidden", () => {
  for (const reason of ["", "Provider unavailable"]) {
    const state = new ActionDisplayProgress();
    state.toolFailed("read");
    state.failed(reason);
    const result = { details: { ...state.details(), status: "failed", done: true } };
    const rendered = output(renderCompactResult("thread", result, { expanded: false }, theme));
    assert.match(rendered, /^✗ thread failed/);
    assert.doesNotMatch(rendered, /Tool failed/);
    assert.ok(rendered.includes(reason || "Action failed. Expand for details."));
  }
});

test("registered thread reads the current manager config at draw time", () => {
  let config = {};
  const manager = { getConfig: () => config } as ThreadManager;
  const tool = registeredTools(manager).registered.get("thread")!;
  const state = new ActionDisplayProgress();
  state.toolFailed("read");
  state.warn("failed direct tool", 1, true);
  for (const isPartial of [true, false]) {
    const result = { content: [{ type: "text" as const, text: "full evidence" }],
      details: { ...state.details(), done: !isPartial } };
    for (const mode of [undefined, true, false, true]) {
      config = { threadDevMode: mode };
      const text = output(tool.renderResult!(result, { expanded: false, isPartial }, theme as never, {} as never));
      assert.equal(text.includes("Tool failed: read"), mode === true);
      assert.equal(text.includes("⚠"), mode === true);
    }
  }
});

test("one-line fields normalize breaks and protection survives cuts and nested escapes", () => {
  assert.equal(protectDisplay("a\r\n\tb", true), "a   b");
  const attack = `\x1b\x1b]0;x\x07]52;x\x07${hostile}`;
  for (const size of [59, 60, 79, 80, 159, 160]) {
    const text = `${"x".repeat(size)}${attack}`;
    const state = new ActionDisplayProgress(); state.toolStarted(text); state.toolFailed(text);
    const rendered = output(renderCompactResult("thread", { details: { threadName: text, displayActivity: state.activity, displayFailure: state.failure } }, { expanded: false, isPartial: true }, theme));
    assert.doesNotMatch(rendered, forbidden);
  }
  assert.equal(protectDisplay("a\nb\tc\rd"), "a\nb\tcd");
});

test("bounded display state keeps failure after the evidence tail moves", () => {
  const state = new ActionDisplayProgress();
  state.toolFailed(`read${hostile}${"x".repeat(10000)}`);
  const failure = state.failure;
  const evidence = new Proxy([] as string[], { get() { throw new Error("Display must not read the evidence list"); } });
  for (let n = 0; n < 10000; n++) { state.toolStarted("read"); state.response(); state.warn(); }
  assert.equal(state.failure, failure);
  assert.ok(state.failure.length <= 93);
  assert.ok(JSON.stringify(state).length < 400);
  const rendered = output(renderCompactResult("thread", { details: { lines: evidence, displayFailure: state.failure, displayActivity: state.activity, displayWarning: state.warning } }, { expanded: false, isPartial: true, threadDevMode: true }, theme));
  assert.match(rendered, /Tool failed: read/);
  assert.match(rendered, /Action warning/);
  assert.doesNotMatch(rendered, /invalid display data/);
  assert.equal(new ActionDisplayProgress().failure, "");
});

test("expanded streaming shows all progress and full calls while compact context controls status", () => {
  const task = "full task ".repeat(80);
  const call = output(renderCompactCall("thread", { task, type: "reviewer", model: "fixture", context: [] }, theme, { expanded: true }), 10000);
  assert.ok(call.includes(task));
  assert.match(call, /"type": "reviewer"/);
  assert.match(call, /"model": "fixture"/);
  const result = { content: [{ type: "text", text: "partial content" }], details: { lines: Array.from({ length: 20 }, (_, n) => "line-" + n), displayActivity: "Tool: read" } };
  const expanded = output(renderCompactResult("thread", result, { expanded: true, isPartial: true }, theme));
  assert.match(expanded, /running/); assert.match(expanded, /line-0/); assert.match(expanded, /line-19/);
  const final = output(renderCompactResult("thread", result, { expanded: false, isPartial: true }, theme, { isPartial: false }));
  assert.match(final, /done/); assert.doesNotMatch(final, /running|line-/);
  assert.match(output(renderCompactResult("thread", { details: { done: true } }, { expanded: false, isPartial: true }, theme)), /done/);
  assert.match(output(renderCompactResult("threads", { details: { count: 10, failedCount: 2 } }, { expanded: false }, theme)), /10 threads, 2 failed/);
  assert.doesNotMatch(output(renderCompactResult("threads", { details: { count: 0, failedCount: 0 } }, { expanded: false }, theme)), /failed/);
  assert.match(output(renderCompactCall("slate_change", { action: "close" }, theme)), /slate_change close/);
});

test("successful warnings remain visible without exposing repair instructions", () => {
  const result = { content: [{ type: "text", text: "observation grammar repair instructions" }], details: { done: true, warnings: ["repair grammar"] } };
  const compact = output(renderCompactResult("thread", result, { expanded: false }, theme));
  assert.match(compact, /Action warning/);
  assert.doesNotMatch(compact, /grammar|instructions/);
  assert.match(output(renderCompactResult("thread", result, { expanded: true }, theme)), /repair instructions/);
});

function registeredTools(manager?: ThreadManager) {
  const registered = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const pi = { registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) { registered.set(tool.name, tool); }, registerCommand() {}, on() {}, appendEntry() {} } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  registerSlateTools(pi, store, () => manager ?? ({ liveFailoverModel: () => undefined, getConfig: () => ({}) }) as unknown as ThreadManager);
  registerSlateMode(pi, store, { startHandoff: async () => {}, effectiveContextBudget: (n: number) => n }, () => ({}), () => EMPTY_WORKER_EXTENSION_SET);
  return { registered, store };
}

test("host renderer boundary never falls back to raw malformed arguments", () => {
  initTheme(undefined, false);
  const { registered } = registeredTools();
  for (const name of tools) {
    const source = registered.get(name)!;
    assert.ok(source.renderCall); assert.ok(source.renderResult);
    const definition: typeof source = {
      ...source, renderShell: "self",
      renderCall: (args, _theme, context) => source.renderCall!(args, theme as never, context),
      renderResult: (result, options, _theme, context) => source.renderResult!(result, options, theme as never, context),
    };
    let fallbackCalls = 0;
    const host = new ToolExecutionComponent(name, "id", { name: hostile, task: hostile, context: "malformed" }, {}, definition, { requestRender() {} } as never, "/tmp");
    const boundary = host as unknown as { createCallFallback(): never; createResultFallback(): never };
    boundary.createCallFallback = boundary.createResultFallback = () => { fallbackCalls++; throw new Error("unsafe fallback"); };
    for (const expanded of [false, true]) {
      host.setExpanded(expanded);
      for (const partial of [false, true]) {
        host.updateArgs({ name: hostile, context: 42, task: hostile });
        host.updateResult({ content: [{ type: "text", text: hostile + links }], details: null, isError: true }, partial);
        assert.doesNotMatch(output(host), forbidden);
        assert.match(output(host), /failed/);
      }
    }
    assert.equal(fallbackCalls, 0);
  }
});

test("hostile successful, running and failed displays keep exact one-line fields", () => {
  const name = "safe\nforged\tname";
  for (const tool of tools) {
    for (const status of ["ok", "running", "failed"] as const) {
      const result = { details: { threadName: name, status: status === "running" ? "ok" : status,
        displayActivity: "Tool: read\nnext\t" + hostile,
        displayFailureReason: status === "failed" ? "Renew credentials.\n" + hostile : "",
        displayWarning: true, displayWarningSummary: "Check results.\n" + hostile } };
      const text = output(renderCompactResult(tool, result, { expanded: false, isPartial: status === "running" }, theme), 10000);
      assert.doesNotMatch(text, forbidden);
      const label = tool === "thread" ? "safe forged name" : tool;
      const header = tool === "episode" && status !== "running" ? "✓ Episode loaded"
        : `${status === "failed" ? "✗" : status === "running" ? "⏳" : "✓"} ${label} ${status === "ok" ? "done" : status}`;
      assert.equal(text.split("\n")[0], header);
      if (status === "running") assert.equal(text.split("\n")[1], "  Tool: read next " + protectDisplay(hostile, true));
      if (status === "failed" && tool !== "episode") assert.ok(text.includes("  Renew credentials. " + protectDisplay(hostile, true)));
      assert.equal(text.split("\n").at(-1), "  ⚠ Check results. " + protectDisplay(hostile, true));
    }
  }
});

test("missing call fields are valid but malformed calls show the protected failure label", () => {
  for (const tool of tools) for (const expanded of [false, true]) {
    assert.equal(output(renderCompactCall(tool, {}, theme, { expanded })).split("\n")[0], tool);
    for (const args of [null, 42, [], { name: 42 }, { task: [] }, { context: 42 }, { context: [42] }]) {
      assert.equal(output(renderCompactCall(tool, args, theme, { expanded })), `✗ ${tool}: invalid display data`);
    }
  }
});

test("recognized malformed details never claim success", () => {
  for (const details of [42, "bad", [], { done: 42 }, { status: 42 }, { status: "future" }, { lines: 42 },
    { threadName: 42 }, { warnings: "bad" }, { warnings: [42] }, { displayActivity: 42 }, { displayFailure: 42 },
    { displayFailureReason: 42 }, { displayWarning: "yes" }, { displayWarningSummary: 42 },
    { displayOtherWarning: "yes" }, { displayOtherWarningSummary: 42 },
    { count: -1 }, { count: NaN }, { failedCount: 1.5 }]) {
    for (const tool of tools) for (const expanded of [false, true]) {
      assert.equal(output(renderCompactResult(tool, { details }, { expanded }, theme)), `✗ ${tool}: invalid display data`);
    }
  }
});

test("expanded running progress keeps only fifty lines and an earlier count", () => {
  for (const count of [1000, 10000]) {
    const result = { content: [{ type: "text", text: "partial" }], details: { lines: Array.from({ length: count }, (_, n) => "progress-" + n) } };
    const rendered = output(renderCompactResult("thread", result, { expanded: true, isPartial: true }, theme), 10000);
    assert.ok(rendered.length < 2000);
    assert.match(rendered, new RegExp('"earlierLines": ' + (count - 50)));
    assert.ok(rendered.includes('"progress-' + (count - 50) + '"'));
    assert.ok(rendered.includes('"progress-' + (count - 1) + '"'));
    assert.ok(!rendered.includes('"progress-' + (count - 51) + '"'));
  }
  const full = "FULL RESULT ".repeat(1000).trimEnd();
  assert.ok(output(renderCompactResult("thread", { content: [{ type: "text", text: full }] }, { expanded: true }, theme), 100000).includes(full));
});

test("failure and prioritized warning summaries stay bounded and separate from repair instructions", () => {
  const state = new ActionDisplayProgress();
  state.toolFailed("read");
  state.failed("status reason", "## Open Issues\nRenew credentials before retrying.\n## Handoff Notes\nother");
  assert.equal(state.failureReason, "status reason");
  state.warn("routing warning");
  state.warn("Review the worker transcript before you rely on the result.", 2);
  state.warn("lower priority routing warning");
  state.warn("");
  const text = output(renderCompactResult("thread", { details: { ...state.details(), status: "failed" } }, { expanded: false, threadDevMode: true }, theme));
  assert.match(text, /Tool failed: read/);
  assert.match(text, /status reason/);
  assert.doesNotMatch(text, /Renew credentials/);
  assert.match(text, /Review the worker transcript before you rely on the result/);
  assert.doesNotMatch(text, /lower priority|Expand for details/);
  state.failed("fallback reason");
  assert.equal(state.failureReason, "fallback reason");
  state.failed("x".repeat(10000) + hostile);
  assert.ok(String(state.failureReason).length <= 160);
  state.warn(hostile + "x".repeat(10000), 3);
  assert.ok(state.warningSummary.length <= 160);
  assert.doesNotMatch(state.failureReason + state.warningSummary, forbidden);
});

test("failure reasons prefer diagnostics then tool failure then meaningful episode issues", () => {
  for (const issues of ["None.", "Use exactly five pipe-delimited fields for repair."]) {
    const state = new ActionDisplayProgress();
    state.failed("Provider unavailable", "## Open Issues\n" + issues);
    assert.equal(state.failureReason, "Provider unavailable");
    assert.equal(output(renderCompactResult("thread", { details: { ...state.details(), status: "failed" } }, { expanded: false }, theme)),
      "✗ thread failed\n  Provider unavailable");
  }
  for (const marker of ["None", "None.", "NONE.", "N/A", "n/a", "-", "", "  "]) {
    const state = new ActionDisplayProgress();
    state.failed(undefined, "## Open Issues\n" + marker + "\nRenew credentials.\nSecond issue.\n## Handoff Notes\nother");
    assert.equal(state.failureReason, "Renew credentials.");
    state.failed(undefined, "## Open Issues\n" + marker);
    assert.equal(output(renderCompactResult("thread", { details: { ...state.details(), status: "failed" } }, { expanded: false }, theme)),
      "✗ thread failed\n  Action failed. Expand for details.");
  }
  const state = new ActionDisplayProgress();
  state.toolFailed("read");
  state.failed(undefined, "## Open Issues\nRepair instructions.");
  assert.equal(state.failureReason, "");
  assert.equal(output(renderCompactResult("thread", { details: { ...state.details(), status: "failed" } }, { expanded: false, threadDevMode: true }, theme)),
    "✗ thread failed\n  Tool failed: read");
  state.failed("Provider unavailable", "## Open Issues\nNone.");
  assert.equal(state.failureReason, "Provider unavailable");
});

test("expanded running validates only its displayed line tail", () => {
  for (const bad of [42, null, {}, undefined]) {
    const lines = [...Array<string>(100).fill("progress"), bad];
    for (const tool of tools) {
      assert.equal(output(renderCompactResult(tool, { details: { lines } }, { expanded: true, isPartial: true }, theme)),
        `✗ ${tool}: invalid display data`);
    }
  }
  const lines = new Proxy(Array<string>(10000).fill("progress"), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key) && Number(key) < 9950) throw new Error("Unbounded line scan");
      return Reflect.get(target, key, receiver);
    },
  });
  const text = output(renderCompactResult("thread", { details: { lines } }, { expanded: true, isPartial: true }, theme));
  assert.match(text, /running/);
  assert.match(text, /"earlierLines": 9950/);
});

test("episode retrieval status and singular thread count describe the operation", () => {
  assert.equal(output(renderCompactResult("episode", { details: { status: "failed" } }, { expanded: false }, theme)),
    "✓ Episode loaded\n  Stored action failed. Expand for details.");
  assert.match(output(renderCompactResult("episode", {}, { expanded: false }, theme, { isError: true })), /^✗ episode failed/);
  assert.equal(output(renderCompactResult("threads", { details: { count: 1, failedCount: 0 } }, { expanded: false }, theme)), "✓ threads done\n  1 thread");
});

test("registered thread forwards failed terminal progress and final display metadata", { timeout: 5000 }, async () => {
  const usage = { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 };
  const display = { displayActivity: "Tool: read", displayFailure: "Tool failed: read",
    displayFailureReason: "Renew credentials.", displayWarning: true, displayWarningSummary: "Check results.",
    displayOtherWarning: true, displayOtherWarningSummary: "Check results." };
  const manager = { getConfig: () => ({ threadDevMode: true }), async dispatch(_opts: unknown, _ctx: unknown, _signal: unknown, update: (p: unknown) => void) {
    update({ ...display, threadId: "t1", threadName: "probe", lines: [], usage, done: true, status: "failed" });
    return { display, usage, warnings: [], thread: { id: "t1", name: "probe", type: "reviewer" },
      episode: { id: "t1.e1", status: "failed", file: "/tmp/e" }, episodeText: "unchanged evidence" };
  } } as unknown as ThreadManager;
  const { registered } = registeredTools(manager);
  const tool = registered.get("thread")!;
  let updates = 0;
  const result = await tool.execute("call", { type: "reviewer", task: "inspect", model: "fixture", reason: "test" }, undefined, (update) => {
    updates++;
    assert.deepEqual(update.details, { ...display, threadId: "t1", threadName: "probe", type: "reviewer", lines: [], usage, done: true, status: "failed" });
    const text = output(tool.renderResult!(update, { expanded: false, isPartial: true }, theme as never, {} as never));
    assert.match(text, /^✗ probe failed/);
    assert.match(text, /Tool failed: read/); assert.match(text, /Renew credentials/); assert.match(text, /Check results/);
  }, {} as ExtensionToolContext);
  assert.equal(updates, 1);
  const text = output(tool.renderResult!(result, { expanded: false, isPartial: false }, theme as never, {} as never));
  assert.match(text, /Tool failed: read/); assert.match(text, /Renew credentials/); assert.match(text, /Check results/);
});

test("episode retrieval and thread-list evidence remain byte-identical after rendering", async () => {
  const root = mkdtempSync(join(tmpdir(), "slate-display-"));
  try {
    const { registered, store } = registeredTools();
    const file = join(root, ".pi", "slate", "episodes", "t1.e1.md");
    mkdirSync(join(root, ".pi", "slate", "episodes"), { recursive: true });
    const text = `${hostile}${links}\n## Key Findings\nALL EVIDENCE\n`;
    writeFileSync(file, text);
    store.episodes.set("t1.e1", { id: "t1.e1", threadId: "t1", task: "task", status: "ok", file, createdAt: 1 });
    const tool = registered.get("episode")!;
    const result = await tool.execute("id", { id: "t1.e1" }, undefined, undefined, { cwd: root } as ExtensionToolContext);
    assert.deepEqual(result.content, [{ type: "text", text }]);
    for (const expanded of [false, true]) output(renderCompactResult("episode", result, { expanded }, theme));
    assert.deepEqual(result.content, [{ type: "text", text }]);
    assert.equal(readFileSync(file, "utf8"), text);
    const list = await registered.get("threads")!.execute("id", {}, undefined, undefined, {} as ExtensionToolContext);
    assert.deepEqual(list.content, [{ type: "text", text: "No threads yet. Use the thread tool to create one." }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
