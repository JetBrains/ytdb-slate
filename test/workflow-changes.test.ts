import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extension/index.ts";
import { createChangeFolder, isChangeFolder } from "../extension/artifact-names.ts";
import { createChangeDirectory } from "../extension/slate-files.ts";
import { ADOPTED_SNAPSHOT_FIELDS, SlateStore, type SlateSnapshot } from "../extension/state.ts";
import { registerSlateTools } from "../extension/tools.ts";
import type { ThreadManager } from "../extension/threads.ts";

type Tool = { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
function harness(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "slate-changes-"));
  const project = join(root, "project");
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const tools = new Map<string, Tool>();
  const warnings: string[] = [];
  let active = ["read", "thread", "slate_change"];
  let branch: Array<{ type: "custom"; customType: string; data: SlateSnapshot }> = [];
  const entries: typeof branch = [];
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerCommand() {}, registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
    getActiveTools: () => active,
    setActiveTools(names: string[]) { active = names; },
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    getThinkingLevel: () => undefined, sendMessage() {},
    appendEntry(name: string, data: SlateSnapshot) {
      const entry = { type: "custom" as const, customType: name, data: structuredClone(data) };
      entries.push(entry); branch.push(entry);
    },
  };
  const ctx = {
    cwd: project, mode: "rpc", hasUI: true, model: undefined, modelRegistry: {},
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => branch, getEntries: () => entries, getSessionId: () => "successor" },
    ui: { notify: (message: string) => warnings.push(message), setWidget() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  extension(pi as unknown as ExtensionAPI);
  return {
    project, root, tools, warnings, entries, ctx, active: () => active,
    async start(reason: string) { for (const handler of events.get("session_start") ?? []) await handler({ reason }, ctx); },
    async doctrine() { const results = await Promise.all((events.get("before_agent_start") ?? []).map((handler) => handler({ systemPrompt: "BASE" }, ctx))); return (results[0] as { systemPrompt: string }).systemPrompt; },
    async action(action: "start" | "close") { return tools.get("slate_change")!.execute("id", { action }, undefined, undefined, ctx); },
    saved() { return entries.at(-1)!.data; },
    branchTo(snapshot: SlateSnapshot) { branch = [{ type: "custom", customType: "slate-state", data: snapshot }]; },
    handoff(snapshot: SlateSnapshot) {
      branch = [{ type: "custom", customType: "slate-handoff", data: { sessionId: "successor", snapshot } as unknown as SlateSnapshot }];
    },
  };
}

test("start, close, resume, reload and handoff preserve one visible change without deletion", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  await f.start("startup");
  assert.ok(!f.active().includes("slate_change"), "mode off hides the action");
  await assert.rejects(f.action("start"), /requires orchestrator mode/);
  const snapshot = f.saved.bind(f);
  // Enable the saved orchestrator mode through a restored snapshot.
  f.branchTo({ format: "single-action-v1", threads: [], episodes: [], orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 });
  await f.start("reload");
  assert.ok(f.active().includes("slate_change"));
  const result = await f.action("start");
  const name = snapshot().currentChange!;
  assert.ok(isChangeFolder(name));
  assert.match(result.content[0]!.text, new RegExp(name));
  const log = join(f.project, "slate-changes", name, "research-log.md");
  assert.equal(readFileSync(log, "utf8"), "# Research log\n");
  assert.match(await f.doctrine(), new RegExp(`slate-changes/${name}/track-<number>-implementer-report.md`));
  await assert.rejects(f.action("start"), /close the current change/);
  for (const reason of ["resume", "reload", "startup"]) {
    await f.start(reason);
    assert.equal(snapshot().currentChange, name, `${reason} continues the folder`);
  }
  const handoff = structuredClone(snapshot());
  f.branchTo(handoff);
  await f.start("startup");
  assert.equal(snapshot().currentChange, name, "saved successor state continues the folder");
  await f.action("close");
  assert.equal(snapshot().currentChange, undefined);
  assert.equal(existsSync(log), true, "close deletes nothing");
  await f.start("resume");
  assert.equal((await f.doctrine()).includes(`current research log: slate-changes/${name}`), false);
});

test("real session_start fork creates a new folder with a read-only source entry and inherited history", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const first = createChangeFolder();
  createChangeDirectory(f.project, first);
  const base: SlateSnapshot = { format: "single-action-v1", threads: [], episodes: [], currentChange: first, orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
  f.branchTo(base);
  await f.start("fork");
  const second = f.saved().currentChange!;
  assert.notEqual(second, first);
  assert.equal(readFileSync(join(f.project, "slate-changes", second, "research-log.md"), "utf8"), `Read-only earlier log: slate-changes/${first}/research-log.md\n`);
  assert.deepEqual(f.saved().earlierChanges, [first]);
  await f.start("fork");
  assert.notEqual(f.saved().currentChange, second);
  assert.deepEqual(f.saved().earlierChanges, [first, second]);
  const doctrine = await f.doctrine();
  for (const name of [first, second]) assert.match(doctrine, new RegExp(`Read-only earlier log: slate-changes/${name}/research-log.md`));
  assert.equal(readFileSync(join(f.project, "slate-changes", first, "research-log.md"), "utf8"), "# Research log\n");
});

