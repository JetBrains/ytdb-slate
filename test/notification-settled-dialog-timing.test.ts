import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	ModelRuntime, SessionManager, SettingsManager, createAgentSessionFromServices, createAgentSessionRuntime,
	createAgentSessionServices, type CreateAgentSessionRuntimeFactory, type ExtensionFactory,
	type ExtensionUIContext, type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { bindNotificationSettings } from "../extension/notification-config.ts";
import { registerNotificationEvents } from "../extension/notification-events.ts";

const minimumDelayMs = 30, cooldownMs = 60, deadlineMs = 3000;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
	let timer!: NodeJS.Timeout;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("settled dialog test deadline")), deadlineMs);
		})]);
	} finally { clearTimeout(timer); }
}
const flush = () => within(new Promise<void>((resolve) => setImmediate(resolve)));

// The session emits every policy event. Only rendering, delivery and time use test seams.
async function live(t: TestContext, realTimers = false) {
	const root = mkdtempSync(join(tmpdir(), "slate-settled-dialog-")), agent = join(root, "agent");
	mkdirSync(agent);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let time = 0, calls = 0, failNext = false;
	let held: ReturnType<typeof deferred<void>> | undefined, heldFailure: typeof held;
	let settling: { entered: ReturnType<typeof deferred<void>>; wait: ReturnType<typeof deferred<void>> } | undefined;
	const providerEntered = deferred<void>(), failureEntered = deferred<void>();
	const trace: Array<{ event: string; at: number }> = [];
	const now = () => realTimers ? performance.now() : time;
	const deliveries: Array<{ title: string; body: string; at: number }> = [];
	const delivered = deferred<void>();
	const timers = new Set<{ at: number; callback: () => void }>();
	const inputs = new Set<TerminalInputHandler>();
	const dialogs = new Set<ReturnType<typeof deferred<boolean>>>();
	const errors: unknown[] = [];
	const modelRuntime = await within(ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: null,
		modelsStorePath: join(agent, "models.json"), allowModelNetwork: false, refreshOnCreate: false }));
	modelRuntime.registerProvider("settled-dialog-offline", {
		api: "settled-dialog-api", apiKey: "fixture", baseUrl: "http://127.0.0.1:9",
		models: [{ id: "main", name: "main", reasoning: false, input: ["text"], contextWindow: 100_000,
			maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model) {
			calls++;
			const failure = failNext; failNext = false;
			const gate = failure ? heldFailure : held;
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: "completed deterministic response" }],
				stopReason: failure ? "error" : "stop", ...(failure ? { errorMessage: "429 rate limit" } : {}), timestamp: 1,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream();
			void (async () => {
				if (gate) { (failure ? failureEntered : providerEntered).resolve(); await gate.promise; }
				if (failure) stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: "stop", message });
				stream.end();
			})();
			return stream;
		},
	});
	const config = {};
	bindNotificationSettings(config, { minimumDelayMs, cooldownMs, native: true, terminal: false, bell: false }, undefined, assert.fail);
	const extension: ExtensionFactory = (pi) => {
		const events = registerNotificationEvents(pi, {
			currentLifecycle: () => true, recovering: () => false,
			channels: [{ name: "native", prepare: async (text) => () => {
				deliveries.push({ title: text.title, body: text.body, at: now() }); delivered.resolve();
			} }],
			...(realTimers ? {} : { now, schedule: (delay: number, callback: () => void) => {
				const timer = { at: time + delay, callback }; timers.add(timer);
				return () => { timers.delete(timer); };
			} }),
		});
		pi.on("session_start", (_event, ctx) => { events.retire(); events.start(config, ctx); });
		pi.on("session_shutdown", events.retire);
		events.registerSettlement();
		const record = (event: string) => () => { trace.push({ event, at: now() }); };
		pi.on("agent_start", record("agent_start"));
		pi.on("agent_end", record("agent_end"));
		pi.on("agent_before_settle", async () => {
			trace.push({ event: "agent_before_settle", at: now() });
			const gate = settling;
			if (gate) { gate.entered.resolve(); await gate.wait.promise; }
		});
		pi.on("agent_settled", record("agent_settled"));
		pi.on("ui_prompt_start", record("ui_prompt_start"));
		pi.on("ui_prompt_end", record("ui_prompt_end"));
		pi.on("input", record("input"));
		pi.registerCommand("timing-dialog", { description: "Open the test confirmation dialog", handler: async (_args, ctx) => {
			await ctx.ui.confirm("Timing confirmation", "Keep this dialog open for the test");
		} });
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }, { projectTrusted: true }),
			resourceLoaderOptions: { noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true,
				noThemes: true, extensionFactories: [extension] },
		});
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
			model: modelRuntime.getModel("settled-dialog-offline", "main"), thinkingLevel: "off", noTools: "all" });
		await created.session.bindExtensions({ mode: "tui", uiContext: {
			notify: assert.fail, setWidget() {}, setStatus() {},
			onTerminalInput(handler: TerminalInputHandler) { inputs.add(handler); return () => { inputs.delete(handler); }; },
			confirm() {
				const gate = deferred<boolean>(); dialogs.add(gate);
				return gate.promise.finally(() => { dialogs.delete(gate); });
			},
		} as unknown as ExtensionUIContext });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await within(createAgentSessionRuntime(createRuntime, { cwd: root, agentDir: agent, sessionManager: SessionManager.inMemory(root) }));
	const unsubscribeErrors = runtime.session.extensionRunner.onError((error) => { errors.push(error); });
	const unsubscribe = runtime.session.subscribe((event) => {
		if (event.type === "auto_retry_start") trace.push({ event: event.type, at: now() });
	});
	t.after(async () => {
		held?.resolve(); heldFailure?.resolve(); settling?.wait.resolve();
		for (const gate of dialogs) gate.resolve(false);
		await within(runtime.dispose()); unsubscribe(); unsubscribeErrors();
	});
	t.after(() => assert.deepEqual(errors, [], "the real extension handlers must succeed"));
	assert.equal(inputs.size, 1);
	const advance = async (amount: number) => {
		assert.equal(realTimers, false); time += amount;
		for (let round = 0; round < 20; round++) {
			const due = [...timers].filter((timer) => timer.at <= time);
			if (due.length === 0) { await flush(); return; }
			for (const timer of due) if (timers.delete(timer)) timer.callback();
			await flush();
		}
		assert.fail("the fake scheduler did not drain");
	};
	const run = async () => {
		const previous = trace.filter((item) => item.event === "agent_settled").length;
		await within(runtime.session.prompt("complete a main run")); await flush();
		assert.equal(trace.filter((item) => item.event === "agent_settled").length, previous + 1);
		assert.equal(runtime.session.isIdle, true);
	};
	const open = async () => {
		const previous = trace.filter((item) => item.event === "ui_prompt_start").length;
		const command = runtime.session.prompt("/timing-dialog"); await flush();
		assert.equal(dialogs.size, 1);
		assert.equal(trace.filter((item) => item.event === "ui_prompt_start").length, previous + 1);
		return { close: async () => {
			const ends = trace.filter((item) => item.event === "ui_prompt_end").length;
			for (const gate of dialogs) gate.resolve(false);
			await within(command); await flush();
			assert.equal(trace.filter((item) => item.event === "ui_prompt_end").length, ends + 1);
		} };
	};
	const key = (data: string) => {
		for (const listener of inputs) assert.equal(listener(data), undefined, "notification observation must not change input");
	};
	return { runtime, deliveries, delivered, trace, timers, dialogs, advance, run, open, key,
		get calls() { return calls; }, get time() { return now(); },
		holdSettlement: () => {
			settling = { entered: deferred<void>(), wait: deferred<void>() };
			return { entered: settling.entered.promise, release: () => settling?.wait.resolve() };
		},
		holdRetry: (holdFailure = false) => {
			failNext = true; held = deferred<void>(); if (holdFailure) heldFailure = deferred<void>();
			return { entered: providerEntered.promise, release: () => held?.resolve(),
				failureEntered: failureEntered.promise, releaseFailure: () => heldFailure?.resolve() };
		},
	};
}

