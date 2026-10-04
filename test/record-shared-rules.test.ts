import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { convertToLlm, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentTool, runAgentLoop as RunAgentLoop, runToolCall as RunToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import {
  buildRecordAssignment, implementerReportName, matchesReadOnlyEarlierLogLine, readOnlyEarlierLogLine,
  recordNameRule, RECORD_NAME_RULES, trackIdentifier, validateRecordsInput,
} from "../extension/record-names.ts";
import { createChangeDirectory } from "../extension/slate-files.ts";
import { ADOPTED_SNAPSHOT_FIELDS, ADOPTED_THREAD_FIELDS, SlateStore, type SlateSnapshot, type ThreadRecord } from "../extension/state.ts";
import { ThreadManager, type DispatchOptions, type DispatchResult } from "../extension/threads.ts";
import { registerSlateTools } from "../extension/tools.ts";

const { runAgentLoop, runToolCall } = await import(pathToFileURL(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js")).href) as { runAgentLoop: typeof RunAgentLoop; runToolCall: typeof RunToolCall };
const at128 = `${"1.".repeat(56)}1234567890123456`;
const at129 = `${"1.".repeat(57)}123456789012345`;
const badIdentifiers = ["", "0", "01", "1.02", "1..2", "1.", ".1", " 1", "1 ", "1\n", "1\r", "1\0", "１", "١", "1/2", "../1", "1\\2", "1e2", "+1", "1-2", "9007199254740992", "1.9007199254740992", at129];

function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "slate-record-rules-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const snapshots: SlateSnapshot[] = [];
  const store = new SlateStore({ appendEntry(_name: string, data: SlateSnapshot) { snapshots.push(structuredClone(data)); } } as unknown as ExtensionAPI);
  store.currentChange = createChangeFolder();
  createChangeDirectory(cwd, store.currentChange);
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }] } } } });
  const manager = new ThreadManager(store, {}, undefined, Object.freeze({ ...runtime, validateRoute: async () => ({ ok: true } as const) }));
  const actions: DispatchOptions[] = [];
  // Stop at the admitted action. This track does not activate workers.
  (manager as unknown as { runDispatch(thread: ThreadRecord, opts: DispatchOptions): Promise<DispatchResult> }).runDispatch = async (thread, opts) => {
    actions.push(opts);
    return { thread, episode: { id: `${thread.id}.e1`, threadId: thread.id, task: opts.task, status: "ok", file: "/unused", createdAt: 1 },
      episodeText: "done", warnings: [], usage: { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 } };
  };
  const tools: AgentTool[] = [];
  registerSlateTools({ registerTool(tool: AgentTool) { tools.push(tool); } } as unknown as ExtensionAPI, store, () => manager);
  const definition = tools.find((tool) => tool.name === "thread")!;
  const ctx = { cwd } as ExtensionContext;
  const execute = (args: unknown) => (definition as unknown as { execute(...args: unknown[]): Promise<unknown> }).execute("direct", args, undefined, undefined, ctx);
  const tool = { ...definition, execute: (id: string, args: unknown, signal: AbortSignal | undefined, update: unknown) =>
    (definition as unknown as { execute(...args: unknown[]): Promise<unknown> }).execute(id, args, signal, update, ctx) } as AgentTool;
  const invoke = (args: Record<string, unknown>, hook?: (args: Record<string, unknown>) => void | Promise<void>) => runToolCall(
    { type: "toolCall", id: "host", name: "thread", arguments: args as never },
    { tools: [tool], context: { messages: [], tools: [tool] }, assistantMessage: {} as never,
      beforeToolCall: hook ? async ({ args }) => { await hook(args as Record<string, unknown>); return undefined; } : undefined },
  );
  return { store, actions, snapshots, tools, definition, tool, invoke, execute, ctx };
}
const call = { type: "general", task: "work", model: "fixture", reason: "test" };
function errorText(result: Awaited<ReturnType<typeof runToolCall>>) {
  return result.result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function schemaRejection(t: TestContext, args: Record<string, unknown>) {
  const f = fixture(t);
  const session = SessionManager.create(f.ctx.cwd, join(f.ctx.cwd, "sessions"));
  const requests: TranscriptContext[] = [];
  const model: Model<"openai-completions"> = {
    id: "offline", name: "offline", provider: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:9",
    reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let reachedHook = false;
  const messages = await runAgentLoop([{ role: "user", content: "check schema", timestamp: 1 }],
    { messages: [], tools: [f.tool] }, {
      model, convertToLlm,
      beforeToolCall: async () => { reachedHook = true; return undefined; },
    }, (event) => {
      if (event.type === "message_end" && (event.message.role === "system" || event.message.role === "user" ||
        event.message.role === "assistant" || event.message.role === "toolResult")) session.appendMessage(event.message);
    }, undefined, (_model, context) => {
      requests.push(structuredClone(context));
      const first = requests.length === 1;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 2,
        content: first ? [{ type: "toolCall", id: "schema-rejection", name: "thread", arguments: args as never }]
          : [{ type: "text", text: "done" }],
        stopReason: first ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    });
  assert.equal(requests.length, 2, "the real loop must reach the continuation provider request");
  assert.equal(reachedHook, false, "schema rejection must precede the hook");
  assert.equal(f.actions.length, 0);
  assert.equal(f.store.threads.size, 0);
  const result = messages.find((message) => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, true);
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const persisted = SessionManager.open(session.getSessionFile()!).buildSessionContext().messages;
  const savedResult = persisted.find((message) => message.role === "toolResult");
  const replayedResult = requests[1]!.messages.find((message) => message.role === "toolResult");
  assert.deepEqual(savedResult, JSON.parse(JSON.stringify(result)), "the file-backed session must preserve the rejection");
  assert.deepEqual(replayedResult, result, "the continuation provider must receive the rejection");
  return { text, transcript: readFileSync(session.getSessionFile()!, "utf8"), request: requests[1]! };
}

for (const [label, selection] of [["with records", { records: ["status.md"] }], ["without records", {}]] as const) {
  test(`schema rejection ${label} keeps the witness out of errors, saved transcripts, and provider requests`, { timeout: 10000 }, async (t) => {
    const args = { type: "general", model: "fixture", reason: "test", ...selection };
    const result = await schemaRejection(t, args);
    assert.match(result.text, /Validation failed for tool "thread"/);
    assert.match(result.text, /task:/);
    assert.equal(result.text.includes("__slateRecordsInputWitness"), false);
    assert.equal(result.transcript.includes("__slateRecordsInputWitness"), false);
    assert.equal(JSON.stringify(result.request).includes("__slateRecordsInputWitness"), false);
    assert.deepEqual(JSON.parse(result.text.split("Received arguments:\n")[1]!), args);
  });
}

test("schema rejection without records retains byte-identical errors from 9c27716", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  // Exact diagnostic prefixes for calls without records.
  for (const [args, detail] of [
    [{ type: "general", model: "fixture", reason: "test" }, "task: must have required properties task"],
    [{ ...call, task: {} }, "task: must be string"],
    [{ ...call, task: {}, toJSON: "caller data" }, "task: must be string"],
    [{ ...call, reason: "x".repeat(201) }, "reason: must not have more than 200 characters"],
  ] as const) {
    const result = await f.invoke(args);
    assert.equal(result.isError, true);
    assert.equal(errorText(result), `Validation failed for tool "thread":\n  - ${detail}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`);
  }
  assert.equal(f.actions.length, 0);
  assert.equal(f.store.threads.size, 0);
});

test("records preparation serializes original input while Pi cloning preserves the witness", (t) => {
  const f = fixture(t);
  const args = { ...call, records: ["status.md"] };
  const prepared = f.definition.prepareArguments!(args);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), args);
  assert.equal(Object.getOwnPropertyDescriptor(prepared, "toJSON")?.enumerable, false);
  const clone = structuredClone(prepared);
  assert.ok(clone && typeof clone === "object" && "__slateRecordsInputWitness" in clone);
  assert.equal(Object.prototype.hasOwnProperty.call(clone, "toJSON"), false);
  assert.equal(clone.__slateRecordsInputWitness, '["status.md"]');
  assert.equal(Object.prototype.hasOwnProperty.call(args, "toJSON"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(args, "__slateRecordsInputWitness"), false);
});

