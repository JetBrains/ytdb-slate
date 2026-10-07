import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MainRetryEvidence } from "../extension/logical-model-adapters.ts";
import extension from "../extension/index.ts";
import { registerNotificationEvents } from "../extension/notification-events.ts";
import { NotificationDispatcher } from "../extension/notification-dispatcher.ts";
import { bindNotificationSettings } from "../extension/notification-config.ts";
import { ThreadManager } from "../extension/threads.ts";
import { registerOrchestratorFailover } from "../extension/failover.ts";
import { createBaseModelTracker } from "../extension/base-model.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
function host(t: TestContext, mode = "tui", state = { orchestratorMode: false, paused: false }) {
	const cwd = mkdtempSync(join(tmpdir(), "slate-notification-events-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const events = new Map<string, Handler[]>(), keys = new Set<(...args: any[]) => unknown>();
	const notices: string[] = [], entries: unknown[] = [], commands = new Map<string, any>();
	let active = ["read"], signal: AbortSignal | undefined;
	const pi = {
		on(name: string, handler: Handler) { events.set(name, [...events.get(name) ?? [], handler]); },
		registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command); },
		getActiveTools: () => active, setActiveTools: (tools: string[]) => { active = tools; },
		getAllTools: () => ["read"].map((name) => ({ name })), getThinkingLevel: () => "max",
		appendEntry: (...args: unknown[]) => entries.push(args), sendMessage: (...args: unknown[]) => entries.push(args),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd, mode, hasUI: mode !== "print", get signal() { return signal; }, isIdle: () => true, hasPendingMessages: () => false,
		isProjectTrusted: () => true, model: undefined, modelRegistry: {}, getContextUsage: () => undefined,
		sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined, getEntries: () => [],
			getBranch: () => [{ type: "custom", customType: "slate-state", data: { format: "single-action-v1", threads: [], episodes: [], workerCostUsd: 0, carriedCostUsd: 0, ...state } }] },
		ui: { notify: (text: string) => notices.push(text), setWidget() {}, setStatus() {},
			onTerminalInput(handler: (...args: any[]) => unknown) { keys.add(handler); return () => { keys.delete(handler); }; } },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: any = {}) => {
		for (const handler of events.get(name) ?? []) {
			const result = await handler(event, ctx);
			if (name === "input" && (result as any)?.action === "handled") return result;
			if (name === "user_bash" && result !== undefined) return result;
		}
		return undefined;
	};
	return { pi, ctx, emit, events, keys, entries, notices, commands, setSignal: (value: AbortSignal | undefined) => { signal = value; } };
}
function spy(t: TestContext, name: "activity" | "retire" | "runStart" | "message" | "settled") {
	return t.mock.method(NotificationDispatcher.prototype, name);
}

test("real factory observes input before paused refusal and bash before later handlers", { timeout: 5000 }, async (t) => {
	const f = host(t, "tui", { orchestratorMode: true, paused: true });
	const activity = spy(t, "activity"); extension(f.pi); await f.emit("session_start");
	const before = activity.mock.callCount();
	await f.emit("input", { source: "interactive", text: "private prompt" });
	assert.equal(activity.mock.callCount(), before + 1);
	assert.match(f.notices.at(-1)!, /input rejected/);
	f.pi.on("user_bash", () => { assert.equal(activity.mock.callCount(), before + 2); return { result: {} } as any; });
	await f.emit("user_bash", { command: "private shell command", excludeFromContext: true });
	await f.emit("session_shutdown");
});

test("real factory observes mode on and off and forwards only assistant evidence", { timeout: 5000 }, async (t) => {
	for (const on of [false, true]) {
		const f = host(t, "tui", { orchestratorMode: on, paused: false });
		const start = spy(t, "runStart"), message = spy(t, "message"), settled = spy(t, "settled");
		extension(f.pi); await f.emit("session_start");
		await f.emit("agent_start"); await f.emit("message_end", { message: { role: "custom", content: "secret" } });
		await f.emit("turn_end", { message: { role: "custom", content: "secret" }, toolResults: [] });
		await f.emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
		await f.emit("turn_end", { message: { role: "assistant", stopReason: "stop" }, toolResults: [] });
		await f.emit("agent_settled");
		assert.equal(start.mock.callCount(), 1); assert.equal(message.mock.callCount(), 1); assert.equal(settled.mock.callCount(), 1);
		await f.emit("session_shutdown"); t.mock.restoreAll();
	}
});