test("real settlement restarts the full delay on input and admits exact delay and cooldown boundaries", { timeout: 10_000 }, async (t) => {
	const f = await live(t); await f.run();
	assert.equal(f.calls, 1); assert.equal(f.timers.size, 1);
	assert.equal(f.trace.filter((item) => item.event === "input").length, 1, "the session routes the submitted user prompt");
	await f.advance(minimumDelayMs - 1); assert.equal(f.deliveries.length, 0);
	f.key("x"); await f.advance(minimumDelayMs - 1);
	assert.equal(f.deliveries.length, 0, "a key restarts the full delay");
	await f.advance(1); assert.deepEqual(f.deliveries, [{ title: "Input needed", body: "", at: 59 }]);
	await f.advance(cooldownMs * 2); assert.equal(f.deliveries.length, 1, "one settlement sends only once");
	await f.run(); await f.advance(minimumDelayMs); assert.equal(f.deliveries.length, 2);
	const accepted = f.time;
	await f.run(); await f.advance(minimumDelayMs); assert.equal(f.deliveries.length, 2, "a repeat inside cooldown is dropped");
	assert.equal(f.timers.size, 0, "a cooldown drop does not retry later");
	await f.run(); await f.advance(minimumDelayMs - 1); assert.equal(f.deliveries.length, 2);
	await f.advance(1); assert.equal(f.time, accepted + cooldownMs); assert.equal(f.deliveries.length, 3);
});