test("record-name agreement includes exact classes, roles, modes, and identifier bounds", () => {
  assert.equal(at128.length, 128);
  assert.equal(at129.length, 129);
  const expected = [
    ["research-log.md", "research-log", "record-only", ["append"]],
    ["track-1.2-research-log.md", "research-log", "record-only", ["create", "append"]],
    ["track-1.2-implementer-report.md", "implementer-report", "implementer", ["create", "append"]],
    ["status.md", "status", "record-only", ["create", "replace"]],
    ["root-design.md", "design", "record-only", ["create", "replace"]],
    ["track-1.2-design.md", "design", "record-only", ["create", "replace"]],
  ] as const;
  assert.equal(RECORD_NAME_RULES.length, expected.length);
  for (const [name, recordClass, writerRole, modes] of expected) {
    const rule = recordNameRule(name);
    assert.ok(rule, name);
    assert.equal(rule.recordClass, recordClass);
    assert.equal(rule.writerRole, writerRole);
    assert.deepEqual(rule.modes, modes);
  }
  for (const value of [1, 105, Number.MAX_SAFE_INTEGER, "1", "1.2.3", "1.9007199254740991", at128]) {
    const name = implementerReportName(value);
    assert.equal(name, `track-${value}-implementer-report.md`);
    assert.equal(recordNameRule(name)?.writerRole, "implementer");
    for (const suffix of ["design", "research-log"]) assert.ok(recordNameRule(`track-${trackIdentifier(value)}-${suffix}.md`));
  }
  for (const identifier of badIdentifiers) {
    assert.throws(() => implementerReportName(identifier), /trackNumber/);
    for (const suffix of ["design", "research-log", "implementer-report"]) assert.equal(recordNameRule(`track-${identifier}-${suffix}.md`), undefined);
  }
  for (const name of [null, 1, "", "other.md", "Research-log.md", "status.md\n", "root-design.md ", "./status.md", "../status.md", "folder/status.md", "folder\\status.md", "track-1-fix-1-design.md"]) {
    assert.equal(recordNameRule(name), undefined, String(name));
  }
});

