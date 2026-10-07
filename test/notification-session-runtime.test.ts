import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	ModelRuntime, SessionManager, SettingsManager, createAgentSessionFromServices, createAgentSessionRuntime,
	createAgentSessionServices, type CreateAgentSessionRuntimeFactory, type ExtensionCommandContext, type ExtensionFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { registerNotificationEvents } from "../extension/notification-events.ts";
import { bindNotificationSettings } from "../extension/notification-config.ts";
import { NotificationDispatcher, type NotificationMessage } from "../extension/notification-dispatcher.ts";
import { registerSlateHandoff } from "../extension/handoff.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { SlateStore } from "../extension/state.ts";
import { createBaseModelTracker } from "../extension/base-model.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
	let timer!: NodeJS.Timeout;
	try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("session notification deadline")), 2000);
	})]); }
	finally { clearTimeout(timer); }
}

async function live(t: TestContext, before: ExtensionFactory, after: ExtensionFactory, options: { tool?: boolean; handoff?: boolean; persisted?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "slate-notification-runtime-")), agent = join(root, "agent");
	mkdirSync(agent);
	const modelRuntime = await ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: null,
		modelsStorePath: join(agent, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
	let requests = 0;
	modelRuntime.registerProvider("notification-offline", {
		api: "notification-offline-api", apiKey: "fixture", baseUrl: "http://127.0.0.1:9",
		models: [{ id: "main", name: "main", reasoning: false, input: ["text"], contextWindow: 100_000,
			maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model) {
			const tool = options.tool && requests++ === 0;
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: "provider original" }, ...(tool
					? [{ type: "toolCall" as const, id: "dialog-call", name: "read", arguments: { path: "unused" } }] : [])],
				stopReason: tool ? "toolUse" : "stop", timestamp: 1,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(); return stream;
		},
	});
	const delivered: { title: string; body: string }[] = [], timers = new Set<() => void>();
	const config = {}; bindNotificationSettings(config, { minimumDelayMs: 0, cooldownMs: 0, detail: "message" }, undefined, assert.fail);
	const adapter: ExtensionFactory = (pi) => {
		const events = registerNotificationEvents(pi, { currentLifecycle: () => true, recovering: () => false,
			channels: [{ name: "native", prepare: async (text) => () => { delivered.push(text); } }],
			schedule: (_delay, callback) => { timers.add(callback); return () => { timers.delete(callback); }; },
		});
		pi.on("session_start", (_event, ctx) => { events.retire(); events.start(config, ctx); });
		pi.on("session_shutdown", events.retire); events.registerSettlement();
		if (options.handoff) {
			const store = new SlateStore(pi); store.orchestratorMode = true;
			const hooks = registerSlateHandoff(pi, store, () => config, () => createBaseModelTracker({ warn: assert.fail }), undefined, events.ownReplacement);
			registerSlateMode(pi, store, hooks, () => config, () => EMPTY_WORKER_EXTENSION_SET);
		}
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: true }),
			resourceLoaderOptions: { noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: [before, adapter, after] },
		});
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
			model: modelRuntime.getModel("notification-offline", "main"), thinkingLevel: "off", noTools: options.tool ? undefined : "all" });
		await created.session.bindExtensions({ mode: "tui", commandContextActions: {
			waitForIdle: () => created.session.waitForIdle(), newSession: (options) => runtime.newSession(options),
			fork: (id, options) => runtime.fork(id, options), switchSession: (path, options) => runtime.switchSession(path, options),
			navigateTree: (id, options) => created.session.navigateTree(id, options), reload: () => created.session.reload(),
		}, uiContext: {
			notify() {}, setWidget() {}, setStatus() {}, onTerminalInput: () => () => {},
		} as unknown as ExtensionUIContext });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: root, agentDir: agent, sessionManager: options.persisted ? SessionManager.create(root, join(root, "sessions")) : SessionManager.inMemory(root) });
	t.after(async () => { await runtime.dispose(); rmSync(root, { recursive: true, force: true }); });
	const flush = async () => {
		for (let round = 0; round < 3; round++) {
			for (const callback of [...timers]) { timers.delete(callback); callback(); }
			for (let turn = 0; turn < 8; turn++) await Promise.resolve();
		}
	};
	return { runtime, delivered, timers, flush, root };
}