test("a held real pre-settlement handler starts the full run delay only after settlement", { timeout: 10_000 }, async (t) => {
	const f = await live(t), settlement = f.holdSettlement();
	const running = f.runtime.session.prompt("hold the real settlement boundary");
	try {
		await within(settlement.entered); await flush();
		assert.deepEqual(f.trace.filter((item) => item.event === "agent_end"), [{ event: "agent_end", at: 0 }]);
		assert.deepEqual(f.trace.filter((item) => item.event === "agent_before_settle"), [{ event: "agent_before_settle", at: 0 }]);
		assert.equal(f.trace.filter((item) => item.event === "agent_settled").length, 0);
		assert.equal(f.runtime.session.isIdle, false);
		assert.equal(f.timers.size, 0, "agent_end must not arm the run wait");
		await f.advance(minimumDelayMs * 2); assert.deepEqual(f.deliveries, []);
		settlement.release(); await within(running); await flush();
		assert.deepEqual(f.trace.filter((item) => item.event === "agent_settled"), [{ event: "agent_settled", at: 60 }]);
		assert.equal(f.runtime.session.isIdle, true); assert.equal(f.timers.size, 1);
		await f.advance(minimumDelayMs - 1); assert.deepEqual(f.deliveries, []);
		await f.advance(1);
		assert.deepEqual(f.deliveries, [{ title: "Input needed", body: "", at: 90 }]);
		assert.equal(f.timers.size, 0);
	} finally { settlement.release(); await within(running); }
});

test("a real settled wait that matures one millisecond before cooldown is dropped without retry", { timeout: 10_000 }, async (t) => {
	const f = await live(t); await f.run(); await f.advance(minimumDelayMs);
	assert.deepEqual(f.deliveries, [{ title: "Input needed", body: "", at: 30 }]);
	await f.advance(cooldownMs - minimumDelayMs - 1); await f.run();
	assert.equal(f.time, 59); assert.equal(f.timers.size, 1);
	await f.advance(minimumDelayMs);
	assert.equal(f.time, 89); assert.equal(f.time - f.deliveries[0]!.at, cooldownMs - 1);
	assert.equal(f.deliveries.length, 1, "the mature wait must not admit before the cooldown boundary");
	assert.equal(f.timers.size, 0, "a cooldown drop must not leave a retry timer");
	await f.advance(1); await f.advance(cooldownMs); assert.equal(f.deliveries.length, 1);
});

test("real open dialog permits run admission and shares its waiting-for-input cooldown", { timeout: 10_000 }, async (t) => {
	const f = await live(t); await f.run(); await f.advance(5);
	const dialog = await f.open();
	await f.advance(minimumDelayMs - 5);
	assert.equal(f.dialogs.size, 1); assert.equal(f.deliveries.length, 1, "the run admits while the dialog is open");
	assert.equal(f.deliveries[0]!.at, minimumDelayMs);
	await f.advance(5); assert.equal(f.deliveries.length, 1, "the dialog cannot bypass the run cooldown");
	assert.equal(f.timers.size, 0); await dialog.close();
	await f.advance(cooldownMs);
	const next = await f.open(); await f.advance(minimumDelayMs); assert.equal(f.deliveries.length, 2);
	await next.close(); await f.run(); await f.advance(minimumDelayMs);
	assert.equal(f.deliveries.length, 2, "the run cannot bypass the dialog cooldown");
	await f.advance(cooldownMs); assert.equal(f.deliveries.length, 2, "dropped waits stay cancelled");
});

