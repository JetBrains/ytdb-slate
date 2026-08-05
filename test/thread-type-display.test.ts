import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSlateMode, renderThreadWidgetLine } from "../extension/mode.ts";
import { renderThreadResult } from "../extension/render.ts";
import { effectiveThreadType, SlateStore, type ThreadRecord, type ThreadType } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import { registerSlateTools } from "../extension/tools.ts";
import type { ThreadManager } from "../extension/threads.ts";

function record(overrides: Partial<ThreadRecord>): ThreadRecord {
  return {
    id: "t1",
    name: "worker",
    sessionFile: "",
    status: "idle",
    episodeIds: [],
    episodeSeq: 0,
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
  { name: "absent", type: undefined, marker: "" },
  { name: "unknown", type: "future-role" as ThreadType, marker: "" },
];

function caseRecords(): ThreadRecord[] {
  return cases.map((entry, index) => record({ id: `t${index + 1}`, name: entry.name, type: entry.type }));
}

function firstLine(component: { render(width: number): string[] }): string {
  return component.render(200)[0]?.trimEnd() ?? "";
}

test("widget thread lines render every type and both fallback shapes", () => {
  const records = caseRecords();
  for (const [index, entry] of cases.entries()) {
    const thread = records[index];
    assert.ok(thread);
    assert.equal(
      renderThreadWidgetLine(thread),
      `  · ${thread.id} ${entry.name} [idle]${entry.marker} 0 episodes`,
    );
  }
});

test("widget thread lines distinguish a running thread with one episode", () => {
  const running = record({ status: "running", episodeIds: ["t1.e1"] });
  assert.equal(renderThreadWidgetLine(running), "  ⏳ t1 worker [running] 1 episode");
});

test("mode refresh publishes all stored thread widget lines", async () => {
  const appended: unknown[] = [];
  const widgets: string[][] = [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    registerCommand() {},
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
  store.threads.set("t1", record({ id: "t1", status: "running", episodeIds: ["t1.e1"] }));
  registerSlateMode(
    pi,
    store,
    { startHandoff: async () => {}, effectiveContextBudget: (window: number) => window },
    () => ({}),
    () => EMPTY_WORKER_EXTENSION_SET,
  );
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  await sessionStart({}, {
    hasUI: true,
    mode: "rpc",
    ui: {
      setWidget: (_id: string, lines: string[] | undefined) => { if (lines) widgets.push(lines); },
      setStatus() {},
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  } as unknown as ExtensionContext);
  assert.deepEqual(widgets.at(-1), [
    "slate ⋅ orchestrator mode ⋅ 1 thread",
    "  total $0.0000 (me $0.0000 + workers $0.0000)",
    "  ⏳ t1 worker [running] 1 episode",
  ]);
  assert.equal(appended.length, 0);
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
      `${thread.id} "${entry.name}" [idle]${entry.marker} — episodes: (none) — updated 1970-01-01T00:00:00.001Z`,
    );
  }
});

test("a new dispatch call renders its requested type", () => {
  const { registered } = toolsFixture([]);
  const threadTool = registered.get("thread");
  assert.ok(threadTool?.renderCall);

  const renderedCall = threadTool.renderCall({ name: "fresh", type: "reviewer", task: "Inspect" }, theme);
  assert.equal(firstLine(renderedCall), "thread new:\"fresh\" type=reviewer");
});

test("dispatch call lines render every type, both fallback shapes, and a legacy correction", () => {
  const records = caseRecords();
  const { registered } = toolsFixture(records);
  const threadTool = registered.get("thread");
  assert.ok(threadTool?.renderCall);

  for (const [index, entry] of cases.entries()) {
    const thread = records[index];
    assert.ok(thread);
    const renderedCall: { render(width: number): string[] } = threadTool.renderCall(
      { thread: thread.id, task: "Inspect", model: "p/m", effort: "high" },
      theme,
    );
    assert.equal(firstLine(renderedCall), `thread ${thread.id}${entry.marker} [p/m @high]`);
  }

  const correctable = records.find((thread) => thread.name === "unknown");
  assert.ok(correctable);
  const corrected = threadTool.renderCall({ thread: correctable.id, type: "reviewer", task: "Inspect" }, theme);
  assert.equal(firstLine(corrected), `thread ${correctable.id} type=reviewer`);

  const immutable = records.find((thread) => thread.name === "reviewer");
  assert.ok(immutable);
  const unknownArgument = threadTool.renderCall({ thread: immutable.id, type: "future-role", task: "Inspect" }, theme);
  assert.equal(firstLine(unknownArgument), `thread ${immutable.id} type=reviewer`);
  const conflictingArgument = threadTool.renderCall({ thread: immutable.id, type: "adversarial", task: "Inspect" }, theme);
  assert.equal(firstLine(conflictingArgument), `thread ${immutable.id} type=reviewer`);
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
    { thread: reviewer.id, type: "reviewer", task: "Inspect" },
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

  renderThreadWidgetLine(unknown);
  renderThreadWidgetLine(unknown);
  threadTool.renderCall({ thread: unknown.id, task: "Inspect" }, theme);
  threadTool.renderCall({ thread: unknown.id, task: "Inspect again" }, theme);
  await threadsTool.execute("call", {}, undefined, undefined, ctx);
  await threadsTool.execute("call", {}, undefined, undefined, ctx);

  const reports: string[] = [];
  assert.equal(effectiveThreadType(unknown, (message) => reports.push(message)), "general");
  assert.equal(effectiveThreadType(unknown, (message) => reports.push(message)), "general");
  assert.deepEqual(reports, ["slate: thread t9 has unrecognised type future-role. Slate is treating it as general."]);
});