for (const final of ["aborted", "error", "stop"] as const) {
	test(`real message replacement chain supplies final ${final} evidence and redacted text`, { timeout: 5000 }, async (t) => {
		let intermediate: NotificationMessage | undefined, finalized: NotificationMessage | undefined;
		const message = t.mock.method(NotificationDispatcher.prototype, "message");
		const f = await live(t, (pi) => { pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			const replacement = { ...event.message, content: [{ type: "text" as const, text: "PRIVATE intermediate" }] };
			intermediate = replacement; return { message: replacement };
		}); }, (pi) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;
				assert.equal(event.message, intermediate);
				return { message: { ...event.message, stopReason: final, content: [{ type: "text", text: "redacted final" }],
					...(final === "error" ? { errorMessage: "final fault" } : {}) } as AssistantMessage };
			});
			pi.on("turn_end", (event) => { finalized = event.message; });
		});
		await within(f.runtime.session.prompt("complete this run")); await f.flush();
		assert.equal(message.mock.callCount(), 1); assert.equal(message.mock.calls[0]!.arguments[0], finalized);
		assert.notEqual(finalized, intermediate); assert.equal(finalized?.stopReason, final);
		assert.equal(intermediate?.stopReason, "stop");
		if (final === "aborted") assert.deepEqual(f.delivered, []);
		else {
			assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.title, final === "error" ? "Error" : "Input needed");
			assert.match(f.delivered[0]!.body, /redacted final/); assert.doesNotMatch(f.delivered[0]!.body, /PRIVATE/);
		}
	});
}

test("real newSession abort wait retires an open dialog before shutdown", { timeout: 5000 }, async (t) => {
	const entered = deferred(), gate = deferred(), shutdown = deferred();
	let hold = true, disposed = false;
	const f = await live(t, () => {}, (pi) => {
		pi.on("agent_start", async () => { if (hold) { entered.resolve(); await gate.promise; } });
		pi.on("session_shutdown", () => { disposed = true; shutdown.resolve(); });
	});
	const outgoing = f.runtime.session, prompt = outgoing.prompt("hold a run");
	const abort = t.mock.method(outgoing, "abort");
	try {
		await within(entered.promise);
		await outgoing.extensionRunner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "private dialog" });
		assert.equal(f.timers.size, 1);
		const replacing = f.runtime.newSession();
		for (let i = 0; i < 50 && abort.mock.callCount() === 0; i++) await Promise.resolve();
		assert.equal(abort.mock.callCount(), 1); assert.equal(disposed, false, "Pi is parked before session_shutdown");
		await f.flush(); assert.deepEqual(f.delivered, []); assert.equal(f.timers.size, 0);
		hold = false; gate.resolve(); await within(prompt); await within(replacing); await within(shutdown.promise);
		assert.notEqual(f.runtime.session, outgoing); await f.flush(); assert.deepEqual(f.delivered, []);
	} finally { hold = false; gate.resolve(); await within(prompt); }
});

// Pi exposes no final cancellation event for replacements Slate did not start.
// Idle interactive input can restore policy while a later before-handler awaits a decision.
// This approved limit is documented, not asserted as a suppression guarantee.
test("real cancelled /slate handoff restores dialog notifications without a submission", { timeout: 5000 }, async (t) => {
	let decisions = 0, inputs = 0;
	const f = await live(t, () => {}, (pi) => {
		pi.on("session_before_switch", () => { decisions++; return { cancel: true }; });
		pi.on("input", () => { inputs++; });
	}, { handoff: true });
	const session = f.runtime.session;
	await session.extensionRunner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "old dialog" });
	await within(session.prompt("/slate handoff"));
	assert.equal(decisions, 1); assert.equal(inputs, 0); assert.equal(f.runtime.session, session);
	await f.flush(); assert.equal(f.delivered.length, 0, "old dialog cannot return");
	await session.extensionRunner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "new dialog" });
	await f.flush(); assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.title, "Input needed");
	assert.equal(inputs, 0, "confirmation restores before any user input");
});

