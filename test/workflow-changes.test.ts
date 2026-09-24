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
  let sessionId = "successor";
  let failSave = false;
  let failNextSave = false;
  let hasUI = true;
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { events.set(name, [...(events.get(name) ?? []), handler]); },
    registerCommand() {}, registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
    getActiveTools: () => active,
    setActiveTools(names: string[]) { active = names; },
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    getThinkingLevel: () => undefined, sendMessage() {},
    appendEntry(name: string, data: SlateSnapshot) {
      if (failSave || failNextSave) { failNextSave = false; throw new Error("injected save failure"); }
      const entry = { type: "custom" as const, customType: name, data: structuredClone(data) };
      entries.push(entry); branch.push(entry);
    },
  };
  const ctx = {
    cwd: project, mode: "rpc", get hasUI() { return hasUI; }, model: undefined, modelRegistry: {},
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => branch, getEntries: () => entries, getSessionId: () => sessionId },
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
    session(id: string) { sessionId = id; },
    failSaves(value: boolean) { failSave = value; },
    failNextSave() { failNextSave = true; },
    headless() { hasUI = false; },
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
  assert.equal(snapshot().changeOwnerSessionId, "successor");
  assert.match(result.content[0]!.text, new RegExp(name));
  const log = join(f.project, "slate-changes", name, "research-log.md");
  assert.equal(readFileSync(log, "utf8"), "# Research log\n");
  assert.match(await f.doctrine(), new RegExp(`Current research log: slate-changes/${name}/research-log.md`));
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
  assert.equal((await f.doctrine()).includes(`Current research log: slate-changes/${name}`), false);
});

test("session ownership isolates forks and copied parent history after tree movement", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const first = createChangeFolder();
  createChangeDirectory(f.project, first);
  const base: SlateSnapshot = { format: "single-action-v1", threads: [], episodes: [], currentChange: first, changeOwnerSessionId: "parent", orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
  f.branchTo(base);
  await f.start("fork");
  const second = f.saved().currentChange!;
  assert.notEqual(second, first);
  assert.equal(f.saved().changeOwnerSessionId, "successor");
  assert.equal(readFileSync(join(f.project, "slate-changes", second, "research-log.md"), "utf8"), `Read-only earlier log: slate-changes/${first}/research-log.md\n`);
  assert.equal(f.saved().sourceChange, first);
  f.branchTo(base); // /tree selects inherited history before the fork's own state entry.
  await f.start("reload");
  const third = f.saved().currentChange!;
  assert.notEqual(third, first);
  assert.notEqual(third, second, "tree reload creates its own folder");
  assert.equal(f.entries.length, 2, "tree reload persists the new ownership");
  assert.match(await f.doctrine(), new RegExp(`Current research log: slate-changes/${third}/research-log.md`));
  assert.equal(f.saved().sourceChange, first);
  f.session("later-fork");
  f.branchTo(f.saved());
  await f.start("fork");
  assert.equal(f.saved().sourceChange, third);
  assert.equal(readFileSync(join(f.project, "slate-changes", f.saved().currentChange!, "research-log.md"), "utf8"), `Read-only earlier log: slate-changes/${third}/research-log.md\n`);
  const doctrine = await f.doctrine();
  assert.match(doctrine, new RegExp(`Read-only source log: slate-changes/${third}/research-log.md`));
  assert.doesNotMatch(doctrine, new RegExp(`Read-only source log: slate-changes/${first}/research-log.md`));
  assert.equal(readFileSync(join(f.project, "slate-changes", first, "research-log.md"), "utf8"), "# Research log\n");
});

test("failed ownership allocation persists no open change across reload", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const source = createChangeFolder();
  const base: SlateSnapshot = { format: "single-action-v1", threads: [], episodes: [], currentChange: source,
    changeOwnerSessionId: "parent", orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
  f.branchTo(base);
  writeFileSync(join(f.project, "slate-changes"), "blocked");
  await f.start("fork");
  assert.equal(f.saved().currentChange, undefined, "failure saves closed state");
  assert.match(f.warnings.join("\n"), /No change is open/);
  rmSync(join(f.project, "slate-changes"));
  await f.start("reload");
  assert.match(await f.doctrine(), /No change open/);
  assert.equal(f.saved().currentChange, undefined, "reload cannot reopen the source");
  assert.equal(existsSync(join(f.project, "slate-changes", source)), false);
});

test("failed first ownership save persists the closed state", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const source = createChangeFolder();
  createChangeDirectory(f.project, source);
  f.branchTo({ format: "single-action-v1", threads: [], episodes: [], currentChange: source,
    changeOwnerSessionId: "parent", orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 });
  f.failNextSave();
  await f.start("fork");
  assert.equal(f.saved().currentChange, undefined);
  assert.match(f.warnings.join("\n"), /injected save failure/);
  await f.start("reload");
  assert.match(await f.doctrine(), /No change open/);
});