test("record-read-only line agrees with the real producer and compares bytes exactly", (t) => {
  const root = mkdtempSync(join(tmpdir(), "slate-record-line-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = createChangeFolder();
  const current = createChangeFolder();
  createChangeDirectory(root, source);
  createChangeDirectory(root, current, source);
  const bytes = readFileSync(join(root, "slate-changes", current, "research-log.md"));
  const firstLine = bytes.subarray(0, bytes.indexOf(10));
  assert.equal(readOnlyEarlierLogLine(source), `Read-only earlier log: slate-changes/${source}/research-log.md`);
  assert.equal(matchesReadOnlyEarlierLogLine(firstLine, source), true);
  assert.equal(matchesReadOnlyEarlierLogLine(firstLine, current), false);
  for (const text of [readOnlyEarlierLogLine(source) + "\r", readOnlyEarlierLogLine(source) + "\n", " " + readOnlyEarlierLogLine(source), readOnlyEarlierLogLine(source).replace("Read-only", "Read only"), "# Research log"]) {
    assert.equal(matchesReadOnlyEarlierLogLine(Buffer.from(text), source), false, text);
  }
  assert.throws(() => readOnlyEarlierLogLine("../source"), /valid change folder/);
});

test("records rejects original values before real Pi conversion, hooks, or dispatch", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const invalid = [undefined, null, true, false, 1, "status.md", { 0: "status.md", length: 1 }, [], ["status.md", "status.md"], [null], [1], [true], ["track-1.2-implementer-report.md"], ["status.md "], ["status.md\n"], ["./status.md"], ["../status.md"], ["slate-changes/x/status.md"], ["track-01-design.md"], ["track-1.9007199254740992-design.md"], [`track-${at129}-design.md`], ["other.md"], Array(1)];
  for (const records of invalid) {
    let reachedHook = false;
    const result = await f.invoke({ ...call, records }, () => { reachedHook = true; });
    assert.equal(result.isError, true, JSON.stringify(records));
    assert.match(errorText(result), /records/);
    assert.equal(reachedHook, false, "the original invalid value must stop before conversion hooks");
    assert.equal(f.actions.length, 0);
    assert.equal(f.store.threads.size, 0);
  }
});

test("records requires general type, no trackNumber, and validated current and source facts", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  for (const type of ["implementer", "reviewer", "researcher", "planner", "adversarial", undefined]) {
    const result = await f.invoke({ ...call, type, records: ["status.md"] });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /records requires type general without trackNumber/);
  }
  assert.equal((await f.invoke({ ...call, trackNumber: "1.2", records: ["status.md"] })).isError, true);
  await assert.rejects(f.execute({ ...call, trackNumber: undefined, records: ["status.md"] }), /trackNumber must be/);
  assert.throws(() => buildRecordAssignment({ ...call, trackNumber: undefined, records: ["status.md"] }, f.store.currentChange, undefined), /without trackNumber/);
  const current = f.store.currentChange;
  for (const folder of [undefined, "", "../outside", "change-20260230T000000Z-" + "0".repeat(32)]) {
    f.store.currentChange = folder;
    const result = await f.invoke({ ...call, records: ["status.md"] });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /open change with a valid folder/);
  }
  f.store.currentChange = current;
  for (const source of [current, "../source", ""]) {
    f.store.sourceChange = source;
    const result = await f.invoke({ ...call, records: ["status.md"] });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /read-only source folder/);
  }
  assert.equal(f.actions.length, 0);
  assert.equal(f.store.threads.size, 0);
});