test("a tool dialog uses the final message replacement before turn_end", { timeout: 5000 }, async (t) => {
	const entered = deferred(), gate = deferred();
	let session: Awaited<ReturnType<typeof live>>["runtime"]["session"];
	let intermediate: NotificationMessage | undefined;
	const f = await live(t, (pi) => { pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		intermediate = { ...event.message, content: event.message.content.map((part) => part.type === "text"
			? { ...part, text: "PRIVATE intermediate" } : part) };
		return { message: intermediate as AssistantMessage };
	}); }, (pi) => {
		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			return { message: { ...event.message, content: event.message.content.map((part) => part.type === "text"
				? { ...part, text: "FINAL completed text" } : part) } };
		});
		pi.on("tool_call", async () => {
			await session.extensionRunner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "private title" });
			entered.resolve(); await gate.promise; return { block: true, reason: "fixture" };
		});
	}, { tool: true });
	session = f.runtime.session;
	const dialogMessage = t.mock.method(NotificationDispatcher.prototype, "dialogMessage");
	const running = session.prompt("ask for permission");
	try {
		await within(entered.promise); await f.flush(); assert.equal(f.delivered.length, 1);
		assert.match(f.delivered[0]!.body, /FINAL completed text/); assert.doesNotMatch(f.delivered[0]!.body, /PRIVATE|provider original/);
		const persisted = session.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.equal(dialogMessage.mock.calls[0]!.arguments[0], persisted?.type === "message" ? persisted.message : undefined);
		assert.notEqual(dialogMessage.mock.calls[0]!.arguments[0], intermediate);
	} finally { gate.resolve(); await within(running); }
});

test("a dialog inside message_end uses the previous persisted response", { timeout: 5000 }, async (t) => {
	const entered = deferred(), gate = deferred(); let open = false;
	let session: Awaited<ReturnType<typeof live>>["runtime"]["session"];
	const f = await live(t, () => {}, (pi) => { pi.on("message_end", async (event) => {
		if (!open || event.message.role !== "assistant") return;
		await session.extensionRunner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "private title" });
		entered.resolve(); await gate.promise;
		return { message: { ...event.message, content: [{ type: "text", text: "NEW final response" }] } };
	}); });
	session = f.runtime.session;
	await within(session.prompt("previous response")); await f.flush(); f.delivered.length = 0;
	open = true; const running = session.prompt("new response");
	try {
		await within(entered.promise); await f.flush(); assert.equal(f.delivered.length, 1);
		assert.match(f.delivered[0]!.body, /provider original/); assert.doesNotMatch(f.delivered[0]!.body, /NEW|private title/);
	} finally { gate.resolve(); await within(running); }
});