test("failed cleanup save reports a second warning", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const source = createChangeFolder();
  f.branchTo({ format: "single-action-v1", threads: [], episodes: [], currentChange: source,
    changeOwnerSessionId: "parent", orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 });
  writeFileSync(join(f.project, "slate-changes"), "blocked");
  f.failSaves(true);
  await f.start("fork");
  assert.match(f.warnings.join("\n"), /could not persist the closed change/);
  assert.match(await f.doctrine(), /No change open/);
});

test("same session id continues a change and missing or invalid owners allocate", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const first = createChangeFolder();
  createChangeDirectory(f.project, first);
  const base: SlateSnapshot = { format: "single-action-v1", threads: [], episodes: [], currentChange: first,
    changeOwnerSessionId: "successor", orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
  f.branchTo(base);
  for (const reason of ["resume", "reload", "startup"]) {
    await f.start(reason);
    assert.equal((await f.doctrine()).includes(`Current research log: slate-changes/${first}/`), true);
    assert.equal(f.entries.length, 0, "matching owner does not allocate or save");
  }
  for (const owner of [undefined, "", 12] as unknown[]) {
    f.branchTo({ ...base, changeOwnerSessionId: owner as string });
    await f.start("reload");
    assert.notEqual(f.saved().currentChange, first);
    assert.equal(f.saved().sourceChange, first);
    assert.equal(f.saved().changeOwnerSessionId, "successor");
  }
});

test("headless invalid names and owner have a diagnostic", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  f.headless();
  f.branchTo({ format: "single-action-v1", threads: [], episodes: [], currentChange: "../bad",
    sourceChange: "../also-bad", changeOwnerSessionId: "", orchestratorMode: true,
    paused: false, workerCostUsd: 0, carriedCostUsd: 0 });
  const messages: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => { messages.push(message); };
  try { await f.start("reload"); } finally { console.warn = warn; }
  assert.match(messages.join("\n"), /invalid currentChange/);
  assert.match(messages.join("\n"), /invalid sourceChange/);
  assert.match(messages.join("\n"), /invalid changeOwnerSessionId/);
});

test("real handoff session_start adopts and saves the same current change", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const folder = createChangeFolder();
  createChangeDirectory(f.project, folder);
  f.handoff({ format: "single-action-v1", threads: [], episodes: [], currentChange: folder,
    orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 });
  await f.start("startup");
  assert.equal(f.saved().currentChange, folder);
  assert.equal(f.saved().changeOwnerSessionId, "successor");
  assert.equal(f.saved().paused, true);
  await f.start("reload");
  assert.equal(f.saved().currentChange, folder, "handoff successor continues the folder");
  assert.equal(readFileSync(join(f.project, "slate-changes", folder, "research-log.md"), "utf8"), "# Research log\n");
});

test("hostile snapshot and fork source names are refused, reported, and never used", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  const bad: SlateSnapshot = { format: "single-action-v1", threads: [], episodes: [], currentChange: "../outside", sourceChange: "change-20260230T000000Z-" + "0".repeat(32), orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
  f.branchTo(bad);
  await f.start("fork");
  assert.ok(f.warnings.some((s) => s.includes("invalid currentChange")));
  assert.ok(f.warnings.some((s) => s.includes("sourceChange")));
  assert.equal(f.entries.length, 0, "invalid fork source creates no new save");
  assert.match(await f.doctrine(), /No change open\. Use slate_change start/);
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
  assert.deepEqual(Object.keys(ADOPTED_SNAPSHOT_FIELDS), ["format", "threads", "episodes", "threadSeq", "currentChange", "changeOwnerSessionId", "sourceChange", "orchestratorMode", "paused", "workerCostUsd", "carriedCostUsd"]);
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
  store.sourceChange = createChangeFolder();
  await thread.execute("id", { ...call, trackNumber: 3 }, undefined, undefined, {});
  assert.equal(task!, `Make the fix\n\nImplementer report: slate-changes/${store.currentChange}/track-3-implementer-report.md. Create without following a symbolic link. If the source folder has this track's report, continue it in this new report and name slate-changes/${store.sourceChange}/track-3-implementer-report.md as read-only in the new report's first entry. Do not edit the source report.`);
});

test("legacy root research log is only named as read-only earlier input", { timeout: 10000 }, async (t) => {
  const f = harness(t);
  writeFileSync(join(f.project, "research-log.md"), "legacy bytes");
  const state: SlateSnapshot = { format: "single-action-v1", threads: [], episodes: [], orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
  f.branchTo(state);
  await f.start("resume");
  assert.match(await f.doctrine(), /Read-only legacy root log: research-log.md/);
  await f.action("start");
  assert.equal(readFileSync(join(f.project, "research-log.md"), "utf8"), "legacy bytes");
});
