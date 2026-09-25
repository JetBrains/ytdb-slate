const TEST_ROUTE = { model: "fixture", reason: "test fixture" } as const;

import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSlateMode } from "../extension/mode.ts";
import { renderThreadResult } from "../extension/render.ts";
import { effectiveThreadType, SlateStore, type ThreadRecord, type ThreadType } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import { registerSlateTools } from "../extension/tools.ts";
import type { ThreadManager } from "../extension/threads.ts";

function record(overrides: Partial<ThreadRecord>): ThreadRecord {
  return {
    id: "t1",
    name: "worker",
    type: "general",
    status: "cancelled",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface TestTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const theme: TestTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

interface RegisteredTool {
  name: string;
  execute(...args: unknown[]): Promise<unknown>;
  renderCall?(args: Record<string, unknown>, theme: TestTheme): { render(width: number): string[] };
}

function toolsFixture(threads: ThreadRecord[]) {
  const registered = new Map<string, RegisteredTool>();
  const pi = {
    appendEntry() {},
    registerTool(tool: RegisteredTool) {
      registered.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  for (const thread of threads) store.threads.set(thread.id, thread);
  const manager = {
    liveFailoverModel: () => undefined,
    async dispatch(
      opts: { threadId?: string },
      _ctx: ExtensionContext,
      _signal: AbortSignal | undefined,
      onProgress?: (progress: {
        threadId: string;
        threadName: string;
        lines: string[];
        usage: { turns: number; input: number; output: number; cost: number; contextTokens: number };
        done: boolean;
        status?: "ok" | "failed";
      }) => void,
    ) {
      const thread = opts.threadId === undefined ? threads[0] : store.threads.get(opts.threadId);
      assert.ok(thread);
      const usage = { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 };
      onProgress?.({ threadId: thread.id, threadName: thread.name, lines: [], usage, done: false });
      onProgress?.({ threadId: thread.id, threadName: thread.name, lines: [], usage, done: true, status: "ok" });
      return {
        thread,
        episode: { id: `${thread.id}.e1`, threadId: thread.id, task: "x", status: "ok", file: "/tmp/e", createdAt: 1 },
        episodeText: "episode",
        warnings: [],
        usage,
      };
    },
  } as unknown as ThreadManager;
  registerSlateTools(pi, store, () => manager);
  return { registered, store };
}

const ctx = { hasUI: false } as ExtensionContext;
const cases: Array<{ name: string; type: ThreadRecord["type"]; marker: string }> = [
  { name: "researcher", type: "researcher", marker: " type=researcher" },
  { name: "reviewer", type: "reviewer", marker: " type=reviewer" },
  { name: "adversarial", type: "adversarial", marker: " type=adversarial" },
  { name: "implementer", type: "implementer", marker: " type=implementer" },
  { name: "general", type: "general", marker: "" },
];

function caseRecords(): ThreadRecord[] {
  return cases.map((entry, index) => record({ id: `t${index + 1}`, name: entry.name, type: entry.type }));
}

function firstLine(component: { render(width: number): string[] }): string {
  return component.render(200)[0]?.trimEnd() ?? "";
}

test("mode refresh keeps pause on the status line without a thread widget", async () => {
  const appended: unknown[] = [];
  const widgets: string[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand() {},
    registerTool() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    appendEntry(_type: string, data: unknown) { appended.push(data); },
  } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  store.orchestratorMode = true;
  store.threads.set("t1", record({ id: "t1", status: "running", episodeId: "t1.e1" }));
  const writing: { showStatus?: boolean } = {};
  registerSlateMode(
    pi,
    store,
    { startHandoff: async () => {}, effectiveContextBudget: (window: number) => window },
    () => ({ writing }),
    () => EMPTY_WORKER_EXTENSION_SET,
  );
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  await sessionStart({}, {
    hasUI: true,
    mode: "rpc",
    isProjectTrusted: () => true,
    ui: {
      setWidget: (key: string) => { widgets.push(key); },
      setStatus: (key: string, text: string | undefined) => { statuses.push({ key, text }); },
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  } as unknown as ExtensionContext);
  const plain = "slate: orchestrator ⋅ total $0.0000 (me $0.0000 + workers $0.0000)";
  assert.deepEqual(statuses.at(-1), { key: "slate", text: plain });
  assert.equal(appended.length, 0);
  writing.showStatus = true;
  store.save();
  const base = `${plain} ⋅ writing 0 fail, 0 style / 10 turns`;
  assert.deepEqual(statuses.at(-1), { key: "slate", text: base });
  store.paused = true;
  store.save();
  assert.deepEqual(statuses.at(-1), { key: "slate", text: base.replace("slate: orchestrator", "slate: orchestrator ⋅ ⛔ PAUSED — run /slate handoff") });
  store.paused = false;
  store.save();
  assert.deepEqual(statuses.at(-1), { key: "slate", text: base });
  store.orchestratorMode = false;
  store.save();
  assert.deepEqual(statuses.at(-1), { key: "slate", text: undefined });
  assert.equal(widgets.includes("slate"), false);
});

test("TUI status themes each segment and hides writing without showStatus", async () => {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand() {}, registerTool() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
    getActiveTools: () => [], getAllTools: () => [], setActiveTools() {}, appendEntry() {},
  } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  store.orchestratorMode = true;
  const writing = { showStatus: false };
  registerSlateMode(pi, store,
    { startHandoff: async () => {}, effectiveContextBudget: (window: number) => window },
    () => ({ writing }), () => EMPTY_WORKER_EXTENSION_SET);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  const ctx = {
    hasUI: true, mode: "tui", isProjectTrusted: () => true,
    ui: {
      theme: {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
        bold: (text: string) => `<bold>${text}</bold>`,
      },
      setWidget() {},
      setStatus: (key: string, text: string | undefined) => { statuses.push({ key, text }); },
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  } as unknown as ExtensionContext;
  await sessionStart({}, ctx);
  const label = "<bold><accent>◆ slate orchestrator</accent></bold>";
  const cost = "<muted>total $0.0000 (me $0.0000 + workers $0.0000)</muted>";
  const base = `${label} ⋅ ${cost}`;
  assert.deepEqual(statuses.at(-1), { key: "slate", text: base });
  writing.showStatus = true;
  store.save();
  const withWriting = `${base} ⋅ <dim>writing 0 fail, 0 style / 10 turns</dim>`;
  assert.deepEqual(statuses.at(-1), { key: "slate", text: withWriting });
  store.paused = true;
  store.save();
  assert.deepEqual(statuses.at(-1), {
    key: "slate",
    text: `${label} ⋅ <bold><error>⛔ PAUSED</error></bold> — <warning>run /slate handoff</warning> ⋅ ${cost} ⋅ <dim>writing 0 fail, 0 style / 10 turns</dim>`,
  });
});

function statusThemeFixture(initialTheme: "missing" | "null" | "getter" | "fg") {
  const statuses: Array<string | undefined> = [];
  const notices: Array<{ text: string; type: string }> = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand() {}, registerTool() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
    getActiveTools: () => [], getAllTools: () => [], setActiveTools() {}, appendEntry() {},
  } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  store.orchestratorMode = true;
  let mode = "rpc";
  let notifyFails = false;
  let themeMode: "missing" | "null" | "getter" | "fg" | "good" = initialTheme;
  const ctx = {
    hasUI: true, get mode() { return mode; }, isProjectTrusted: () => true,
    ui: {
      get theme() {
        if (themeMode === "getter") throw new Error("theme failed");
        if (themeMode === "missing") return undefined;
        if (themeMode === "null") return null;
        return {
          fg: (_color: string, text: string) => {
            if (themeMode === "fg") throw new Error("color failed");
            return text;
          },
          bold: (text: string) => text,
        };
      },
      setStatus: (_key: string, text: string | undefined) => { statuses.push(text); },
      notify: (text: string, type: string) => {
        if (notifyFails) throw new Error("notice failed");
        notices.push({ text, type });
      },
      setWidget() {},
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  } as unknown as ExtensionContext;
  registerSlateMode(pi, store,
    { startHandoff: async () => {}, effectiveContextBudget: (window: number) => window },
    () => ({}), () => EMPTY_WORKER_EXTENSION_SET);
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  return {
    statuses, notices, store,
    failNotify() { notifyFails = true; },
    setTheme(value: typeof themeMode) { themeMode = value; },
    async start() {
      // Start in RPC mode to keep the independent summary widget out of these status tests.
      mode = "rpc";
      await sessionStart({}, ctx);
      mode = "tui";
      store.save();
    },
  };
}

const PLAIN_STATUS = "slate: orchestrator ⋅ total $0.0000 (me $0.0000 + workers $0.0000)";

test("TUI status without a theme uses plain text without a warning", async () => {
  for (const missing of ["missing", "null"] as const) {
    const f = statusThemeFixture(missing);
    await f.start();
    assert.equal(f.statuses.at(-1), PLAIN_STATUS);
    f.store.save();
    assert.equal(f.statuses.at(-1), PLAIN_STATUS);
    assert.deepEqual(f.notices, []);
  }
});

test("TUI status catches a throwing theme getter and warns once despite a successful render", async () => {
  const f = statusThemeFixture("getter");
  await f.start();
  assert.equal(f.statuses.at(-1), PLAIN_STATUS);
  f.store.save();
  assert.equal(f.statuses.at(-1), PLAIN_STATUS);
  assert.deepEqual(f.notices, [{
    text: "slate: could not style the status line: Error: theme failed. Slate shows plain text.",
    type: "warning",
  }]);
  f.setTheme("good");
  f.store.save();
  assert.equal(f.statuses.at(-1), "◆ slate orchestrator ⋅ total $0.0000 (me $0.0000 + workers $0.0000)");
  f.setTheme("getter");
  f.store.save();
  assert.equal(f.statuses.at(-1), PLAIN_STATUS);
  assert.equal(f.notices.length, 1);
});

test("TUI status catches a throwing theme fg and warns once", async () => {
  const f = statusThemeFixture("fg");
  await f.start();
  assert.equal(f.statuses.at(-1), PLAIN_STATUS);
  f.store.save();
  assert.equal(f.statuses.at(-1), PLAIN_STATUS);
  assert.deepEqual(f.notices, [{
    text: "slate: could not style the status line: Error: color failed. Slate shows plain text.",
    type: "warning",
  }]);
});

test("TUI status uses the console if its warning notice fails", async () => {
  const f = statusThemeFixture("getter");
  f.failNotify();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    await f.start();
    f.store.save();
    assert.equal(f.statuses.at(-1), PLAIN_STATUS);
    assert.deepEqual(f.notices, []);
    assert.deepEqual(warnings, ["slate: could not style the status line: Error: theme failed. Slate shows plain text."]);
  } finally {
    console.warn = originalWarn;
  }
});

test("TUI status warning re-arms after session_start", async () => {
  const f = statusThemeFixture("getter");
  await f.start();
  f.store.save();
  assert.equal(f.notices.length, 1);
  await f.start();
  assert.equal(f.statuses.at(-1), PLAIN_STATUS);
  assert.deepEqual(f.notices, Array(2).fill({
    text: "slate: could not style the status line: Error: theme failed. Slate shows plain text.",
    type: "warning",
  }));
});

test("threads tool rows render every type and both fallback shapes", async () => {
  const records = caseRecords();
  const { registered } = toolsFixture(records);
  const threadsTool = registered.get("threads");
  assert.ok(threadsTool);

  const result = await threadsTool.execute("call", {}, undefined, undefined, ctx) as {
    content: Array<{ type: string; text: string }>;
  };
  const lines = result.content[0]?.text.split("\n") ?? [];
  assert.equal(lines.length, cases.length);
  for (const [index, entry] of cases.entries()) {
    const thread = records[index];
    assert.ok(thread);
    assert.equal(
      lines[index],
      `${thread.id} "${entry.name}" [cancelled]${entry.marker} — episode: (none) — updated 1970-01-01T00:00:00.001Z`,
    );
  }
});

test("threads listing exposes a sanitized request and model divergence", async () => {
  const thread = record({ id: "t1", status: "successful", episodeId: "t1.e1" });
  const { registered, store } = toolsFixture([thread]);
  store.episodes.set("t1.e1", {
    id: "t1.e1", threadId: "t1", task: "x", status: "ok", file: "/tmp/e",
    reason: "cost\ncheck", requestedModel: "p/requested", requestedEffort: "high",
    model: "p/actual", effort: "medium", createdAt: 1,
  });
  const result = await registered.get("threads")!.execute("call", {}, undefined, undefined, ctx) as { content: Array<{ text: string }> };
  assert.match(result.content[0]?.text ?? "", /requested=p\/requested@high reason="costcheck" last=p\/actual@medium \(different from requested\)/);
  assert.equal((result.content[0]?.text ?? "").includes("\ncheck"), false);

  store.episodes.set("t1.e1", {
    id: "t1.e1", threadId: "t1", task: "x", status: "ok", file: "/tmp/e",
    reason: "visible\u2028forged\u200b", requestedModel: "bad", requestedEffort: "high\u2028forged" as any,
    model: "p/actual", createdAt: 1,
  });
  const hostile = await registered.get("threads")!.execute("call", {}, undefined, undefined, ctx) as { content: Array<{ text: string }> };
  assert.doesNotMatch(hostile.content[0]?.text ?? "", /requested=|@high|\nforged/);
  assert.match(hostile.content[0]?.text ?? "", /reason="visible forged"/);

  store.episodes.set("t1.e1", {
    id: "t1.e1", threadId: "t1", task: "x", status: "ok", file: "/tmp/e",
    requestedModel: "p/same", model: "p/same", createdAt: 1,
  });
  const same = await registered.get("threads")!.execute("call", {}, undefined, undefined, ctx) as { content: Array<{ text: string }> };
  assert.match(same.content[0]?.text ?? "", /requested=p\/same last=p\/same/);
  assert.doesNotMatch(same.content[0]?.text ?? "", /different from requested|reason=/);
});

test("a new dispatch call renders its requested type", () => {
  const { registered } = toolsFixture([]);
  const threadTool = registered.get("thread");
  assert.ok(threadTool?.renderCall);

  const renderedCall = threadTool.renderCall({ name: "fresh", type: "reviewer", task: "Inspect" }, theme);
  assert.equal(firstLine(renderedCall), "thread new:\"fresh\" type=reviewer");
});

test("dispatch call lines render every new thread type", () => {
  const { registered } = toolsFixture([]);
  const threadTool = registered.get("thread");
  assert.ok(threadTool?.renderCall);
  for (const entry of cases) {
    const rendered: { render(width: number): string[] } = threadTool.renderCall({ name: entry.name, type: entry.type, task: "Inspect", model: "fixture", reason: "test fixture" }, theme);
    assert.equal(firstLine(rendered), `thread new:"${entry.name}"${entry.marker} [fixture]`);
  }
});

test("thread tool populates type details for progress and completion", async () => {
  const reviewer = record({ id: "t1", name: "reviewer", type: "reviewer" });
  const { registered } = toolsFixture([reviewer]);
  const threadTool = registered.get("thread");
  assert.ok(threadTool);
  const updates: Array<{
    content?: Array<{ type: string; text?: string }>;
    details?: { type?: string; done?: boolean };
  }> = [];

  const result = await threadTool.execute(
    "call",
    { ...TEST_ROUTE, name: reviewer.name, type: "reviewer", task: "Inspect" },
    undefined,
    (update: {
      content?: Array<{ type: string; text?: string }>;
      details?: { type?: string; done?: boolean };
    }) => updates.push(update),
    ctx,
  ) as { details: { type?: string } };

  assert.equal(updates.length, 2);
  assert.deepEqual(updates.map((update) => update.details?.done), [false, true]);
  assert.deepEqual(updates.map((update) => update.details?.type), ["reviewer", "reviewer"]);
  assert.match(updates[1]?.content?.[0]?.text ?? "", /^\[reviewer\] ok\n/);
  assert.equal(result.details.type, "reviewer");
});

test("dispatch result lines keep the marker through streaming, collapsed, and expanded states", () => {
  initTheme(undefined, false);
  const absentProgress = renderThreadResult(
    { details: { threadName: "absent", done: false } },
    { expanded: false, isPartial: true },
    theme,
  );
  assert.equal(firstLine(absentProgress), "⏳ absent running");

  for (const [type, marker] of [["reviewer", " type=reviewer"], ["general", ""]] as const) {
    const details = { threadName: type, type, episodeId: "t1.e1", status: "ok" as const };
    const progress = renderThreadResult({ details: { ...details, done: false } }, { expanded: false, isPartial: true }, theme);
    assert.equal(firstLine(progress), `⏳ ${type}${marker} running`);

    const completed = renderThreadResult(
      { content: [{ type: "text", text: "" }], details: { ...details, done: true } },
      { expanded: false },
      theme,
    );
    assert.equal(firstLine(completed), `✓ ${type}${marker} t1.e1`);

    const expanded = renderThreadResult(
      { content: [{ type: "text", text: "episode" }], details: { ...details, done: true } },
      { expanded: true },
      theme,
    );
    assert.equal(firstLine(expanded), `✓ ${type}${marker} t1.e1`);
  }
});


test("result rendering normalizes unknown, absent, and malformed stored types", () => {
  initTheme(undefined, false);
  for (const type of [undefined, "future-role", "reviewer\nFORGED"]) {
    const details = { threadName: "safe", type, episodeId: "t1.e1", status: "ok" as const };
    const progress = renderThreadResult(
      { details: { ...details, done: false } },
      { expanded: false, isPartial: true },
      theme,
    );
    const collapsed = renderThreadResult(
      { content: [{ type: "text", text: "" }], details: { ...details, done: true } },
      { expanded: false },
      theme,
    );
    const expanded = renderThreadResult(
      { content: [{ type: "text", text: "episode" }], details: { ...details, done: true } },
      { expanded: true },
      theme,
    );
    assert.equal(firstLine(progress), "⏳ safe running");
    assert.equal(firstLine(collapsed), "✓ safe t1.e1");
    assert.equal(firstLine(expanded), "✓ safe t1.e1");
  }
});

test("failed result lines use failure styling when expanded and collapsed", () => {
  initTheme(undefined, false);
  const taggedTheme: TestTheme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bold: (text) => `<bold>${text}</bold>`,
  };
  const result = {
    content: [{ type: "text", text: "failure details" }],
    details: { threadName: "review", episodeId: "t1.e1", status: "failed", done: true },
  };

  const expanded = firstLine(renderThreadResult(result, { expanded: true }, taggedTheme));
  const collapsed = firstLine(renderThreadResult(result, { expanded: false }, taggedTheme));
  for (const line of [expanded, collapsed]) {
    assert.match(line, /<error>✗<\/error>/);
    assert.match(line, /<error>t1\.e1 FAILED<\/error>/);
  }
});

test("display resolution never consumes the dispatch warning", async () => {
  const unknown = record({ id: "t9", name: "unknown", type: "future-role" as ThreadType });
  const { registered } = toolsFixture([unknown]);
  const threadTool = registered.get("thread");
  const threadsTool = registered.get("threads");
  assert.ok(threadTool?.renderCall);
  assert.ok(threadsTool);

  await threadsTool.execute("call", {}, undefined, undefined, ctx);
  await threadsTool.execute("call", {}, undefined, undefined, ctx);
  threadTool.renderCall({ thread: unknown.id, task: "Inspect" }, theme);
  threadTool.renderCall({ thread: unknown.id, task: "Inspect again" }, theme);
  await threadsTool.execute("call", {}, undefined, undefined, ctx);
  await threadsTool.execute("call", {}, undefined, undefined, ctx);

  const reports: string[] = [];
  assert.equal(effectiveThreadType(unknown, (message) => reports.push(message)), "general");
  assert.equal(effectiveThreadType(unknown, (message) => reports.push(message)), "general");
  assert.deepEqual(reports, ["slate: thread t9 has unrecognised type future-role. Slate is treating it as general."]);
});