for (const scenario of ["aborted", "omitted", "replacement", "latest-omission", "latest-replacement", "empty-branch"] as const) {
	test(`dialog branch text respects ${scenario} without changing run outcome`, { timeout: 5000 }, async (t) => {
		const message = t.mock.method(NotificationDispatcher.prototype, "message");
		const f = await live(t, () => {}, () => {}), session = f.runtime.session;
		await within(session.prompt("previous completed text")); await f.flush(); f.delivered.length = 0;
		const previous = session.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.ok(previous?.type === "message" && previous.message.role === "assistant");
		const manager = session.sessionManager;
		const target = manager.appendMessage({ ...previous.message, stopReason: scenario === "aborted" ? "aborted" : "error",
			content: [{ type: "text", text: "HIDDEN failed attempt" }] });
		if (scenario === "omitted" || scenario === "latest-replacement") manager.appendContextEdit(target, null);
		if (scenario === "replacement" || scenario === "latest-omission" || scenario === "latest-replacement") {
			manager.appendContextEdit(target, { content: [{ type: "text", text: "EDITED completed text" }] });
		}
		if (scenario === "latest-omission") manager.appendContextEdit(target, null);
		if (scenario === "empty-branch") manager.resetLeaf();
		// Run evidence and dialog text deliberately disagree. Reading the branch must not
		// replace the run's final error with an older successful response or no response.
		const dispatcher = message.mock.calls[0]!.this;
		assert.ok(dispatcher instanceof NotificationDispatcher);
		dispatcher.runStart(); dispatcher.message({ ...previous.message,
			stopReason: "error", content: [{ type: "text", text: "RUN error evidence" }] });
		await session.extensionRunner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "private title" });
		await f.flush(); assert.equal(f.delivered.length, 1); assert.doesNotMatch(f.delivered[0]!.body, /HIDDEN|RUN|private title/);
		if (scenario === "replacement" || scenario === "latest-replacement") assert.match(f.delivered[0]!.body, /EDITED completed text/);
		else if (scenario === "empty-branch") assert.doesNotMatch(f.delivered[0]!.body, /provider original|EDITED/);
		else assert.match(f.delivered[0]!.body, /provider original/);
		await session.extensionRunner.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "private title" });
		dispatcher.settled(); await f.flush();
		assert.equal(f.delivered[1]!.title, "Error"); assert.match(f.delivered[1]!.body, /RUN error evidence/);
	});
}

for (const operation of ["new", "fork"] as const) {
	test(`real cancelled ${operation} request restores notifications on the next idle submission`, { timeout: 5000 }, async (t) => {
		let cancel = true;
		const f = await live(t, () => {}, (pi) => {
			pi.on("session_before_switch", () => cancel ? { cancel: true } : undefined);
			pi.on("session_before_fork", () => cancel ? { cancel: true } : undefined);
		});
		const session = f.runtime.session;
		await session.extensionRunner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "private dialog" });
		const result = operation === "new" ? await f.runtime.newSession() : await f.runtime.fork("cancelled-before-validation");
		assert.equal(result.cancelled, true); assert.equal(f.runtime.session, session);
		await f.flush(); assert.equal(f.delivered.length, 0); assert.equal(f.timers.size, 0);
		cancel = false;
		await within(session.prompt("next interactive submission")); await f.flush();
		assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.title, "Input needed");
	});
}

// These fixtures use Pi's editor submission and main-loop input code. Rendering is stubbed.
function editorHost(f: Awaited<ReturnType<typeof live>>) {
	const editor = { setText() {}, addToHistory() {}, async onSubmit(_text: string) {} };
	const ui = Object.create(InteractiveMode.prototype);
	Object.assign(ui, { runtimeHost: f.runtime, defaultEditor: editor, editor, ui: { requestRender() {} },
		pendingUserInputs: [], flushPendingBashComponents() {}, updatePendingMessagesDisplay() {},
		clearStatusIndicator() {}, showStatus() {}, showError() {}, getCrashExtensionHint() {},
		recordCrash: () => false, stop() {}, chatContainer: { addChild() {} } });
	ui.setupEditorSubmitHandler();
	return { editor, ui };
}
const dialog = (session: Awaited<ReturnType<typeof live>>["runtime"]["session"], title: string) =>
	session.extensionRunner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title });
const dialogEnd = (session: Awaited<ReturnType<typeof live>>["runtime"]["session"], title: string) =>
	session.extensionRunner.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title });

