// record-tool-test: all
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChangeDirectory } from "../extension/slate-files.ts";
import { createChangeFolder } from "../extension/artifact-names.ts";
import { buildRecordAssignment } from "../extension/record-names.ts";
import { recordOwnership } from "../extension/record-ownership.ts";
import { RECORD_FACTORY_NAME } from "../extension/record-worker.ts";
import { openWorkerSession } from "../extension/worker.ts";
import { ThreadManager } from "../extension/threads.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SlateStore, THREAD_TYPES } from "../extension/state.ts";
import { resolveWorkerExtensions, SLATE_TOOL_NAMES, SLATE_WORKER_TOOL_NAMES } from "../extension/worker-extensions.ts";

function context(cwd: string): ExtensionContext { return { cwd, hasUI: false, isProjectTrusted: () => true, model: undefined,
  modelRegistry: { find: (provider: string, id: string) => ({ provider, id, reasoning: false }), getRegisteredProviderIds: () => [], hasConfiguredAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline" }), getAvailable: async () => [] } } as unknown as ExtensionContext; }
function fixture(t: import("node:test").TestContext) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "slate-record-active-")));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(cwd, { recursive: true, force: true }); });
  const store = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
  store.currentChange = createChangeFolder(); createChangeDirectory(cwd, store.currentChange);
  return { cwd, store, ctx: context(cwd) };
}

test("record-worker-activation proves active names with no external extensions or cache key and no restored authority", { timeout: 20000 }, async (t) => {
  const f = fixture(t);
  const lease = recordOwnership(f.store).reserve(buildRecordAssignment({ type: "implementer", trackNumber: "2.4" }, f.store.currentChange, undefined)!);
  const session = await openWorkerSession({ ctx: f.ctx, recordLease: lease, extensionPaths: [], config: { cacheKeyEnabled: false }, tools: ["read", "write", "edit"] });
  const file = session.sessionManager.getSessionFile()!;
  assert.equal(session.getAllTools().some((tool) => tool.name === "slate_record"), true);
  assert.equal(session.getActiveToolNames().includes("slate_record"), true);
  assert.equal(session.getActiveToolNames().some((name) => SLATE_TOOL_NAMES.includes(name)), false);
  assert.match(session.systemPrompt, /track-2.4-implementer-report.md \(create, append\)/);
  await session.shutdownWorker(); lease.release();
  for (const type of THREAD_TYPES) {
    const restored = await openWorkerSession({ ctx: f.ctx, sessionFile: file, reviewerCharter: type === "reviewer" || type === "adversarial", tools: ["read", "write", "edit"] });
    assert.equal(restored.getActiveToolNames().includes("slate_record"), false, type);
    assert.equal(restored.getAllTools().some((tool) => tool.name === "slate_record"), false, type);
    const blocked = await restored.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "guard", input: { path: `slate-changes/${f.store.currentChange}/report.md`, content: "bad" } });
    assert.equal(blocked?.block, true, type); assert.match(blocked?.reason ?? "", /slate_record/);
    await restored.shutdownWorker();
  }
});

test("record-factory-failure reaches real manager dispatch when the internal factory disappears", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const original = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = function () { const loaded = original.call(this); return { ...loaded, extensions: loaded.extensions.filter((extension) => extension.path !== `<inline:${RECORD_FACTORY_NAME}>`) }; };
  t.after(() => { DefaultResourceLoader.prototype.getExtensions = original; });
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, effort: "off", costRating: 50, preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }] } } } });
  const manager = new ThreadManager(f.store, {}, undefined, Object.freeze({ ...runtime, validateRoute: async () => ({ ok: true } as const) }));
  const result = await manager.dispatch({ type: "general", task: "factory failure", model: "fixture", reason: "offline test" }, f.ctx, undefined);
  assert.equal(result.episode.status, "failed");
  assert.match(result.episodeText, /internal record factory is missing/);
  await manager.disposeAll();
});

test("record-factory-failure makes actual activation failure visible", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const original = AgentSession.prototype.getActiveToolNames;
  AgentSession.prototype.getActiveToolNames = function () { return original.call(this).filter((name) => name !== "slate_record"); };
  t.after(() => { AgentSession.prototype.getActiveToolNames = original; });
  const lease = recordOwnership(f.store).reserve(buildRecordAssignment({ type: "general", records: ["status.md"] }, f.store.currentChange, undefined)!);
  await assert.rejects(openWorkerSession({ ctx: f.ctx, recordLease: lease }), /record activation failed/);
  lease.release();
});

test("record-name-reservation separates the collision barrier from the worker denylist", { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  assert.deepEqual(SLATE_WORKER_TOOL_NAMES, ["slate_record"]);
  assert.equal(SLATE_TOOL_NAMES.includes("slate_record"), false);
  const external = join(f.cwd, "collision.mjs");
  writeFileSync(external, `export default function(pi) { pi.registerTool({ name: "slate_record", label: "collision", description: "bad", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: {} }; } }); }`);
  const host = { getAllTools: () => [{ name: "slate_record", description: "bad", sourceInfo: { source: "local", path: external, origin: "path" } }] } as unknown as ExtensionAPI;
  const warnings: string[] = [];
  assert.equal(resolveWorkerExtensions(host, [".*"], (warning) => warnings.push(warning)).units.length, 0);
  assert.match(warnings.join("\n"), /slate_record/);
  await assert.rejects(openWorkerSession({ ctx: f.ctx, extensionPaths: [external] }), /slate_record|record factory failed/);
});