test("real factory retires before teardown awaits and rebinds listeners on session start", { timeout: 5000 }, async (t) => {
	const retired = spy(t, "retire");
	let release!: () => void, block = false;
	t.mock.method(ThreadManager.prototype, "disposeAll", async () => {
		if (block) { assert.ok(retired.mock.callCount() > 0); await new Promise<void>((resolve) => { release = resolve; }); }
	});
	const f = host(t); extension(f.pi); await f.emit("session_start");
	const firstListener = [...f.keys][0]!; const activity = spy(t, "activity");
	block = true; const replacing = f.emit("session_start", { reason: "reload" });
	assert.equal(retired.mock.callCount(), 1); assert.equal(f.keys.size, 0);
	await f.emit("agent_settled"); release(); await replacing;
	assert.equal(f.keys.size, 1); assert.notEqual([...f.keys][0], firstListener);
	firstListener("late"); assert.equal(activity.mock.calls.at(-1)!.this, retired.mock.calls[0]!.this);
	retired.mock.resetCalls(); const shutdown = f.emit("session_shutdown", { reason: "new" });
	assert.equal(retired.mock.callCount(), 1); assert.equal(f.keys.size, 0);
	await f.emit("agent_settled"); release(); await shutdown;
	block = false;
	await f.emit("session_start"); assert.equal(f.keys.size, 0, "retired factory cannot regain ownership");
	const fresh = host(t); extension(fresh.pi); await fresh.emit("session_start", { reason: "resume" });
	assert.equal(fresh.keys.size, 1); await fresh.emit("session_shutdown");
});

test("real factory suppresses print and RPC notifications even with a UI", { timeout: 5000 }, async (t) => {
	const start = spy(t, "runStart"), settled = spy(t, "settled");
	for (const mode of ["rpc", "print"]) {
		const f = host(t, mode); extension(f.pi); await f.emit("session_start");
		await f.emit("agent_start"); await f.emit("agent_settled"); assert.equal(f.keys.size, 0);
		await f.emit("session_shutdown");
	}
	assert.equal(start.mock.callCount(), 0); assert.equal(settled.mock.callCount(), 0);
});

function policy(t: TestContext) {
	const f = host(t); let time = 0, recovering = false, current = true;
	const timers = new Set<{ at: number; callback: () => void }>(), delivered: string[] = [];
	const config = {}; bindNotificationSettings(config, { minimumDelayMs: 30, cooldownMs: 0, detail: "message" }, undefined, () => {});
	const events = registerNotificationEvents(f.pi, { currentLifecycle: () => current, recovering: () => recovering,
		channels: [{ name: "native", prepare: async (text) => () => { delivered.push(`${text.title}:${text.body}`); } }],
		now: () => time, schedule: (delay, callback) => { const timer = { at: time + delay, callback }; timers.add(timer); return () => { timers.delete(timer); }; },
	});
	events.start(config, f.ctx); events.registerSettlement(); t.after(events.retire);
	const advance = async (amount: number) => {
		time += amount;
		for (const timer of [...timers]) if (timer.at <= time) { timers.delete(timer); timer.callback(); }
		for (let i = 0; i < 8; i++) await Promise.resolve();
	};
	return { ...f, events, config, delivered, timers, advance, setRecovering: (value: boolean) => { recovering = value; }, loseOwner: () => { current = false; } };
}