test("a second Slate handoff owns its real idle wait before any replacement event", { timeout: 5000 }, async (t) => {
	const firstEntered = deferred(), firstGate = deferred(), runEntered = deferred(), runGate = deferred();
	const waitEntered = deferred(), secondEntered = deferred(), secondGate = deferred();
	let decisions = 0, holdRun = true;
	const f = await live(t, () => {}, (pi) => {
		pi.on("agent_start", async () => { if (holdRun) { runEntered.resolve(); await runGate.promise; } });
		pi.on("session_before_switch", async () => {
			if (++decisions === 1) { firstEntered.resolve(); await firstGate.promise; }
			else { secondEntered.resolve(); await secondGate.promise; }
			return { cancel: true };
		});
	}, { handoff: true });
	const session = f.runtime.session, first = session.prompt("/slate handoff");
	let running: Promise<void> | undefined, second: Promise<void> | undefined;
	try {
		await within(firstEntered.promise);
		running = session.prompt("hold the agent while another handoff waits"); await within(runEntered.promise);
		assert.equal(session.isStreaming, true);
		const realWait = session.waitForIdle;
		t.mock.method(session, "waitForIdle", function (this: typeof session) { waitEntered.resolve(); return realWait.call(this); });
		second = session.prompt("/slate handoff"); await within(waitEntered.promise);
		assert.equal(decisions, 1, "the second request has not emitted session_before_switch");
		firstGate.resolve(); await within(first);
		assert.equal(session.isStreaming, true, "the second request still awaits the real agent run");
		await dialog(session, "second handoff waiting for idle"); await f.flush();
		assert.equal(f.delivered.length, 0, "the first cancellation cannot restore during the second idle wait");
		await dialogEnd(session, "second handoff waiting for idle");
		holdRun = false; runGate.resolve(); await within(running); await within(secondEntered.promise);
		assert.equal(decisions, 2);
		await within(session.prompt("idle input while the second replacement awaits a decision"));
		await f.flush(); assert.equal(f.delivered.length, 0);
		secondGate.resolve(); await within(second);
		await dialog(session, "both handoffs cancelled"); await f.flush(); assert.equal(f.delivered.length, 1);
	} finally {
		holdRun = false; firstGate.resolve(); runGate.resolve(); secondGate.resolve();
		await within(first); if (running) await within(running); if (second) await within(second);
	}
});

test("streaming Slate handoff stays suspended across idle input until its result", { timeout: 5000 }, async (t) => {
	const runEntered = deferred(), runGate = deferred(), entered = deferred(), gate = deferred();
	let blockRun = true, resolved = false;
	const f = await live(t, () => {}, (pi) => {
		pi.on("agent_start", async () => { if (blockRun) { runEntered.resolve(); await runGate.promise; } });
		pi.on("session_before_switch", async () => { entered.resolve(); await gate.promise; resolved = true; return { cancel: true }; });
	}, { handoff: true });
	const session = f.runtime.session, { editor, ui } = editorHost(f);
	const mainLoop = (async () => {
		await session.prompt("first run");
		await f.runtime.session.prompt(await ui.getUserInput());
	})();
	let handoff: Promise<void> | undefined;
	try {
		await within(runEntered.promise); assert.equal(session.isStreaming, true);
		handoff = editor.onSubmit("/slate handoff");
		blockRun = false; runGate.resolve(); await within(entered.promise);
		await editor.onSubmit("next human prompt"); await within(mainLoop); await f.flush();
		assert.equal(resolved, false); assert.equal(f.delivered.length, 0);
		await dialog(session, "pending handoff"); await f.flush(); assert.equal(f.delivered.length, 0);
		await dialogEnd(session, "pending handoff");
		gate.resolve(); await within(handoff);
		assert.equal(resolved, true); assert.equal(f.runtime.session, session);
		await dialog(session, "cancelled handoff"); await f.flush(); assert.equal(f.delivered.length, 1);
	} finally { blockRun = false; runGate.resolve(); gate.resolve(); if (handoff) await within(handoff); await within(mainLoop); }
});