test("closing a real extension confirmation cancels its pending wait before the boundary", { timeout: 10_000 }, async (t) => {
	const f = await live(t), dialog = await f.open();
	assert.equal(f.calls, 0, "an extension command makes no model request");
	await f.advance(minimumDelayMs - 1); await dialog.close();
	assert.equal(f.timers.size, 0, "the close event cancels the pending timer");
	await f.advance(1); await f.advance(cooldownMs); assert.deepEqual(f.deliveries, []);
	const next = await f.open(); await f.advance(minimumDelayMs); assert.equal(f.deliveries.length, 1);
	await next.close();
});

test("a real retry at a later clock time preserves the original open dialog deadline without input", { timeout: 10_000 }, async (t) => {
	const f = await live(t), dialog = await f.open(), retry = f.holdRetry(true);
	const running = f.runtime.session.prompt("retry after the fake clock advances");
	try {
		await within(retry.failureEntered); await flush();
		assert.equal(f.calls, 1);
		await f.advance(minimumDelayMs - 1); assert.equal(f.deliveries.length, 0);
		retry.releaseFailure(); await within(retry.entered); await flush();
		assert.equal(f.calls, 2);
		assert.deepEqual(f.trace.filter((item) => item.event === "agent_start").map((item) => item.at), [0, 29]);
		assert.deepEqual(f.trace.filter((item) => item.event === "auto_retry_start"), [{ event: "auto_retry_start", at: 29 }]);
		assert.equal(f.trace.filter((item) => item.event === "agent_settled").length, 0);
		assert.equal(f.runtime.session.isIdle, false); assert.equal(f.dialogs.size, 1);
		await f.advance(1);
		assert.deepEqual(f.deliveries, [{ title: "Input needed", body: "", at: 30 }]);
		assert.equal(f.runtime.session.isIdle, false); assert.equal(f.timers.size, 0);
		await f.advance(cooldownMs); assert.equal(f.deliveries.length, 1);
		await dialog.close(); retry.release(); await within(running); await flush();
		assert.equal(f.trace.filter((item) => item.event === "agent_settled").length, 1);
	} finally { retry.releaseFailure(); retry.release(); await within(running); }
});

test("dialog input restarts the delay across a real retry and can notify while the agent is active", { timeout: 10_000 }, async (t) => {
	const f = await live(t), dialog = await f.open(), retry = f.holdRetry();
	const running = f.runtime.session.prompt("retry this deterministic failure");
	try {
		await within(retry.entered); await flush();
		assert.equal(f.calls, 2); assert.ok(f.trace.some((item) => item.event === "auto_retry_start"));
		assert.equal(f.trace.filter((item) => item.event === "agent_start").length, 2, "the retry starts a second agent run");
		assert.equal(f.trace.filter((item) => item.event === "agent_settled").length, 0);
		assert.equal(f.runtime.session.isIdle, false); assert.equal(f.timers.size, 1);
		await f.advance(minimumDelayMs - 1); f.key("\u001b[B");
		await f.advance(minimumDelayMs - 1); assert.equal(f.deliveries.length, 0);
		await f.advance(1); assert.equal(f.deliveries.length, 1);
		assert.equal(f.deliveries[0]!.title, "Input needed"); assert.equal(f.runtime.session.isIdle, false);
		await f.advance(cooldownMs * 2); assert.equal(f.deliveries.length, 1, "an open dialog sends only once");
		await dialog.close(); retry.release(); await within(running); await flush();
		assert.equal(f.trace.filter((item) => item.event === "agent_settled").length, 1);
		await f.advance(minimumDelayMs); assert.equal(f.deliveries.length, 2);
		assert.equal(f.deliveries[1]!.title, "Input needed", "successful retry replaces the intermediate error");
	} finally { retry.release(); await within(running); }
});

test("real settled session reaches delivery through the production timers within a generous deadline", { timeout: 10_000 }, async (t) => {
	const f = await live(t, true); await f.run(); await within(f.delivered.promise);
	const settlement = f.trace.find((item) => item.event === "agent_settled"); assert.ok(settlement);
	assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0]!.title, "Input needed");
	assert.ok(f.deliveries[0]!.at - settlement.at >= minimumDelayMs - 1, "production timers respect the delay");
	assert.ok(f.deliveries[0]!.at - settlement.at < deadlineMs, "production delivery stays inside the generous deadline");
});
