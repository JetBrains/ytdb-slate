import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
	CURRENT_SESSION_VERSION, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI,
	type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createBaseModelTracker, type BaseModelTracker } from "../extension/base-model.ts";
import { SlateStore } from "../extension/state.ts";
import { writeProjectModel } from "../extension/startup-summary.ts";

const trackers: BaseModelTracker[] = [];
let observations = 0;
export const captureTracker: typeof createBaseModelTracker = (deps) => {
	const real = createBaseModelTracker(deps);
	const tracker = { ...real, observe(...args: Parameters<BaseModelTracker["observe"]>) {
		observations++;
		real.observe(...args);
	} };
	trackers.push(tracker);
	return tracker;
};

// Capture each real tracker from the entry point without replacing its reducer.
const entry = new URL("../extension/index.ts", import.meta.url).href;
const trackerModule = `data:text/javascript,${encodeURIComponent(`export { captureTracker as createBaseModelTracker } from ${JSON.stringify(import.meta.url)}; export { readLiveEffort } from ${JSON.stringify(new URL("../extension/base-model.ts", import.meta.url).href)};`)}`;
async function loadSlate() {
	const hook = registerHooks({ resolve(specifier, context, nextResolve) {
		if (context.parentURL === entry && specifier === "./base-model.ts") return { url: trackerModule, shortCircuit: true };
		return nextResolve(specifier, context);
	} });
	try { return (await import("../extension/index.ts")).default; }
	finally { hook.deregister(); }
}

const provider = "project-model-fixture";
const stored = `${provider}/stored`;
const initial = `${provider}/initial`;
const notice = (level: ThinkingLevel) => `slate: Applied private project model ${stored} with thinking level ${level}.`;
const timeout = { timeout: 10000 };