test("cancelled Slate handoff cannot restore while editor /new remains pending", { timeout: 5000 }, async (t) => {
	const entered = deferred(), gate = deferred(); let decisions = 0, inputs = 0, firstResolved = false;
	const f = await live(t, () => {}, (pi) => {
		pi.on("session_before_switch", async () => {
			if (++decisions === 1) { entered.resolve(); await gate.promise; firstResolved = true; }
			return { cancel: true };
		});
		pi.on("input", () => { inputs++; });
	}, { handoff: true });
	const session = f.runtime.session, { editor, ui } = editorHost(f);
	const mainLoop = (async () => { await session.prompt(await ui.getUserInput()); })();
	const pending = editor.onSubmit("/new");
	try {
		await within(entered.promise); await editor.onSubmit("/slate handoff"); await within(mainLoop);
		assert.equal(decisions, 2); assert.equal(inputs, 0); assert.equal(firstResolved, false);
		await dialog(session, "pending /new"); await f.flush(); assert.equal(f.delivered.length, 0);
		await dialogEnd(session, "pending /new");
		gate.resolve(); await within(pending);
		await dialog(session, "cancelled /new before input"); await f.flush(); assert.equal(f.delivered.length, 0);
		await dialogEnd(session, "cancelled /new before input");
		await within(session.prompt("next idle input")); await dialog(session, "after input"); await f.flush();
		assert.equal(f.delivered.length, 1);
	} finally { gate.resolve(); await within(pending); }
});

test("reverse overlap retains foreign suspension after the Slate request cancels", { timeout: 5000 }, async (t) => {
	const entered = deferred(), gate = deferred(); let decisions = 0;
	const f = await live(t, () => {}, (pi) => {
		pi.on("session_before_switch", async () => {
			if (++decisions === 1) { entered.resolve(); await gate.promise; }
			return { cancel: true };
		});
	}, { handoff: true });
	const session = f.runtime.session, { editor, ui } = editorHost(f);
	const mainLoop = (async () => { await session.prompt(await ui.getUserInput()); })();
	await editor.onSubmit("/slate handoff");
	try {
		await within(entered.promise); await within(editor.onSubmit("/new")); assert.equal(decisions, 2);
		gate.resolve(); await within(mainLoop);
		await dialog(session, "both cancelled"); await f.flush(); assert.equal(f.delivered.length, 0);
		await dialogEnd(session, "both cancelled");
		await within(session.prompt("next idle input")); await dialog(session, "after input"); await f.flush();
		assert.equal(f.delivered.length, 1);
	} finally { gate.resolve(); await within(mainLoop); }
});

for (const earlier of ["delay", "cancel"] as const) {
	test(`Slate handoff ownership survives an earlier handler's ${earlier}`, { timeout: 5000 }, async (t) => {
		const entered = deferred(), gate = deferred();
		const f = await live(t, (pi) => {
			pi.on("session_before_switch", async () => {
				entered.resolve(); await gate.promise;
				return earlier === "cancel" ? { cancel: true } : undefined;
			});
		}, (pi) => { pi.on("session_before_switch", () => ({ cancel: true })); }, { handoff: true });
		const session = f.runtime.session, pending = session.prompt("/slate handoff");
		try {
			await within(entered.promise); gate.resolve(); await within(pending);
			assert.equal(f.runtime.session, session);
			await dialog(session, "after result"); await f.flush(); assert.equal(f.delivered.length, 1);
		} finally { gate.resolve(); await within(pending); }
	});
}

test("proceeding Slate handoff retires old waits and starts successor policy", { timeout: 5000 }, async (t) => {
	const f = await live(t, () => {}, () => {}, { handoff: true }), outgoing = f.runtime.session;
	await dialog(outgoing, "old dialog");
	await within(outgoing.prompt("/slate handoff")); assert.notEqual(f.runtime.session, outgoing);
	await f.flush(); assert.equal(f.delivered.length, 1, "only the successor's completed kickoff run notifies");
	assert.match(f.delivered[0]!.body, /provider original/);
	f.delivered.length = 0;
	await dialog(f.runtime.session, "successor dialog"); await f.flush(); assert.equal(f.delivered.length, 1);
});