test("registered terminal listener handles one large paste with one timestamp and no retained key data", { timeout: 5000 }, async (t) => {
	const originalActivity = NotificationDispatcher.prototype.activity;
	const f = policy(t), activity = spy(t, "activity");
	await f.emit("ui_prompt_start", { title: "private dialog" }); await f.advance(29);
	const listener = [...f.keys][0]!; const entries = structuredClone(f.entries);
	const paste = "private-key-data".repeat(1_000_000);
	assert.equal(listener(paste), undefined); assert.equal(activity.mock.callCount(), 1);
	assert.deepEqual(activity.mock.calls[0]!.arguments, []); assert.equal(f.timers.size, 1);
	await f.advance(1); await f.advance(28); assert.deepEqual(f.delivered, []);
	await f.advance(1); await f.advance(0); assert.match(f.delivered[0]!, /^Input needed:/);
	assert.deepEqual(f.entries, entries); assert.equal(f.delivered.join().includes("private"), false);
	activity.mock.mockImplementation(() => { throw new Error("private failure"); });
	assert.equal(listener(paste), undefined); assert.deepEqual(f.entries, entries);
	t.mock.restoreAll();
	assert.equal(NotificationDispatcher.prototype.activity, originalActivity);
});

test("registered activity events delay waits but provider requests and extension submissions do not", { timeout: 5000 }, async (t) => {
	for (const name of ["input", "user_bash", "model_select", "thinking_level_select", "session_info_changed", "session_before_tree", "session_tree", "session_before_compact"]) {
		const f = policy(t); await f.emit("ui_prompt_start"); await f.advance(29);
		await f.emit(name, { source: "interactive", reason: "manual" }); await f.advance(1); await f.advance(28);
		assert.deepEqual(f.delivered, [], name); await f.advance(1); await f.advance(0); assert.equal(f.delivered.length, 1, name);
		f.events.retire();
	}
	for (const [name, event] of [["input", { source: "extension" }], ["input", { source: "rpc" }], ["before_provider_request", {}], ["session_before_compact", { reason: "threshold" }]] as const) {
		const f = policy(t); await f.emit("ui_prompt_start"); await f.advance(29); await f.emit(name, event);
		await f.advance(1); await f.advance(0); assert.equal(f.delivered.length, 1, name); f.events.retire();
	}
});

test("replacement requests retire waits and only idle interactive input restores fresh policy", { timeout: 5000 }, async (t) => {
	for (const name of ["session_before_switch", "session_before_fork"]) {
		const f = policy(t); await f.emit("ui_prompt_start"); await f.advance(29);
		await f.emit(name); assert.equal(f.keys.size, 0); assert.equal(f.timers.size, 0);
		await f.emit("agent_settled"); await f.emit("ui_prompt_start"); await f.advance(100);
		assert.deepEqual(f.delivered, []);
		Object.assign(f.ctx, { isIdle: () => false });
		await f.emit("input", { source: "interactive" }); assert.equal(f.keys.size, 0, "abort wait cannot resume policy");
		Object.assign(f.ctx, { isIdle: () => true });
		await f.emit("input", { source: "extension" }); assert.equal(f.keys.size, 0);
		await f.emit("user_bash"); assert.equal(f.keys.size, 0, "shell input cannot restore policy");
		await f.emit("input", { source: "rpc" }); assert.equal(f.keys.size, 0);
		await f.emit("input", { source: "interactive" }); assert.equal(f.keys.size, 1);
		await f.advance(100); assert.deepEqual(f.delivered, [], "old dialogs do not return");
		await f.emit("ui_prompt_start"); await f.advance(30); await f.advance(0);
		assert.equal(f.delivered.length, 1); f.events.retire();
	}
});

test("confirmed cancellation restores only a suspended live session", { timeout: 5000 }, async (t) => {
	const f = policy(t);
	await f.events.ownReplacement(f.ctx, () => f.emit("session_before_switch"));
	assert.equal(f.keys.size, 1);
	await f.emit("ui_prompt_start"); await f.advance(30); await f.advance(0);
	assert.equal(f.delivered.length, 1, "confirmation needs no submission");
	await f.events.ownReplacement(f.ctx, async () => { await f.emit("session_before_fork"); f.events.retire(); });
	assert.equal(f.keys.size, 0); await f.emit("ui_prompt_start"); await f.advance(100);
	assert.equal(f.delivered.length, 1, "shutdown retirement cannot be reversed");
	f.events.start(f.config, f.ctx);
	await f.events.ownReplacement(f.ctx, async () => { await f.emit("session_before_switch"); f.loseOwner(); });
	assert.equal(f.keys.size, 0, "lifecycle retirement cannot be reversed");
	await f.emit("ui_prompt_start"); await f.advance(100); assert.equal(f.delivered.length, 1);
});