async function fixture(t: TestContext, orchestratorModeDefault: boolean,
	sessionCase: boolean | "reopened-fork" | "damaged-message" = false) {
	const slate = await loadSlate();
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "slate-project-model-entry-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	const originalAgent = process.env.PI_CODING_AGENT_DIR;
	const argv = process.argv;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.argv = argv.slice(0, 2);
	t.after(() => {
		if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgent;
		process.argv = argv;
	});
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: "initial" }));
	writeFileSync(join(agentDir, "slate.json"), JSON.stringify({
		orchestratorModeDefault,
		router: { models: { include: [], add: [
			{ model: "initial-model", providers: { [provider]: "initial" }, preferredProvider: provider, effort: "low", capabilityRating: 40, costRating: 40, guidelines: [], cautions: [] },
			{ model: "stored-model", providers: { [provider]: "stored" }, preferredProvider: provider, effort: "medium", capabilityRating: 40, costRating: 40, guidelines: [], cautions: [] },
		] } },
	}));
	const save = (thinkingLevel: ThinkingLevel) => writeProjectModel(cwd, { model: stored, thinkingLevel });
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
		modelsStorePath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
	modelRuntime.registerProvider(provider, {
		api: "project-model-fixture-api", baseUrl: "http://127.0.0.1:9", apiKey: "fixture",
		models: ["initial", "stored"].map((id) => ({ id, name: id, reasoning: true, input: ["text"],
			contextWindow: 100_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
		streamSimple: () => assert.fail("startup must not request a provider stream"),
	});
	const notices: Array<[string, string]> = [];
	const events: string[] = [];
	const errors: unknown[] = [];
	let startModel = "initial";
	let startLevel: ThinkingLevel = "low";
	let mode: ExtensionContext["mode"] = "tui";
	let failAppend = false;
	let appendAttempts = 0;
	let redirect = false;
	const reasons: string[] = [];
	let manager = SessionManager.inMemory(cwd);
	if (sessionCase) {
		const source = join(cwd, "source.jsonl");
		const sessions = join(cwd, "sessions");
		const timestamp = new Date().toISOString();
		const header = { type: "session", version: CURRENT_SESSION_VERSION, id: "source", timestamp, cwd };
		const writeSession = (file: string, entries: unknown[]) =>
			writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		if (sessionCase === "damaged-message") {
			writeSession(source, [header,
				{ type: "thinking_level_change", id: "root", parentId: null, timestamp, thinkingLevel: "low" },
				{ type: "message", id: "damaged", parentId: "root", timestamp, message: null },
				{ type: "thinking_level_change", id: "leaf", parentId: "root", timestamp, thinkingLevel: "low" },
			]);
			manager = SessionManager.open(source, sessions);
			assert.equal(manager.getLeafId(), "leaf");
			assert.deepEqual(manager.getEntries().find((entry) => entry.id === "damaged"),
				{ type: "message", id: "damaged", parentId: "root", timestamp, message: null });
			assert.deepEqual(manager.buildSessionContext().messages, []);
		} else {
			writeSession(source, [header]);
			// Pi uses forkFrom before it creates the initial runtime.
			manager = SessionManager.forkFrom(source, cwd, sessions);
			if (sessionCase === "reopened-fork") {
				const child = manager.getSessionFile()!;
				process.argv.push("--session", child);
				manager = SessionManager.open(child, sessions);
			} else {
				process.argv.push("--fork", source);
			}
			assert.equal(manager.getHeader()?.parentSession, source);
			assert.deepEqual(manager.getEntries(), []);
		}
	}
	const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime,
			settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "minimal" }, { projectTrusted: true }),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: [slate, (pi) => {
					pi.on("session_start", (event) => { reasons.push(event.reason); });
					pi.on("model_select", async (event) => {
						events.push(event.model.id);
						if (redirect && event.model.id === "stored") {
							await pi.setModel(modelRuntime.getModel(provider, "initial")!);
						}
					});
				}],
			},
		});
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
			model: modelRuntime.getModel(provider, startModel), thinkingLevel: startLevel });
		if (failAppend) t.mock.method(sessionManager, "appendModelChange", () => {
			appendAttempts++;
			assert.equal(created.session.model?.id, "stored");
			throw new Error("injected session append failure");
		});
		return { ...created, services, diagnostics: services.diagnostics };
	}, { cwd, agentDir, sessionManager: manager });
	t.after(() => runtime.dispose());
	const ui = { notify: (message: string, style: string) => { notices.push([message, style]); } };
	const bind = (session: AgentSession) => session.bindExtensions({ mode,
		onError: (error) => errors.push(error),
		uiContext: { notify: ui.notify,
			setWidget() {}, setStatus() {}, onTerminalInput: () => () => {} } as unknown as ExtensionUIContext,
	});
	runtime.setRebindSession(bind);
	return { runtime, bind: () => bind(runtime.session), notices, events, errors, reasons, save, ui,
		redirect() { redirect = true; },
		setInitial(model: string, level: ThinkingLevel) { startModel = model; startLevel = level; },
		setMode(value: typeof mode) { mode = value; },
		selectStored: () => runtime.session.setModel(modelRuntime.getModel(provider, "stored")!),
		failAppend() { failAppend = true; }, appendAttempts: () => appendAttempts,
	};
}

function tracked() {
	const tracker = trackers.at(-1)!;
	return [tracker.current(), tracker.currentEffort(), tracker.currentLogicalIdentity()];
}