test("foreign proceed fences a late cancelled Slate handoff", { timeout: 5000 }, async (t) => {
	const entered = deferred(), gate = deferred(); let decisions = 0, shutdowns = 0;
	const f = await live(t, () => {}, (pi) => {
		pi.on("session_before_switch", async () => {
			if (++decisions === 1) { entered.resolve(); await gate.promise; return { cancel: true }; }
			return undefined;
		});
		pi.on("session_shutdown", () => { shutdowns++; });
	}, { handoff: true });
	const outgoing = f.runtime.session, { editor, ui } = editorHost(f);
	const mainLoop = (async () => { await outgoing.prompt(await ui.getUserInput()); })();
	await editor.onSubmit("/slate handoff");
	try {
		await within(entered.promise); await within(editor.onSubmit("/new"));
		assert.equal(shutdowns, 1); assert.notEqual(f.runtime.session, outgoing);
		gate.resolve(); await within(mainLoop); await f.flush(); assert.equal(f.delivered.length, 0);
		await dialog(f.runtime.session, "successor dialog"); await f.flush(); assert.equal(f.delivered.length, 1);
	} finally { gate.resolve(); await within(mainLoop); }
});

for (const cancel of [true, false]) {
	test(`another extension's replacement command ${cancel ? "cancels until idle input" : "proceeds to fresh policy"}`, { timeout: 5000 }, async (t) => {
		let result: { cancelled: boolean } | undefined, decisions = 0;
		const f = await live(t, (pi) => {
			pi.registerCommand("other-new", { description: "Replace the fixture session", handler: async (_args, ctx) => {
				result = await ctx.newSession();
			} });
		}, (pi) => { pi.on("session_before_switch", () => { decisions++; return cancel ? { cancel: true } : undefined; }); }, { handoff: true });
		const outgoing = f.runtime.session;
		await dialog(outgoing, "old dialog"); await within(outgoing.prompt("/other-new"));
		assert.equal(decisions, 1); assert.equal(result?.cancelled, cancel);
		await f.flush(); assert.equal(f.delivered.length, 0, "the outgoing dialog cannot return");
		if (cancel) {
			assert.equal(f.runtime.session, outgoing);
			await dialog(outgoing, "cancelled command before input"); await f.flush(); assert.equal(f.delivered.length, 0);
			await dialogEnd(outgoing, "cancelled command before input");
			await within(outgoing.prompt("next idle interactive input")); await f.flush();
			assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.title, "Input needed");
		} else {
			assert.notEqual(f.runtime.session, outgoing);
			await dialog(f.runtime.session, "successor dialog"); await f.flush(); assert.equal(f.delivered.length, 1);
		}
	});
}

for (const origin of ["inside", "outside"] as const) {
	test(`a foreign timer ${origin} the Slate handoff context keeps replacement policy suspended`, { timeout: 5000 }, async (t) => {
		const entered = deferred(), gate = deferred(), foreignEntered = deferred(), foreignGate = deferred();
		let captured: ExtensionCommandContext | undefined, decisions = 0;
		let timer: NodeJS.Timeout | undefined, foreign: Promise<{ cancelled: boolean }> | undefined;
		const schedule = () => { timer = setTimeout(() => { foreign = captured!.newSession(); }, 0); };
		const f = await live(t, (pi) => {
			pi.registerCommand("capture", { description: "Capture the fixture command context", handler: async (_args, ctx) => { captured = ctx; } });
			pi.on("session_before_switch", () => { if (origin === "inside" && !timer) schedule(); });
		}, (pi) => {
			pi.on("session_before_switch", async () => {
				if (++decisions === 1) { entered.resolve(); await gate.promise; }
				else { foreignEntered.resolve(); await foreignGate.promise; }
				return { cancel: true };
			});
		}, { handoff: true });
		const session = f.runtime.session; await within(session.prompt("/capture"));
		const handoff = session.prompt("/slate handoff");
		try {
			await within(entered.promise); if (origin === "outside") schedule();
			await within(foreignEntered.promise); assert.equal(decisions, 2);
			gate.resolve(); await within(handoff); assert.equal(f.runtime.session, session);
			await dialog(session, "foreign timer replacement still pending"); await f.flush();
			assert.equal(f.delivered.length, 0, "only the first before-event belongs to the Slate request");
			await dialogEnd(session, "foreign timer replacement still pending");
			foreignGate.resolve(); assert.equal((await within(foreign!)).cancelled, true);
			await dialog(session, "foreign timer cancelled before input"); await f.flush(); assert.equal(f.delivered.length, 0);
			await dialogEnd(session, "foreign timer cancelled before input");
			await within(session.prompt("next idle interactive input")); await f.flush(); assert.equal(f.delivered.length, 1);
		} finally {
			if (timer) clearTimeout(timer); gate.resolve(); foreignGate.resolve();
			await within(handoff); if (foreign) await within(foreign);
		}
	});
}