test("replacement restoration preserves existing and later cancellation evidence during an active run", { timeout: 5000 }, async (t) => {
	for (const later of [false, true]) {
		const f = policy(t), controller = new AbortController();
		f.setSignal(later ? undefined : controller.signal);
		await f.emit("agent_start");
		await f.events.ownReplacement(f.ctx, async () => {
			await f.emit("session_before_switch");
			if (!later) { controller.abort(); f.setSignal(undefined); }
		});
		assert.equal(f.keys.size, 1, "policy restores while the run remains active");
		if (later) {
			await f.emit("session_before_compact", { reason: "overflow", signal: controller.signal });
			controller.abort();
		}
		assert.equal(f.events.cancelled(), true, "restoration preserves both signals and the observed-run flag");
		await f.emit("agent_settled"); assert.equal(f.events.cancelled(), false);
		await f.advance(100); assert.deepEqual(f.delivered, []);
		f.events.retire();
	}
});

test("two owned requests restore only after both settle", { timeout: 5000 }, async (t) => {
	const f = policy(t);
	let firstRelease!: () => void, secondRelease!: () => void;
	const first = f.events.ownReplacement(f.ctx, async () => {
		await f.emit("session_before_switch");
		await new Promise<void>((resolve) => { firstRelease = resolve; });
	});
	const second = f.events.ownReplacement(f.ctx, async () => {
		await f.emit("session_before_fork");
		await new Promise<void>((resolve) => { secondRelease = resolve; });
	});
	try {
		for (let i = 0; i < 10 && !secondRelease; i++) await Promise.resolve();
		await f.emit("input", { source: "interactive" }); assert.equal(f.keys.size, 0);
		firstRelease(); await first; assert.equal(f.keys.size, 0);
		secondRelease(); await second; assert.equal(f.keys.size, 1);
		await f.emit("ui_prompt_start"); await f.advance(30); await f.advance(0);
		assert.equal(f.delivered.length, 1);
	} finally { firstRelease?.(); secondRelease?.(); await Promise.all([first, second]); }
});

test("retirement fences an owned result from a restarted adapter generation", { timeout: 5000 }, async (t) => {
	const f = policy(t); let release!: () => void;
	const pending = f.events.ownReplacement(f.ctx, async () => {
		await f.emit("session_before_switch");
		await new Promise<void>((resolve) => { release = resolve; });
	});
	try {
		for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
		f.events.retire(); f.events.start(f.config, f.ctx);
		release(); await pending;
		await f.events.ownReplacement(f.ctx, () => f.emit("session_before_fork"));
		assert.equal(f.keys.size, 1, "late settle cannot decrement the new generation's counter");
		await f.emit("ui_prompt_start"); await f.advance(30); await f.advance(0);
		assert.equal(f.delivered.length, 1);
	} finally { release?.(); await pending; }
});

test("unobserved starts, run ends and teardown settlement cannot create live waits", { timeout: 5000 }, async (t) => {
	const f = policy(t); await f.emit("agent_settled"); await f.advance(100); assert.equal(f.timers.size, 0);
	await f.emit("agent_start"); await f.emit("agent_end"); assert.equal(f.timers.size, 0);
	f.events.retire(); await f.emit("agent_settled"); await f.emit("ui_prompt_start"); await f.advance(100);
	assert.deepEqual(f.delivered, []); assert.equal(f.timers.size, 0);
});

test("run and overflow cancellation survive signal loss at settlement", { timeout: 5000 }, async (t) => {
	for (const overflow of [false, true]) {
		const f = policy(t), abort = new AbortController();
		if (!overflow) f.setSignal(abort.signal);
		await f.emit("agent_start"); await f.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "provider" } });
		if (overflow) await f.emit("session_before_compact", { reason: "overflow", signal: abort.signal });
		abort.abort(); f.setSignal(undefined); assert.equal(f.events.cancelled(), true);
		await f.emit("agent_settled"); await f.advance(100); assert.deepEqual(f.delivered, []);
		assert.equal(f.events.cancelled(), false, "settlement releases wrapper cancellation evidence");
		f.events.retire(); assert.equal(f.events.cancelled(), false);
	}
});