for (const enabled of [false, true]) {
	test(`private project startup matches a Pi start on the same state with orchestrator mode ${enabled ? "on" : "off"}`, timeout, async (t) => {
		const f = await fixture(t, enabled);
		f.save("max");
		const baselineReads = t.mock.method(SettingsManager.prototype, "getGlobalSettings", () => {
			assert.fail("private project switch entered the global settings guard");
		});
		const modelWrites = t.mock.method(SettingsManager.prototype, "setDefaultModelAndProvider", () => assert.fail("persisted model"));
		const effortWrites = t.mock.method(SettingsManager.prototype, "setDefaultThinkingLevel", () => assert.fail("persisted thinking level"));
		const before = observations;
		await f.bind();
		assert.deepEqual(f.errors, []);
		assert.deepEqual(f.events, ["stored"]);
		assert.equal(observations, before, "the real nested model_select must not enter the tracker");
		assert.equal(baselineReads.mock.callCount(), 0);
		assert.equal(modelWrites.mock.callCount(), 0);
		assert.equal(effortWrites.mock.callCount(), 0);
		baselineReads.mock.restore();
		assert.deepEqual(f.notices, [[notice("high"), "info"],
			["slate: Requested thinking level max differs from the effective thinking level high.", "warning"]]);
		const applied = tracked();
		assert.deepEqual(applied, [stored, "high", "stored-model"]);
		assert.equal(f.runtime.session.getActiveToolNames().includes("slate_change"), enabled);
		f.notices.length = 0;
		f.setInitial("stored", "high");
		process.argv.push("--model", stored);
		await f.runtime.newSession();
		assert.deepEqual(tracked(), applied);
		assert.deepEqual(f.events, ["stored"]);
		assert.deepEqual(f.notices, []);
		assert.deepEqual(f.errors, []);
	});
}

test("Pi starts an empty command-line fork without applying the preference but applies it on /new", timeout, async (t) => {
	const f = await fixture(t, false, true);
	f.save("medium");
	await f.bind();
	assert.deepEqual(f.reasons, ["startup"]);
	assert.deepEqual(tracked(), [initial, "low", "initial-model"]);
	assert.deepEqual(f.events, []);
	assert.deepEqual(f.notices, []);
	assert.equal((await f.runtime.newSession()).cancelled, false);
	assert.deepEqual(f.reasons, ["startup", "new"]);
	assert.deepEqual(tracked(), [stored, "medium", "stored-model"]);
	assert.deepEqual(f.events, ["stored"]);
	assert.deepEqual(f.notices, [[notice("medium"), "info"]]);
	assert.deepEqual(f.errors, []);
});

test("reopening an empty fork child keeps the Pi selection", timeout, async (t) => {
	const f = await fixture(t, false, "reopened-fork");
	f.save("medium");
	await f.bind();
	assert.deepEqual(f.reasons, ["startup"]);
	assert.deepEqual(tracked(), [initial, "low", "initial-model"]);
	assert.deepEqual(f.events, []);
	assert.deepEqual(f.notices, []);
	assert.deepEqual(f.errors, []);
});

test("a null message on an inactive branch excludes application without aborting startup", timeout, async (t) => {
	const f = await fixture(t, false, "damaged-message");
	f.save("medium");
	await f.bind();
	assert.deepEqual(f.errors, []);
	assert.deepEqual(tracked(), [initial, "low", "initial-model"]);
	assert.deepEqual(f.events, []);
	assert.deepEqual(f.notices, []);
});

const unexpectedWarning = "slate: Slate could not complete private project model application. The session keeps its live model and thinking level.";

test("an unexpected error before switching warns once and still seeds the live model", timeout, async (t) => {
	const f = await fixture(t, false);
	f.save("medium");
	t.mock.method(ModelRegistry.prototype, "find", () => { throw new Error("injected lookup failure"); });
	await f.bind();
	assert.deepEqual(f.errors, []);
	assert.deepEqual(tracked(), [initial, "low", "initial-model"]);
	assert.deepEqual(f.events, []);
	assert.deepEqual(f.notices, [[unexpectedWarning, "warning"]]);
});