test("real handoff session_start adopts and saves the same current change", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const folder = createChangeFolder();
  createChangeDirectory(f.project, folder);
  f.handoff({ format: "single-action-v1", threads: [], episodes: [], currentChange: folder,
    orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 });
  await f.start("startup");
  assert.equal(f.saved().currentChange, folder);
  assert.equal(f.saved().paused, true);
  assert.equal(readFileSync(join(f.project, "slate-changes", folder, "research-log.md"), "utf8"), "# Research log\n");
});

test("hostile snapshot and fork source names are refused, reported, and never used", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const bad: SlateSnapshot = { format: "single-action-v1", threads: [], episodes: [], currentChange: "../outside", earlierChanges: ["change-20260230T000000Z-" + "0".repeat(32)], orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
  f.branchTo(bad);
  await f.start("fork");
  assert.ok(f.warnings.some((s) => s.includes("invalid currentChange")));
  assert.ok(f.warnings.some((s) => s.includes("earlier change folder")));
  assert.equal(f.entries.length, 0, "invalid fork source creates no new save");
  assert.match(await f.doctrine(), /No change is open/);
  assert.equal(existsSync(join(f.project, "slate-changes")), false);
});

test("change creation refuses a symbolic-link directory component", (t) => {
  const f = harness(t);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.project, "slate-changes"));
  assert.throws(() => createChangeDirectory(f.project, createChangeFolder()), /symbolic link/);
  assert.equal(existsSync(join(f.root, "outside", "research-log.md")), false);
});

test("the real change tool refuses a linked parent and creates no outside file", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.project, "slate-changes"));
  f.branchTo({ format: "single-action-v1", threads: [], episodes: [], orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 });
  await f.start("resume");
  await assert.rejects(f.action("start"), /symbolic link/);
  assert.equal(f.entries.length, 0);
  assert.deepEqual(lstatSync(join(f.project, "slate-changes")).isSymbolicLink(), true);
});

test("folder grammar rejects malformed, calendar-invalid, traversal and runtime names", () => {
  const generated = createChangeFolder();
  assert.equal(isChangeFolder(generated), true);
  for (const candidate of ["../other", "change-20260230T123456Z-" + "a".repeat(32), "change-20260101T123456Z-" + "G".repeat(32), "runtime-20260101T123456Z-" + "a".repeat(32), generated + "/log"])
    assert.equal(isChangeFolder(candidate), false, candidate);
  assert.deepEqual(Object.keys(ADOPTED_SNAPSHOT_FIELDS), ["format", "threads", "episodes", "threadSeq", "currentChange", "earlierChanges", "orchestratorMode", "paused", "workerCostUsd", "carriedCostUsd"]);
});

test("implementer receives its exact report name in the dispatch text", async () => {
  let thread: Tool | undefined;
  let task: string | undefined;
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.currentChange = createChangeFolder();
  registerSlateTools({ registerTool(tool: Tool & { name: string }) { if (tool.name === "thread") thread = tool; } } as unknown as ExtensionAPI,
    store, () => ({ async dispatch(opts: { task: string }) {
      task = opts.task;
      return {
        thread: { id: "t1", name: "implementation", type: "implementer" },
        episode: { id: "t1.e1", status: "ok", file: "/unused" },
        episodeText: "done", warnings: [], usage: {},
      };
    } }) as unknown as ThreadManager);
  assert.ok(thread);
  const call = { name: "implementation", type: "implementer", task: "Make the fix", model: "sol-6", reason: "routine" };
  await assert.rejects(thread.execute("id", call, undefined, undefined, {}), /requires a positive safe trackNumber/);
  await thread.execute("id", { ...call, trackNumber: 3 }, undefined, undefined, {});
  assert.match(task!, new RegExp(`slate-changes/${store.currentChange}/track-3-implementer-report.md`));
  assert.equal(task!.includes("<number>"), false);
});

test("legacy root research log is only named as read-only earlier input", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  writeFileSync(join(f.project, "research-log.md"), "legacy bytes");
  const state: SlateSnapshot = { format: "single-action-v1", threads: [], episodes: [], orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
  f.branchTo(state);
  await f.start("resume");
  assert.match(await f.doctrine(), /Read-only earlier log: research-log.md \(legacy root file\)/);
  await f.action("start");
  assert.equal(readFileSync(join(f.project, "research-log.md"), "utf8"), "legacy bytes");
});