test("records rechecks changed assignment values before dispatch", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  for (const changed of [null, "status.md", [], ["status.md", "status.md"], ["status.md "], ["track-1-implementer-report.md"]]) {
    const result = await f.invoke({ ...call, records: ["status.md"] }, (args) => { args.records = changed; });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /records/);
  }
  // Mutate after the execute entry check, while parsing the thread type.
  const args = { ...call, records: ["status.md"] };
  let reads = 0;
  Object.defineProperty(args, "type", { get() { if (++reads === 2) args.records = ["track-1-implementer-report.md"]; return "general"; } });
  await assert.rejects(f.execute(args), /records accepts research-log\.md/);
  const result = await f.invoke({ ...call, records: ["status.md"] }, () => { f.store.sourceChange = f.store.currentChange; });
  assert.equal(result.isError, true);
  assert.match(errorText(result), /read-only source folder/);
  assert.equal(f.actions.length, 0);
  assert.equal(f.store.threads.size, 0);
});

for (const [label, mutate] of [
  ["deletion", (args: Record<string, unknown>) => { delete args.records; }],
  ["valid subset", (args: Record<string, unknown>) => { args.records = ["status.md"]; }],
  ["valid substitution", (args: Record<string, unknown>) => { args.records = ["status.md", "root-design.md"]; }],
  ["addition", (args: Record<string, unknown>) => { (args.records as string[]).push("root-design.md"); }],
  ["reorder", (args: Record<string, unknown>) => { (args.records as string[]).reverse(); }],
] as const) {
  test(`records reports ${label} after real Pi validation before dispatch`, { timeout: 10000 }, async (t) => {
    const f = fixture(t);
    const result = await f.invoke({ ...call, records: ["status.md", "research-log.md"] }, mutate);
    assert.equal(result.isError, true);
    assert.match(errorText(result), /records changed after the original input check/);
    assert.equal(f.actions.length, 0);
    assert.equal(f.store.threads.size, 0);
  });
}

test("records reports an added selection when the original field is absent", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const result = await f.invoke(call, (args) => { args.records = ["status.md"]; });
  assert.equal(result.isError, true);
  assert.match(errorText(result), /records changed after the original input check/);
  assert.equal(f.actions.length, 0);
  assert.equal(f.store.threads.size, 0);
});

test("records compares direct entry values with the names used for assignment", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  for (const changed of [undefined, ["status.md"], ["status.md", "root-design.md"], ["research-log.md", "status.md"]]) {
    const args: Record<string, unknown> = { ...call, records: ["status.md", "research-log.md"] };
    let reads = 0;
    Object.defineProperty(args, "type", { get() {
      if (++reads === 2) {
        if (changed === undefined) delete args.records;
        else args.records = changed;
      }
      return "general";
    } });
    await assert.rejects(f.execute(args), /records changed after the original input check/);
  }
  assert.equal(f.actions.length, 0);
  assert.equal(f.store.threads.size, 0);
});

test("records preparation replaces caller-supplied witness values without changing original arguments", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const args = { ...call, records: ["status.md"], __slateRecordsInputWitness: "null" };
  assert.equal((await f.invoke(args)).isError, false);
  assert.equal(args.__slateRecordsInputWitness, "null");
  assert.deepEqual(f.actions[0]!.recordAssignment?.names, ["status.md"]);
  assert.equal((await f.invoke({ ...call, __slateRecordsInputWitness: '["status.md"]' })).isError, false);
  assert.equal(f.actions.at(-1)!.recordAssignment, undefined);
});

test("records keeps each witness local across interleaved real Pi calls", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const first = f.invoke({ ...call, records: ["status.md", "research-log.md"] }, async () => { entered(); await waiting; });
  await ready;
  const second = await f.invoke({ ...call, records: ["root-design.md"] });
  release();
  assert.equal(second.isError, false);
  assert.equal((await first).isError, false);
  assert.deepEqual(f.actions.map((action) => action.recordAssignment?.names), [["root-design.md"], ["status.md", "research-log.md"]]);
  assert.equal((await f.invoke(call)).isError, false);
  assert.equal(f.actions.at(-1)!.recordAssignment, undefined);
});