test("a failed startup notice falls back to the console with the same text and keeps the switched model", timeout, async (t) => {
	const f = await fixture(t, false);
	f.save("medium");
	const notify = t.mock.method(f.ui, "notify", () => { throw new Error("injected UI failure"); });
	const info = t.mock.method(console, "info", () => {});
	const warn = t.mock.method(console, "warn", () => {});
	await f.bind();
	assert.deepEqual(f.errors, []);
	assert.deepEqual(tracked(), [stored, "medium", "stored-model"]);
	assert.deepEqual(notify.mock.calls.map(({ arguments: args }) => args), [[notice("medium"), "info"]]);
	assert.deepEqual(info.mock.calls.map(({ arguments: args }) => args), [[notice("medium")]]);
	assert.equal(warn.mock.callCount(), 0);
});

test("both reporting channels can fail on the unexpected warning without stopping startup", timeout, async (t) => {
	const f = await fixture(t, false);
	f.save("medium");
	const lookup = t.mock.method(ModelRegistry.prototype, "find", () => { throw new Error("injected lookup failure"); });
	const notify = t.mock.method(f.ui, "notify", () => { throw new Error("injected UI failure"); });
	const warn = t.mock.method(console, "warn", () => { throw new Error("injected console failure"); });
	const restore = t.mock.method(SlateStore.prototype, "restore");
	const before = observations;
	await f.bind();
	lookup.mock.restore();
	const seed = tracked();
	await f.selectStored();
	assert.equal(observations, before + 1);
	assert.deepEqual(f.events, ["stored"]);
	assert.deepEqual(seed, [initial, "low", "initial-model"]);
	assert.equal(restore.mock.callCount(), 1);
	assert.deepEqual(f.errors, []);
	assert.deepEqual(notify.mock.calls.map(({ arguments: args }) => args), [[unexpectedWarning, "warning"]]);
	assert.deepEqual(warn.mock.calls.map(({ arguments: args }) => args), [[unexpectedWarning]]);
});

test("both reporting channels can fail on the success notice without losing the switched model", timeout, async (t) => {
	const f = await fixture(t, false);
	f.save("medium");
	const notify = t.mock.method(f.ui, "notify", () => { throw new Error("injected UI failure"); });
	const info = t.mock.method(console, "info", () => { throw new Error("injected console failure"); });
	const warn = t.mock.method(console, "warn", () => { throw new Error("injected console failure"); });
	await f.bind();
	assert.deepEqual(f.events, ["stored"]);
	assert.deepEqual(tracked(), [stored, "medium", "stored-model"]);
	assert.deepEqual(f.errors, []);
	assert.deepEqual(notify.mock.calls.map(({ arguments: args }) => args), [[notice("medium"), "info"]]);
	assert.deepEqual(info.mock.calls.map(({ arguments: args }) => args), [[notice("medium")]]);
	assert.equal(warn.mock.callCount(), 0);
});

test("a queued redirect warning is not sent twice when the notice interface throws", timeout, async (t) => {
	const f = await fixture(t, false);
	f.save("medium");
	f.redirect();
	const enqueue = f.ui.notify;
	t.mock.method(f.ui, "notify", (message: string, severity: string) => {
		enqueue(message, severity);
		throw new Error("injected UI failure after enqueue");
	});
	const warn = t.mock.method(console, "warn", () => {});
	await f.bind();
	const message = `slate: Private project model switch failed. The session now uses ${initial} with thinking level minimal. The requested thinking level was medium.`;
	assert.deepEqual(f.notices, [[message, "warning"]]);
	assert.deepEqual(warn.mock.calls.map(({ arguments: args }) => args), [[message]]);
	assert.deepEqual(tracked(), [initial, "minimal", "initial-model"]);
	assert.deepEqual(f.errors, []);
});

test("a failed warning about an append failure falls back to the console with the same text", timeout, async (t) => {
	const f = await fixture(t, false);
	await f.bind();
	f.save("medium");
	f.failAppend();
	const notify = t.mock.method(f.ui, "notify", () => { throw new Error("injected UI failure"); });
	const warn = t.mock.method(console, "warn", () => {});
	await f.runtime.newSession();
	const message = `slate: Private project model switch failed. The session now uses ${stored} with thinking level low. The requested thinking level was medium.`;
	assert.deepEqual(warn.mock.calls.map(({ arguments: args }) => args), [[message]]);
	assert.deepEqual(notify.mock.calls.map(({ arguments: args }) => args), [[message, "warning"]]);
	assert.equal(f.appendAttempts(), 1);
	assert.deepEqual(tracked(), [stored, "low", "stored-model"]);
	assert.deepEqual(f.errors, []);
});