test("real failover registers before notification settlement and shares cancellation and completion", { timeout: 5000 }, async (t) => {
	const f = host(t); let epoch = 0, completed = 0;
	const config = {}; bindNotificationSettings(config, { minimumDelayMs: 0, cooldownMs: 0 }, undefined, () => {});
	const delivered: string[] = [];
	let recovering = () => false;
	const events = registerNotificationEvents(f.pi, { currentLifecycle: () => true, recovering: () => recovering(),
		channels: [{ name: "native", prepare: async (text) => () => { delivered.push(text.title); } }],
	});
	const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { replace: [{ model: "luna-6", preferredProvider: "p1", providers: { p1: "m1", p2: "m2" } }] } } } });
	const base = createBaseModelTracker({ warn() {} });
	const primary = { provider: "p1", id: "m1", contextWindow: 10000, reasoning: true, thinkingLevelMap: { max: "max" } }, fallback = { ...primary, provider: "p2", id: "m2" };
	let model = primary, release!: () => void, validationBlocked = false, switches = 0, failSwitch = false;
	Object.defineProperty(f.ctx, "model", { get: () => model });
	Object.assign(f.ctx.modelRegistry, { find: () => fallback, async getApiKeyAndHeaders() {
		if (validationBlocked) await new Promise<void>((resolve) => { release = resolve; });
		return { ok: true, apiKey: "fake" };
	} });
	Object.assign(f.pi, { setModel: async () => { if (failSwitch) throw new Error("fixture switch failure"); switches++; model = { ...primary, ...fallback }; return true; }, setThinkingLevel() {} });
	base.seed(primary, "max"); base.adoptLogicalIdentity("luna-6");
	const failover = registerOrchestratorFailover(f.pi, () => ({ preserveGlobalModelDefault: false }), () => base, () => runtime,
		() => ({ enabled: true, maxRetries: 0, baseDelayMs: 0 }), () => epoch,
		{ cancelled: events.cancelled, finished: () => { assert.equal(failover.recovering(), false); completed++; events.recoveryFinished(); } });
	recovering = failover.recovering; events.registerSettlement(); events.start(config, f.ctx); t.after(events.retire);
	const error = { role: "assistant", stopReason: "error", errorMessage: "temporary timeout", content: [] };
	const turn = async (message: unknown) => { await f.emit("message_end", { message }); await f.emit("turn_end", { message }); };
	const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
	const abort = new AbortController(); f.setSignal(abort.signal); await f.emit("agent_start"); await turn(error);
	abort.abort(); f.setSignal(undefined);
	await events.ownReplacement(f.ctx, () => f.emit("session_before_switch"));
	assert.equal(events.cancelled(), true, "restoring policy does not erase failover cancellation evidence");
	await f.emit("agent_settled"); await pause();
	assert.equal(switches, 0); assert.deepEqual(delivered, []);
	await f.emit("agent_start"); await turn(error); validationBlocked = true;
	const settling = f.emit("agent_settled"); for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
	assert.equal(failover.recovering(), true); await f.emit("agent_settled"); await pause(); assert.deepEqual(delivered, []);
	release(); await settling; validationBlocked = false;
	assert.equal(switches, 1); assert.equal(failover.recovering(), true); await pause(); assert.deepEqual(delivered, []);
	await f.emit("agent_start"); await turn({ role: "assistant", stopReason: "stop", content: [] }); await f.emit("agent_settled"); await pause();
	assert.equal(completed, 1); assert.deepEqual(delivered, ["Input needed"]);
	// An overlapping settled observer resumes only when failed recovery releases ownership.
	model = primary; await f.emit("agent_start"); await turn(error); validationBlocked = failSwitch = true; release = undefined as any;
	const failing = f.emit("agent_settled"); for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
	await f.emit("agent_settled"); await pause(); assert.deepEqual(delivered, ["Input needed"]);
	release(); await failing; await pause(); assert.equal(completed, 2); assert.deepEqual(delivered, ["Input needed", "Error"]);
	failSwitch = false;
	// A stale transition cannot call the replacement session's completion callback.
	model = primary; await f.emit("agent_start"); await turn(error); validationBlocked = true; release = undefined as any;
	const stale = f.emit("agent_settled"); for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
	epoch++; events.retire(); release(); await stale; assert.equal(completed, 2);
});