test("records duplicate validation avoids repeated array scans and keeps no length limit", () => {
  const names = Array.from({ length: 4000 }, (_, i) => `track-${i + 1}-design.md`);
  const current = createChangeFolder();
  const includes = Array.prototype.includes;
  // Trap scans of accepted names, not scans inside the fixed name-rule table.
  Array.prototype.includes = function (value: unknown, fromIndex?: number): boolean {
    if (typeof value === "string" && /^track-[0-9]+-design\.md$/.test(value)) throw new Error("repeated name scan");
    return includes.call(this, value, fromIndex);
  };
  try {
    const accepted = validateRecordsInput({ ...call, records: names }, current, undefined);
    assert.equal(accepted?.length, names.length);
    assert.throws(() => validateRecordsInput({ ...call, records: [...names, names[0]] }, current, undefined), /duplicate names/);
  } finally {
    Array.prototype.includes = includes;
  }
});

test("records rejection lists exact filename forms and explains number and path rules", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const result = await f.invoke({ ...call, records: ["design.md"] });
  assert.equal(result.isError, true);
  assert.equal(errorText(result), "records accepts research-log.md, track-<number>-research-log.md, status.md, root-design.md, or track-<number>-design.md. Use the trackNumber rules for <number>. Names must not contain paths.");
  assert.equal(f.actions.length, 0);
});

test("records reaches an immutable action-local assignment and never saved authority", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const names = ["research-log.md", "track-2.1-research-log.md", "status.md", "root-design.md", "track-2-design.md", `track-${at128}-design.md`];
  const result = await f.invoke({ ...call, records: names });
  assert.equal(result.isError, false);
  const assignment = f.actions[0]!.recordAssignment;
  assert.deepEqual(assignment, { currentFolder: `slate-changes/${f.store.currentChange}`, writerRole: "record-only", names });
  assert.equal(f.actions[0]!.task, "work", "no dispatch guidance changes in this track");
  assert.equal("__slateRecordsInputWitness" in f.actions[0]!, false);
  names.push("other.md");
  assert.equal(assignment!.names.includes("other.md"), false);
  assert.ok(Object.isFrozen(assignment));
  assert.ok(Object.isFrozen(assignment!.names));
  assert.equal(f.tools.some((tool) => tool.name === "slate_record"), false);
  assert.equal("recordAssignment" in ADOPTED_THREAD_FIELDS, false);
  assert.equal("recordAssignment" in ADOPTED_SNAPSHOT_FIELDS, false);
  for (const snapshot of f.snapshots) {
    assert.equal(JSON.stringify(snapshot).includes("recordAssignment"), false);
    assert.equal(JSON.stringify(snapshot).includes("__slateRecordsInputWitness"), false);
  }
  const forged = { ...f.snapshots.at(-1)!, recordAssignment: assignment };
  forged.threads = forged.threads.map((thread) => ({ ...thread, recordAssignment: assignment }));
  f.store.adoptSnapshot(forged, f.ctx);
  assert.equal("recordAssignment" in f.store, false);
  assert.equal("recordAssignment" in f.store.threads.get("t1")!, false);
  await f.invoke(call);
  assert.equal(f.actions.at(-1)!.recordAssignment, undefined, "a restored action cannot reuse assignment authority");
});

test("implementer assignment and dispatch use one report name while existing calls stay unchanged", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  f.store.sourceChange = createChangeFolder();
  for (const trackNumber of [3, Number.MAX_SAFE_INTEGER, "2.1", at128]) {
    const result = await f.invoke({ ...call, type: "implementer", trackNumber });
    assert.equal(result.isError, false);
    const action = f.actions.at(-1)!;
    const name = implementerReportName(trackNumber);
    assert.equal(name, `track-${trackNumber}-implementer-report.md`);
    assert.deepEqual(action.recordAssignment, { currentFolder: `slate-changes/${f.store.currentChange}`, writerRole: "implementer", names: [name] });
    assert.equal(action.task, `work\n\nImplementer report: slate-changes/${f.store.currentChange}/${name}. Use slate_record to create this report and append later entries. If the source folder has this track's report, continue it in this new report and name slate-changes/${f.store.sourceChange}/${name} as read-only in the new report's first entry. Do not edit the source report.`);
  }
  for (const type of ["general", "reviewer", "researcher", "adversarial"]) {
    assert.equal((await f.invoke({ ...call, type })).isError, false);
    assert.equal(f.actions.at(-1)!.recordAssignment, undefined);
    assert.equal(f.actions.at(-1)!.task, "work");
  }
  f.store.currentChange = undefined;
  f.store.sourceChange = undefined;
  assert.equal((await f.invoke({ ...call, type: "implementer" })).isError, false);
  assert.equal(f.actions.at(-1)!.recordAssignment, undefined);
  assert.equal(f.actions.at(-1)!.task, "work");
  assert.equal(buildRecordAssignment(call, undefined, undefined), undefined);
});