test("a real Pi model redirect warns without setting effort on the replacement model", timeout, async (t) => {
	const f = await fixture(t, false);
	f.save("medium");
	f.redirect();
	await f.bind();
	assert.deepEqual(f.events, ["stored", "initial"]);
	assert.equal(f.runtime.session.thinkingLevel, "minimal");
	assert.deepEqual(tracked(), [initial, "minimal", "initial-model"]);
	assert.deepEqual(f.notices, [[`slate: Private project model switch failed. The session now uses ${initial} with thinking level minimal. The requested thinking level was medium.`, "warning"]]);
	assert.deepEqual(f.errors, []);
});

test("a real Pi append failure after model assignment warns and seeds the live state", timeout, async (t) => {
	const f = await fixture(t, false);
	f.save("medium");
	await f.bind();
	f.notices.length = 0;
	f.events.length = 0;
	f.failAppend();
	await f.runtime.newSession();
	assert.equal(f.appendAttempts(), 1);
	assert.equal(f.runtime.session.model?.id, "stored");
	assert.equal(f.runtime.session.thinkingLevel, "low");
	assert.deepEqual(tracked(), [stored, "low", "stored-model"]);
	assert.deepEqual(f.events, []);
	assert.deepEqual(f.notices, [[`slate: Private project model switch failed. The session now uses ${stored} with thinking level low. The requested thinking level was medium.`, "warning"]]);
	assert.deepEqual(f.errors, []);
});

test("the preference excludes successor records, not a plain new session after either adoption outcome", timeout, async (t) => {
	const f = await fixture(t, false);
	await f.bind();
	f.save("medium");
	for (const valid of [true, false]) {
		f.notices.length = 0;
		f.events.length = 0;
		const snapshot = new SlateStore({} as ExtensionAPI).snapshot();
		const result = await f.runtime.newSession({ setup: async (successor) => {
			successor.appendCustomEntry("slate-handoff", {
				sessionId: successor.getSessionId(), snapshot: valid ? snapshot : null,
				model: { provider, id: "initial" }, thinkingLevel: "low", logicalModel: "initial-model",
			});
		} });
		assert.equal(result.cancelled, false);
		assert.deepEqual(tracked(), [initial, "low", "initial-model"]);
		assert.ok(!f.notices.some(([message]) => message.includes("private project model")));
		assert.ok(!f.events.includes("stored"));
		assert.equal(f.notices.some(([message]) => message.includes("invalid successor handoff state")), !valid);
		assert.equal(f.runtime.session.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "slate-state"), valid);
		f.notices.length = 0;
		await f.runtime.newSession();
		assert.deepEqual(tracked(), [stored, "medium", "stored-model"]);
		assert.deepEqual(f.events, ["stored"]);
		assert.ok(f.notices.some(([message, severity]) => message === notice("medium") && severity === "info"));
	}
	assert.deepEqual(f.errors, []);
});

test("non-interactive sessions still seed the base model, thinking level, and logical identity", timeout, async (t) => {
	const f = await fixture(t, false);
	f.save("medium");
	f.setMode("print");
	await f.bind();
	assert.deepEqual(tracked(), [initial, "low", "initial-model"]);
	for (const mode of ["json", "rpc"] as const) {
		f.setMode(mode);
		await f.runtime.newSession();
		assert.deepEqual(tracked(), [initial, "low", "initial-model"]);
	}
	assert.deepEqual(f.events, []);
	assert.deepEqual(f.notices, []);
	assert.deepEqual(f.errors, []);
});