for (const operation of ["fork", "resume", "import"] as const) {
	for (const cancel of [true, false]) {
		test(`real foreign ${operation} ${cancel ? "cancel" : "proceed"} preserves replacement policy`, { timeout: 5000 }, async (t) => {
			const f = await live(t, () => {}, (pi) => {
				pi.on("session_before_switch", () => cancel ? { cancel: true } : undefined);
				pi.on("session_before_fork", () => cancel ? { cancel: true } : undefined);
			}, { persisted: true });
			const session = f.runtime.session;
			await within(session.prompt("seed branch")); await f.flush(); f.delivered.length = 0;
			const user = session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
			assert.ok(user);
			const input = join(f.root, "incoming.jsonl");
			writeFileSync(input, `${JSON.stringify({ type: "session", version: 3, id: "import-fixture", timestamp: new Date().toISOString(), cwd: f.root })}\n`);
			await dialog(session, "old dialog");
			const result = operation === "fork" ? await f.runtime.fork(user.id)
				: operation === "resume" ? await f.runtime.switchSession(session.sessionFile!) : await f.runtime.importFromJsonl(input);
			assert.equal(result.cancelled, cancel); await f.flush(); assert.equal(f.delivered.length, 0);
			if (cancel) {
				assert.equal(f.runtime.session, session);
				await dialog(session, "cancel before input"); await f.flush(); assert.equal(f.delivered.length, 0);
				await dialogEnd(session, "cancel before input");
				await within(session.prompt("next idle input")); await f.flush(); assert.equal(f.delivered.length, 1);
			} else {
				assert.notEqual(f.runtime.session, session);
				await dialog(f.runtime.session, "new dialog"); await f.flush(); assert.equal(f.delivered.length, 1);
			}
		});
	}
}

test("Slate handoff restores after an exception before teardown", { timeout: 5000 }, async (t) => {
	const f = await live(t, () => {}, () => {}, { handoff: true }), session = f.runtime.session;
	const teardown = t.mock.method(f.runtime as unknown as { teardownCurrent(): Promise<void> }, "teardownCurrent", async () => {
		throw new Error("fixture before teardown");
	});
	await dialog(session, "old dialog");
	await within(session.prompt("/slate handoff"));
	assert.equal(teardown.mock.callCount(), 1); assert.equal(f.runtime.session, session);
	await f.flush(); assert.equal(f.delivered.length, 0);
	await dialog(session, "after exception"); await f.flush(); assert.equal(f.delivered.length, 1);
});

for (const operation of ["shutdown", "reload"] as const) {
	test(`real ${operation} fences a late Slate result`, { timeout: 5000 }, async (t) => {
		const entered = deferred(), gate = deferred();
		const f = await live(t, () => {}, (pi) => {
			pi.on("session_before_switch", async () => { entered.resolve(); await gate.promise; return { cancel: true }; });
		}, { handoff: true });
		const session = f.runtime.session, pending = session.prompt("/slate handoff");
		try {
			await within(entered.promise);
			if (operation === "shutdown") await f.runtime.dispose();
			else await within(session.reload());
			// Reload creates live policy. Pending request state does not cross the factory boundary.
			if (operation === "reload") {
				await dialog(session, "reloaded dialog"); await f.flush(); assert.equal(f.delivered.length, 1);
				await dialogEnd(session, "reloaded dialog"); f.delivered.length = 0;
			}
			gate.resolve(); await within(pending); await f.flush(); assert.equal(f.delivered.length, 0);
			if (operation === "reload") {
				await dialog(session, "fresh policy after late result"); await f.flush(); assert.equal(f.delivered.length, 1);
			}
		} finally { gate.resolve(); await within(pending); }
	});
}