function factoryRecovery(t: TestContext) {
	const f = host(t), agent = join(f.ctx.cwd, "agent");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	mkdirSync(agent); mkdirSync(join(f.ctx.cwd, ".pi"));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 0, baseDelayMs: 0 } }));
	writeFileSync(join(f.ctx.cwd, ".pi", "slate.json"), JSON.stringify({ preserveGlobalModelDefault: false,
		notifications: { minimumDelayMs: 0, cooldownMs: 0 },
		router: { models: { replace: [{ model: "luna-6", preferredProvider: "p1", providers: { p1: "m1", p2: "m2" } }] } },
	}));
	const primary = { provider: "p1", id: "m1", contextWindow: 10000, reasoning: true, thinkingLevelMap: { max: "max" } };
	const fallback = { ...primary, provider: "p2", id: "m2" };
	let model = primary, switches = 0, submissions = 0, failSwitch = false;
	Object.defineProperty(f.ctx, "model", { get: () => model });
	Object.assign(f.ctx.modelRegistry, { find: () => fallback, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake" }) });
	Object.assign(f.pi, { setModel: async () => {
		if (failSwitch) throw new Error("fixture switch failure");
		switches++; model = fallback; return true;
	}, setThinkingLevel() {}, sendMessage() { submissions++; } });
	extension(f.pi);
	t.after(() => f.emit("session_shutdown"));
	const turn = async (errorMessage = "temporary timeout") => {
		const message = { role: "assistant", stopReason: "error", errorMessage, content: [] };
		await f.emit("message_end", { message }); await f.emit("turn_end", { message, toolResults: [] });
	};
	return { ...f, turn, switches: () => switches, submissions: () => submissions, failSwitch: () => { failSwitch = true; } };
}

test("real factory shares cancellation with failover and clears it before an unstarted fault", { timeout: 5000 }, async (t) => {
	const f = factoryRecovery(t), evidence = t.mock.method(MainRetryEvidence.prototype, "settle");
	await f.emit("session_start");
	const controller = new AbortController(); f.setSignal(controller.signal);
	await f.emit("agent_start"); await f.turn(); controller.abort(); f.setSignal(undefined);
	await f.emit("agent_settled");
	assert.equal(f.switches(), 0); assert.equal(f.submissions(), 0);
	assert.equal(evidence.mock.calls[0]!.arguments[0].cancelled, true);
	assert.match(f.notices.at(-1)!, /run was cancelled/);
	await f.turn("invalid non-retryable request"); await f.emit("agent_settled");
	assert.equal(evidence.mock.calls[1]!.arguments[0].cancelled, false);
	assert.equal(f.switches(), 0); assert.equal(f.submissions(), 0);
	assert.doesNotMatch(f.notices.at(-1)!, /cancelled/);
});

test("real factory recovery completion arms the settled wait after ownership releases", { timeout: 5000 }, async (t) => {
	const f = factoryRecovery(t);
	let release!: () => void, entered!: () => void;
	const validation = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	Object.assign(f.ctx.modelRegistry, { getApiKeyAndHeaders: async () => { entered(); await gate; return { ok: true, apiKey: "fake" }; } });
	const originalFinish = NotificationDispatcher.prototype.recoveryFinished, originalTimer = globalThis.setTimeout;
	let inFinish = false;
	const admissions: number[] = [];
	t.mock.method(NotificationDispatcher.prototype, "recoveryFinished", function (this: NotificationDispatcher) {
		inFinish = true; try { originalFinish.call(this); } finally { inFinish = false; }
	});
	t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
		if (inFinish) admissions.push(args[1]!);
		return originalTimer(...args);
	});
	await f.emit("session_start"); f.failSwitch(); await f.emit("agent_start"); await f.turn();
	const settling = f.emit("agent_settled");
	try {
		await validation;
		await f.emit("agent_settled"); assert.deepEqual(admissions, [], "recovery still owns settlement");
		release(); await settling;
		assert.deepEqual(admissions, [0], "the index observer releases the retained wait");
		assert.equal(f.submissions(), 0); assert.match(f.notices.at(-1)!, /fixture switch failure/);
	} finally { release(); await settling; }
});
