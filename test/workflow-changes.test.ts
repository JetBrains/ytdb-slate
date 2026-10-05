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
import { ThreadManager } from "../extension/threads.ts";
import type { WorkerSession } from "../extension/worker.ts";
import { implementerReportName, readOnlyEarlierLogLine, trackIdentifier } from "../extension/record-names.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
import { createBaseModelTracker } from "../extension/base-model.ts";
import { pathToFileURL } from "node:url";
import type { AgentTool, runToolCall as RunToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";

// Use Pi's pinned core, including prepareArguments, conversion, hooks and error results.
const { runToolCall } = await import(pathToFileURL(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js")).href) as { runToolCall: typeof RunToolCall };

type Tool = { execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
function harness(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "slate-changes-"));
  const project = join(root, "project");
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
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
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) { commands.set(name, command); },
    registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
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
    sessionManager: { getBranch: () => branch, getEntries: () => entries, getSessionId: () => sessionId, getSessionFile: () => undefined },
    ui: { notify: (message: string) => warnings.push(message), setWidget() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  extension(pi as unknown as ExtensionAPI);
  return {
    project, root, tools, warnings, entries, ctx, active: () => active,
    async event(name: string) { for (const handler of events.get(name) ?? []) await handler({}, ctx); },
    async start(reason: string) { for (const handler of events.get("session_start") ?? []) await handler({ reason }, ctx); },
    async doctrine() { const results = await Promise.all((events.get("before_agent_start") ?? []).map((handler) => handler({ systemPrompt: "BASE" }, ctx))); return (results[0] as { systemPrompt: string }).systemPrompt; },
    async action(action: "start" | "close") { return tools.get("slate_change")!.execute("id", { action }, undefined, undefined, ctx); },
    async resume() { await commands.get("slate")!.handler("resume", ctx); },
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

test("change actions retain closed state after a failed start save and restore ownership after a failed close save", { timeout: 1000 }, async (t) => {
  const f = harness(t);
  f.branchTo({ format: "single-action-v1", threads: [], episodes: [], orchestratorMode: true,
    paused: false, workerCostUsd: 0, carriedCostUsd: 0 });
  await f.start("resume");
  await assert.rejects(f.action("close"), /no change is open/);
  f.failNextSave();
  await assert.rejects(f.action("start"), /injected save failure/);
  assert.match(await f.doctrine(), /No change open/);
  await f.action("start");
  const source = f.saved().currentChange!;
  f.branchTo({ ...f.saved(), changeOwnerSessionId: "parent" });
  await f.start("fork");
  const folder = f.saved().currentChange!;
  f.failNextSave();
  await assert.rejects(f.action("close"), /injected save failure/);
  assert.match(await f.doctrine(), new RegExp(`Current research log: slate-changes/${folder}/research-log.md`));
  assert.match(await f.doctrine(), new RegExp(`Read-only source log: slate-changes/${source}/research-log.md`));
  for (const stage of ["save", "reload"]) {
    if (stage === "reload") await f.start("reload");
    await f.resume();
    const saved = f.saved();
    assert.deepEqual([saved.currentChange, saved.sourceChange, saved.changeOwnerSessionId], [folder, source, "successor"], stage);
  }
  await f.action("close");
  assert.equal(f.saved().currentChange, undefined);
  assert.equal(existsSync(join(f.project, "slate-changes", folder, "research-log.md")), true);
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

const reportMethodGroups = [
  ["destination", ["Write no other file under `slate-changes/`."]],
  ["start copy", [
    "Before its first report write in each action, the implementer copies the report to a temporary file outside `slate-changes/`.",
    "For a new report, that copy is an empty file.",
  ]],
  ["append", [
    "The implementer writes each new text to its own temporary file outside `slate-changes/`.",
    "It creates a new report by appending its first temporary file with `>>`.",
    "It appends each temporary file to the report with `>>`.",
  ]],
  ["final check", [
    "After its last write, the implementer checks the whole report once with `cat` and `cmp`.",
    "The report must equal the start copy followed by every appended temporary file in order.",
  ]],
  ["report", ["The implementer reports the check in its final response with the report path, what it compared, and the result."]],
] as const;

function assertReportMethod(task: string) {
  for (const [group, sentences] of reportMethodGroups) {
    assert.ok(task.includes(sentences.join(" ")), `generated ${group} guidance must match the approved method`);
    for (const sentence of sentences) assert.equal(task.split(sentence).length, 2, `${group} sentence must appear once`);
  }
}

test("implementer receives its report path and approved method with and without a source", { timeout: 10000 }, async () => {
  let thread: Tool | undefined;
  let task: string | undefined;
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.currentChange = "change-20261004T000000Z-" + "c".repeat(32);
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
  const call = { name: "implementation", type: "implementer", task: "Make the fix", model: "sol-6.1", reason: "routine" };
  await assert.rejects(thread.execute("id", call, undefined, undefined, {}), /requires trackNumber/);
  const guidanceBytes: number[] = [];
  for (const source of [undefined, "change-20261004T000000Z-" + "d".repeat(32)]) {
    store.sourceChange = source;
    await thread.execute("id", { ...call, trackNumber: 3 }, undefined, undefined, {});
    assert.match(task!, new RegExp(`slate-changes/${store.currentChange}/track-3-implementer-report.md`));
    assert.equal(task!.includes("<number>"), false);
    assertReportMethod(task!);
    if (source) {
      assert.ok(task!.includes(`If the source folder has this track's report, continue it in this new report and name slate-changes/${source}/track-3-implementer-report.md as read-only in the new report's first entry. Do not edit the source report.`));
      assert.ok(task!.includes(`Never write in the read-only source folder \`slate-changes/${source}/\`.`));
    } else {
      assert.doesNotMatch(task!, /If the source folder|read-only source folder/);
    }
    guidanceBytes.push(Buffer.byteLength(task!.slice(call.task.length + 2)));
  }
  assert.deepEqual(guidanceBytes, [995, 1377], "production-rendered report guidance bytes, source absent and present");
});

test("dispatch validates original and changed identifiers through real Pi preparation", { timeout: 10000 }, async () => {
  let definition: AgentTool | undefined;
  const tasks: string[] = [];
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.currentChange = createChangeFolder();
  store.sourceChange = createChangeFolder();
  registerSlateTools({ registerTool(tool: { name: string }) {
    if (tool.name === "thread") definition = tool as unknown as AgentTool;
  } } as unknown as ExtensionAPI, store, () => ({ async dispatch(opts: { task: string }) {
    tasks.push(opts.task);
    return { thread: { id: "t1", name: "test", type: "implementer" },
      episode: { id: "t1.e1", status: "ok", file: "/unused" }, episodeText: "done", warnings: [], usage: {} };
  } }) as unknown as ThreadManager);
  assert.ok(definition);
  const identifierParameter = (definition.parameters as unknown as { properties: { trackNumber: { description: string } } }).properties.trackNumber;
  assert.match(identifierParameter.description, /positive safe integer or canonical dotted path number/);
  assert.match(identifierParameter.description, /At most 128 ASCII characters/);
  assert.match(identifierParameter.description, /Each component is 1 through 9007199254740991, without leading zeros/);
  const tool = { ...definition, execute: (id: string, args: unknown, signal: AbortSignal | undefined, update: unknown) =>
    (definition as unknown as Tool).execute(id, args, signal, update, {}) } as AgentTool;
  const call = { type: "implementer", task: "work", model: "sol-6.1", reason: "test" };
  const invoke = (args: Record<string, unknown>, hook?: (context: any) => Promise<void>) => runToolCall(
    { type: "toolCall", id: "test", name: "thread", arguments: args as never },
    { tools: [tool], context: { messages: [], tools: [tool] }, assistantMessage: {} as never, beforeToolCall: hook ? async (context) => { await hook(context); return undefined; } : undefined },
  );
  const at128 = `${"1.".repeat(56)}1234567890123456`;
  assert.equal(at128.length, 128);
  const at129 = `${"1.".repeat(57)}123456789012345`;
  assert.equal(at129.length, 129);
  const accepted = [1, 3, 105, Number.MAX_SAFE_INTEGER, "1", "1.2", "1.2.3", "9007199254740991", "1.9007199254740991", at128];
  for (const trackNumber of accepted) {
    const result = await invoke({ ...call, trackNumber });
    assert.equal(result.isError, false, JSON.stringify(trackNumber));
    assert.ok(tasks.at(-1)!.includes(`Implementer report: slate-changes/${store.currentChange}/track-${trackNumber}-implementer-report.md.`));
    assert.ok(tasks.at(-1)!.includes(`name slate-changes/${store.sourceChange}/track-${trackNumber}-implementer-report.md as read-only in the new report's first entry. Do not edit the source report.`));
  }
  const rejected = [true, false, null, undefined, 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity,
    "", "0", "01", "01.2", "1.02", "1..2", "1.", ".1", " 1", "1 ", "1\n", "1\u0000", "１", "١", "1/2", "../1", "1\\2", "1e2", "+1", "1-2", "9007199254740992", "1.9007199254740992", at129];
  for (const type of ["implementer", "general"] as const) {
    for (const trackNumber of rejected) {
      const count = tasks.length;
      let hookReached = false;
      const result = await invoke({ ...call, type, trackNumber }, async () => { hookReached = true; });
      assert.equal(result.isError, true, `${type}: ${String(trackNumber)}`);
      assert.match(result.result.content[0]!.type === "text" ? result.result.content[0]!.text : "", /trackNumber/);
      assert.equal(hookReached, false, "invalid original input must stop before the post-conversion hook");
      assert.equal(tasks.length, count, "no rejected value may dispatch");
    }
  }
  assert.equal((await invoke({ ...call, type: "general" })).isError, false, "omission remains valid outside implementation");
  const count = tasks.length;
  assert.equal((await invoke(call)).isError, true, "open implementation needs an identifier");
  for (const changed of ["01.2", true, "1.9007199254740992", at129]) {
    const result = await invoke({ ...call, trackNumber: "1.2" }, async ({ args }) => { args.trackNumber = changed; });
    assert.equal(result.isError, true, "post-validation mutation must be visible");
    assert.equal(tasks.length, count);
  }
  // Change the value between the execute entry check and report-name construction.
  for (const changed of ["01.2", "1\n", "1.9007199254740992", at129]) {
    const args = { ...call, trackNumber: "1.2" };
    Object.defineProperty(args, "type", { get() { args.trackNumber = changed; return "implementer"; } });
    await assert.rejects((definition as unknown as Tool).execute("late", args, undefined, undefined, {}), /trackNumber/);
    assert.equal(tasks.length, count, "report-name check must not trust an earlier validation");
  }
  store.currentChange = undefined;
  assert.equal((await invoke(call)).isError, false, "closed implementation may omit the identifier");
  assert.equal((await invoke({ ...call, trackNumber: null })).isError, true, "closed change still rejects supplied invalid input");
  const maxName = `track-${at128}-implementer-report.md`;
  assert.equal(Buffer.byteLength(maxName), 156);
  assert.equal(Buffer.byteLength(`track-${at128}-research-log.md`), 150);
  assert.ok(Buffer.byteLength(maxName) <= 255);
  const folder = mkdtempSync(join(tmpdir(), "slate-report-name-"));
  try {
    writeFileSync(join(folder, maxName), "report", { flag: "wx" });
    writeFileSync(join(folder, `track-${at128}-research-log.md`), "log", { flag: "wx" });
    assert.equal(readFileSync(join(folder, maxName), "utf8"), "report");
  } finally { rmSync(folder, { recursive: true }); }
  const recursive = readFileSync(join(process.cwd(), "docs/recursive-workflow.md"), "utf8");
  assert.match(recursive, /The identifier has at most 128 characters\./);
  assert.match(recursive, /Each component is at most 9,007,199,254,740,991\./);
  assert.doesNotMatch(recursive, /safe-record\.py|safe-record-recipe/);
});

test("shared identifiers and report names retain exact boundaries", () => {
  const at128 = `${"1.".repeat(56)}1234567890123456`;
  const at129 = `${"1.".repeat(57)}123456789012345`;
  assert.equal(at128.length, 128);
  assert.equal(at129.length, 129);
  for (const value of [1, 105, Number.MAX_SAFE_INTEGER, "1", "1.2.3", "1.9007199254740991", at128]) {
    assert.equal(trackIdentifier(value), String(value));
    assert.equal(implementerReportName(value), `track-${value}-implementer-report.md`);
  }
  for (const value of [null, true, 0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    "", "0", "01", "1.02", "1..2", "1.", ".1", " 1", "1 ", "1\n", "1\r", "1\0", "１", "١",
    "1/2", "../1", "1\\2", "1e2", "+1", "1-2", "9007199254740992", "1.9007199254740992", at129]) {
    assert.throws(() => trackIdentifier(value), /trackNumber/);
    assert.throws(() => implementerReportName(value), /trackNumber/);
  }
});

test("earlier-log helper matches the producer's exact first-line bytes", (t) => {
  const f = harness(t), source = createChangeFolder(), current = createChangeFolder();
  createChangeDirectory(f.project, source);
  createChangeDirectory(f.project, current, source);
  const bytes = readFileSync(join(f.project, "slate-changes", current, "research-log.md"));
  assert.deepEqual(bytes.subarray(0, bytes.indexOf(10)), Buffer.from(readOnlyEarlierLogLine(source)));
  assert.equal(readOnlyEarlierLogLine(source), `Read-only earlier log: slate-changes/${source}/research-log.md`);
  assert.throws(() => readOnlyEarlierLogLine("../source"), /valid change folder/);
});

for (const event of ["session_start", "session_shutdown"]) {
  test(`index ${event} joins an ordinary worker operation before a folder fork`, { timeout: 1000 }, async (t) => {
    const f = harness(t), original = createChangeFolder();
    createChangeDirectory(f.project, original);
    f.branchTo({ format: "single-action-v1", threads: [], episodes: [], currentChange: original,
      changeOwnerSessionId: "successor", orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 });
    await f.start("startup");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const dispatch = ThreadManager.prototype.dispatch;
    ThreadManager.prototype.dispatch = async function () {
      const operation = (async () => { entered(); await gate; })();
      (this as unknown as { live: Map<string, WorkerSession> }).live.set("held", {
        abort: async () => {}, shutdownWorker: async () => { await operation; },
      } as unknown as WorkerSession);
      await operation;
      throw new Error("held operation finished");
    };
    const worker = f.tools.get("thread")!.execute("held", { type: "general", task: "held ordinary work", model: "sol-6.1", reason: "fixture" }, undefined, undefined, f.ctx).catch((error: Error) => error);
    await started;
    f.session("fork-owner");
    let finished = false;
    const transfer = f.event(event).then(() => { finished = true; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(finished, false, "index must await manager.disposeAll");
      assert.equal(existsSync(join(f.project, "slate-changes", original, "research-log.md")), true);
      assert.equal(f.entries.length, 0, "the fork must not be saved while the worker operation runs");
    } finally { release(); await worker; await transfer; ThreadManager.prototype.dispatch = dispatch; }
    if (event === "session_shutdown") await f.start("fork");
    assert.notEqual(f.saved().currentChange, original);
    assert.equal(f.saved().sourceChange, original);
    assert.equal(f.saved().changeOwnerSessionId, "fork-owner");
  });
}

for (const reject of [false, true]) {
  test(`handoff ${reject ? "rejects idle cancellation without replacement" : "awaits ordinary worker idle before replacement"}`, { timeout: 1000 }, async (t) => {
    const f = harness(t), store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
    const hooks = registerSlateHandoff({ on() {}, registerCommand() {} } as unknown as ExtensionAPI, store, () => ({}), () => createBaseModelTracker({ warn() {} }));
    let release!: () => void;
    const operation = new Promise<void>((resolve) => { release = resolve; });
    let replacements = 0;
    const transfer = hooks.startHandoff({ ...f.ctx,
      waitForIdle: async () => { await operation; if (reject) throw new Error("idle cancelled"); },
      newSession: async () => { replacements++; return { cancelled: true }; },
    } as any);
    const outcome = reject ? assert.rejects(transfer, /idle cancelled/) : transfer;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(replacements, 0, "replacement must wait for the worker operation");
    } finally { release(); await outcome; }
    assert.equal(replacements, reject ? 0 : 1);
  });
}

test("startup preserves planted versions and temporary record bytes across resume, fork and handoff", { timeout: 1000 }, async (t) => {
  const f = harness(t), folder = createChangeFolder();
  createChangeDirectory(f.project, folder);
  const directory = join(f.project, "slate-changes", folder);
  mkdirSync(join(directory, "versions"));
  const files = ["versions/status.v1.md", "versions/root-design.v2.md", ".slate-record-candidate", ".slate-record-version"];
  const bytes = files.map((name, index) => { const value = Buffer.from([0, index, 255, 10]); writeFileSync(join(directory, name), value); return value; });
  const state: SlateSnapshot = { format: "single-action-v1", threads: [], episodes: [], currentChange: folder,
    changeOwnerSessionId: "successor", orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0 };
  for (const reason of ["startup", "resume", "fork", "handoff"]) {
    f.branchTo(state);
    if (reason === "fork") f.session("fork-owner");
    if (reason === "handoff") { f.session("successor"); f.handoff(state); }
    await f.start(reason);
    files.forEach((name, index) => assert.deepEqual(readFileSync(join(directory, name)), bytes[index], `${reason}: ${name}`));
  }
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
