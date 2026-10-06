import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { NotificationDispatcher, type NotificationChannel, type NotificationDispatcherOptions } from "../extension/notification-dispatcher.ts";
import { resolveNotificationSettings } from "../extension/notification-config.ts";
import { classifyRunOutcome } from "../extension/run-outcome.ts";
import { MainRetryEvidence } from "../extension/logical-model-adapters.ts";

function fixture(config: unknown = {}, names: NotificationChannel["name"][] = ["native"], mode = "tui") {
	let time = 0, current = true, idle = true, queued = false, recovering = false;
	const timers = new Set<{ at: number; callback: () => void }>();
	const allCallbacks: Array<() => void> = [];
	const delivered: Array<{ name: string; title: string; body: string }> = [];
	const channels: NotificationChannel[] = names.map((name) => ({ name, prepare: async (text) => () => { delivered.push({ name, ...text }); } }));
	const options: NotificationDispatcherOptions = {
		mode, cwd: "/private/project", settings: resolveNotificationSettings({ minimumDelayMs: 30, cooldownMs: 60, ...config as object }, undefined, () => {}), channels,
		current: () => current, idle: () => idle, queued: () => queued, recovering: () => recovering,
		now: () => time, schedule: (delay, callback) => {
			const timer = { at: time + delay, callback };
			timers.add(timer); allCallbacks.push(callback);
			return () => { timers.delete(timer); };
		},
	};
	const dispatcher = new NotificationDispatcher(options);
	const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
	const advance = async (amount: number) => {
		time += amount;
		for (const timer of [...timers]) if (timer.at <= time) { timers.delete(timer); timer.callback(); }
		await flush();
	};
	const settle = (stopReason = "stop") => { dispatcher.runStart(); dispatcher.message({ role: "assistant", stopReason, content: "agent" }); dispatcher.settled(); };
	return { dispatcher, options, channels, delivered, timers, allCallbacks, advance, flush, settle,
		set current(value: boolean) { current = value; }, set idle(value: boolean) { idle = value; },
		set queued(value: boolean) { queued = value; }, set recovering(value: boolean) { recovering = value; } };
}

test("session start and unobserved settlement arm nothing in every noninteractive mode", async () => {
	for (const mode of ["tui", "rpc", "print"]) {
		const f = fixture({}, undefined, mode);
		f.dispatcher.settled(); assert.equal(f.timers.size, 0);
		if (mode !== "tui") { f.settle(); f.dispatcher.dialog(true); assert.equal(f.timers.size, 0); }
		await f.advance(100); assert.deepEqual(f.delivered, []);
	}
});
test("settlement starts one delay and timestamp-only activity restarts it with one timer", async () => {
	const f = fixture(); f.settle(); f.dispatcher.settled();
	assert.equal(f.timers.size, 1, "duplicate settlement does not replace its wait");
	await f.advance(29); assert.equal(f.delivered.length, 0);
	const paste = "x".repeat(1_000_000);
	for (const _key of paste) f.dispatcher.activity();
	assert.equal(f.timers.size, 1);
	await f.advance(1); await f.advance(28); assert.equal(f.delivered.length, 0);
	await f.advance(1); assert.equal(f.delivered.length, 0, "admission does not deliver inside its timer");
	await f.advance(0); assert.equal(f.delivered.length, 1);
	await f.advance(200); assert.equal(f.delivered.length, 1);
});
test("new runs cancel only run waits and dialog admission permits an active agent", async () => {
	const f = fixture(); f.settle(); f.dispatcher.dialog(true); f.idle = false; f.dispatcher.runStart();
	assert.equal(f.timers.size, 1);
	await f.advance(30); await f.advance(0);
	assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.title, "Input needed");
});
test("unclamped reversed dialog events and overlapping starts preserve the open count", async () => {
	const f = fixture(); f.dispatcher.dialog(false); f.dispatcher.dialog(true);
	assert.equal(f.timers.size, 0);
	f.dispatcher.dialog(true); f.dispatcher.dialog(true); f.dispatcher.dialog(false);
	assert.equal(f.timers.size, 1);
	await f.advance(29); f.dispatcher.dialog(false); await f.advance(1); await f.advance(0);
	assert.equal(f.delivered.length, 0);
	f.dispatcher.dialog(true); await f.advance(30); await f.advance(0); assert.equal(f.delivered.length, 1);
});
test("run and dialog admission share cooldown while error uses its own equality boundary", async () => {
	const f = fixture(); f.settle(); f.dispatcher.dialog(true);
	await f.advance(30); await f.advance(0); assert.equal(f.delivered.length, 1);
	f.settle("error"); await f.advance(30); await f.advance(0); assert.equal(f.delivered.length, 2);
	f.settle(); await f.advance(30); await f.advance(0); assert.equal(f.delivered.length, 3);
	f.settle(); await f.advance(30); await f.advance(0); assert.equal(f.delivered.length, 3);
	await f.advance(100); assert.equal(f.delivered.length, 3, "cooldown drops, not retries");
});
test("Slate recovery holds settlement and successful recovery replaces the error", async () => {
	const f = fixture({ minimumDelayMs: 0 }); f.recovering = true; f.settle("error");
	assert.equal(f.timers.size, 0); await f.advance(0); assert.equal(f.delivered.length, 0);
	f.dispatcher.runStart(); f.dispatcher.message({ role: "assistant", stopReason: "stop", content: "recovered" }); f.dispatcher.settled();
	f.recovering = false; f.dispatcher.recoveryFinished(); await f.advance(0); await f.advance(0);
	assert.equal(f.delivered[0]!.title, "Input needed");
	const failed = fixture(); failed.recovering = true; failed.settle("error");
	failed.recovering = false; failed.dispatcher.recoveryFinished(); await failed.advance(30); await failed.advance(0);
	assert.equal(failed.delivered[0]!.title, "Error");
});
test("failed admission cancels permanently for idle, queue, recovery, ownership and dialog checks", async () => {
	for (const flag of ["idle", "queued", "recovering", "current"] as const) {
		const f = fixture(); f.settle(); f[flag] = flag === "queued" || flag === "recovering";
		await f.advance(30); f[flag] = flag === "idle" || flag === "current";
		await f.advance(100); assert.equal(f.delivered.length, 0, flag); assert.equal(f.timers.size, 0);
	}
});
test("stop evidence suppresses run notifications, including overflow cancellation, but Esc alone does not", async () => {
	for (const reason of ["aborted", "signal", "overflow"]) {
		const f = fixture(); const controller = new AbortController();
		f.dispatcher.runStart(reason === "signal" ? controller.signal : undefined);
		f.dispatcher.message({ role: "assistant", stopReason: reason === "aborted" ? "aborted" : "error" });
		if (reason === "overflow") f.dispatcher.observeSignal(controller.signal);
		controller.abort(); f.dispatcher.settled(); await f.advance(100);
		assert.equal(f.delivered.length, 0, reason);
	}
	for (const reason of ["error", "stop"]) {
		const f = fixture(); f.settle(reason); f.dispatcher.activity(); await f.advance(30); await f.advance(0);
		assert.equal(f.delivered[0]!.title, reason === "error" ? "Error" : "Input needed");
	}
});
test("admission freezes permitted text, excludes dialog titles, thinking and tool content, and uses error fallback", async () => {
	const f = fixture({ detail: "message", push: { enabled: true, server: "https://example.test", topic: "topic" } }, ["native", "push"]);
	f.dispatcher.message({ role: "assistant", content: [{ type: "text", text: "head" + "é".repeat(100) }, { type: "thinking", text: "secret" }, { type: "toolCall", text: "secret" }] });
	f.dispatcher.dialog(true); await f.advance(30); f.dispatcher.activity(); f.dispatcher.message({ role: "assistant", content: "later" });
	await f.advance(0); assert.equal(f.delivered[0]!.body, "project: …" + "é".repeat(100)); assert.equal(f.delivered[1]!.body, "");
	const error = fixture({ detail: "message" }); error.dispatcher.runStart(); error.dispatcher.message({ role: "assistant", stopReason: "error", errorMessage: "provider\x1b" });
	error.dispatcher.settled(); await error.advance(30); await error.advance(0); assert.equal(error.delivered[0]!.body, "project: …provider");
	const generic = fixture(); generic.dispatcher.runStart(); generic.dispatcher.message({ role: "assistant", stopReason: "stop", get content(): never { throw new Error("must not read"); } });
	generic.dispatcher.settled(); await generic.advance(30); await generic.advance(0); assert.equal(generic.delivered.length, 1);
});
test("non-assistant messages cannot supply run or dialog text to native or push", async () => {
	for (const role of ["toolResult", "user", "custom"]) for (const kind of ["run", "dialog"]) {
		const f = fixture({ detail: "message", pushDetail: "message", push: { enabled: true, server: "https://example.test", topic: "topic" } }, ["native", "push"]);
		try {
			f.dispatcher.runStart();
			if (kind === "dialog") f.dispatcher.message({ role: "assistant", stopReason: "stop", content: "agent" });
			f.dispatcher.message({ role, stopReason: "error", content: "AWS_SECRET_ACCESS_KEY=abc123" });
			if (kind === "run") f.dispatcher.settled(); else f.dispatcher.dialog(true);
			await f.advance(30); await f.advance(0);
			assert.equal(f.delivered.length, 2);
			for (const delivery of f.delivered) {
				assert.equal(delivery.title, "Input needed");
				assert.equal(delivery.body, kind === "dialog" ? "project: …agent" : "project", `${role} ${kind}`);
			}
		} finally { f.dispatcher.retire(); }
	}
});
test("a custom message after an assistant error cannot replace its outcome or text", async () => {
	const f = fixture({ detail: "message", pushDetail: "message", push: { enabled: true, server: "https://example.test", topic: "topic" } }, ["native", "push"]);
	try {
		f.dispatcher.runStart();
		f.dispatcher.message({ role: "assistant", stopReason: "error", errorMessage: "provider failure" });
		f.dispatcher.message({ role: "custom", stopReason: "stop", content: "extension text" });
		f.dispatcher.settled(); await f.advance(30); await f.advance(0);
		assert.equal(f.delivered.length, 2);
		for (const delivery of f.delivered) {
			assert.equal(delivery.title, "Error");
			assert.equal(delivery.body, "project: …provider failure");
		}
	} finally { f.dispatcher.retire(); }
});
test("no enabled channel consumes no cooldown", async () => {
	const f = fixture({}, []); f.settle(); await f.advance(30);
	f.channels.push({ name: "native", prepare: async () => () => { f.delivered.push({ name: "native", title: "added", body: "" }); } });
	f.settle(); await f.advance(30); await f.advance(0); assert.equal(f.delivered.length, 1);
});
test("one in-flight attempt per channel drops excess without blocking independent channels", async () => {
	const f = fixture({ cooldownMs: 0 }, ["native", "terminal"]);
	let release!: () => void, attempts = 0;
	f.channels[0]!.prepare = async () => { attempts++; await new Promise<void>((resolve) => { release = resolve; }); return () => {}; };
	f.settle(); await f.advance(30); await f.advance(0);
	f.settle(); await f.advance(30); await f.advance(0);
	assert.equal(attempts, 1); assert.equal(f.delivered.length, 2);
	release(); await f.flush(); f.channels[0]!.prepare = async () => { attempts++; throw new Error("private error"); };
	f.settle(); await f.advance(30); await f.advance(0); assert.equal(attempts, 2); assert.equal(f.delivered.length, 3);
	f.channels[0]!.prepare = async () => () => { throw new Error("private error"); };
	f.settle(); await f.advance(30); await f.advance(0); assert.equal(f.delivered.length, 4);
});
test("channel slots survive retirement across dispatcher instances until work settles", async () => {
	for (const name of ["native", "push"] as const) for (const phase of ["preparation", "delivery"]) {
		const config = { minimumDelayMs: 0, cooldownMs: 0, push: { enabled: true, server: "https://example.test", topic: "topic" } };
		const a = fixture(config, [name]), b = fixture(config, [name, "terminal"]);
		let release!: () => void, signal: AbortSignal | undefined, preparations = 0, deliveries = 0;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		a.channels[0]!.prepare = async (_text, observed) => {
			signal = observed; preparations++;
			if (phase === "preparation") await pending;
			return async () => { deliveries++; if (phase === "delivery") await pending; };
		};
		try {
			a.settle(); await a.advance(0); await a.advance(0);
			assert.equal(preparations, 1);
			assert.equal(deliveries, phase === "delivery" ? 1 : 0);
			a.dispatcher.retire(); assert.equal(signal?.aborted, true);
			b.settle(); await b.advance(0); await b.advance(0);
			assert.deepEqual(b.delivered.map((delivery) => delivery.name), ["terminal"], `${name} ${phase}`);
			a.allCallbacks.at(-1)!(); await a.flush();
			b.settle(); await b.advance(0); await b.advance(0);
			assert.deepEqual(b.delivered.map((delivery) => delivery.name), ["terminal", "terminal"]);
			assert.equal(preparations, 1, "stale callbacks cannot restart the retired attempt");
			release(); await a.flush();
			assert.equal(deliveries, phase === "delivery" ? 1 : 0, "retirement blocks unaccepted delivery");
			b.settle(); await b.advance(0); await b.advance(0);
			assert.deepEqual(b.delivered.map((delivery) => delivery.name), ["terminal", "terminal", name, "terminal"]);
		} finally { release(); await a.flush(); a.dispatcher.retire(); b.dispatcher.retire(); }
	}
});
test("retirement is synchronous and stale timer and preparation callbacks cannot deliver", async () => {
	for (const phase of ["wait", "scheduled", "prepared"]) {
		const f = fixture(); let release: (() => void) | undefined; let signal: AbortSignal | undefined;
		const deliveries: string[] = [];
		f.channels[0]!.prepare = async (_text, observed) => { signal = observed; await new Promise<void>((resolve) => { release = resolve; }); return () => { deliveries.push(phase); }; };
		try {
			f.settle(); if (phase !== "wait") await f.advance(30); if (phase === "prepared") await f.advance(0);
			f.dispatcher.retire(); f.dispatcher.retire(); assert.equal(f.timers.size, 0);
			if (signal) { assert.equal(signal.aborted, true); release!(); }
			for (const callback of f.allCallbacks) callback(); await f.flush();
			f.dispatcher.settled(); f.dispatcher.dialog(true); f.dispatcher.runStart(); f.dispatcher.message({ role: "assistant", content: "retired" });
			assert.equal(f.timers.size, 0); assert.deepEqual(deliveries, [], `${phase} never calls delivery`);
			assert.equal(f.delivered.length, 0);
		} finally { release?.(); await f.flush(); f.dispatcher.retire(); }
	}
});
test("classifier and MainRetryEvidence use cancellation before final-error evidence", () => {
	for (const stopReason of ["stop", "length", "toolUse"]) assert.equal(classifyRunOutcome({ stopReason }), "success");
	assert.equal(classifyRunOutcome(undefined), "unknown"); assert.equal(classifyRunOutcome({ stopReason: "other" }), "unknown");
	assert.equal(classifyRunOutcome({ stopReason: { toString() { throw new Error("untrusted"); } } }), "unknown");
	assert.equal(classifyRunOutcome({ stopReason: "error" }), "error"); assert.equal(classifyRunOutcome({ stopReason: "aborted" }), "cancelled");
	for (const stopReason of [undefined, "error", "stop"]) {
		const evidence = new MainRetryEvidence();
		if (stopReason !== undefined) evidence.observe({ stopReason }, "p/m", "high");
		assert.equal(classifyRunOutcome(stopReason === undefined ? undefined : { stopReason }, true), "cancelled");
		assert.equal(evidence.settle({ route: "p/m", effort: "high", policy: { enabled: true, maxRetries: 0, baseDelayMs: 0 }, cancelled: true, isRetryable: () => true, isContextOverflow: () => false }).kind, "cancelled", `cancellation wins over ${stopReason ?? "empty"} evidence`);
	}
});
test("bell and disabled push need no message while permitted push detail stays independent", async () => {
	for (const names of [["bell"], ["native"]] as NotificationChannel["name"][][]) {
		const f = fixture({ detail: names[0] === "bell" ? "message" : "generic", pushDetail: "message" }, names);
		f.dispatcher.runStart(); f.dispatcher.message({ role: "assistant", get content(): never { throw new Error("must not read"); } });
		f.dispatcher.settled(); await f.advance(30); await f.advance(0);
		assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.body, "");
		if (names[0] === "bell") assert.equal(f.delivered[0]!.title, "");
	}
	const f = fixture({ pushDetail: "message", push: { enabled: true, server: "https://example.test", topic: "topic" } }, ["native", "push"]);
	f.dispatcher.runStart(); f.dispatcher.message({ role: "assistant", stopReason: "error", content: [{ type: "thinking", text: "excluded" }], errorMessage: "provider" });
	f.dispatcher.settled(); await f.advance(30); await f.advance(0);
	assert.equal(f.delivered[0]!.body, ""); assert.equal(f.delivered[1]!.body, "project: …provider");
});
test("ownership loss during preparation and stale eligibility getters fail closed", async () => {
	const f = fixture(); let release!: () => void;
	f.channels[0]!.prepare = async () => { await new Promise<void>((resolve) => { release = resolve; }); return () => { f.delivered.push({ name: "native", title: "stale", body: "" }); }; };
	f.settle(); await f.advance(30); await f.advance(0); f.current = false; release(); await f.flush();
	assert.equal(f.delivered.length, 0);
	for (const field of ["current", "recovering", "idle", "queued"] as const) {
		const host = fixture();
		const dispatcher = new NotificationDispatcher({ ...host.options, [field]: () => { throw new Error("stale context"); } });
		dispatcher.runStart(); dispatcher.message({ role: "assistant", stopReason: "stop" }); dispatcher.settled();
		await host.advance(100); assert.equal(host.delivered.length, 0); dispatcher.retire();
	}
});
test("new runs discard earlier run text but preserve completed session text for dialogs", async () => {
	const f = fixture({ detail: "message", cooldownMs: 0 }); f.settle(); f.dispatcher.runStart(); f.dispatcher.settled();
	await f.advance(30); await f.advance(0); assert.equal(f.delivered[0]!.body, "project");
	f.dispatcher.dialog(true); await f.advance(30); await f.advance(0); assert.equal(f.delivered[1]!.body, "project: …agent");
	const empty = fixture({ detail: "message" }); empty.dispatcher.runStart(); empty.dispatcher.message({ role: "assistant", stopReason: "error", content: "", errorMessage: "fallback" });
	empty.dispatcher.settled(); await empty.advance(30); await empty.advance(0); assert.equal(empty.delivered[0]!.body, "project: …fallback");
});
test("delivery itself holds the channel slot until it finishes", async () => {
	const f = fixture({ cooldownMs: 0 }); let release!: () => void, attempts = 0;
	f.channels[0]!.prepare = async () => async () => { attempts++; await new Promise<void>((resolve) => { release = resolve; }); };
	f.settle(); await f.advance(30); await f.advance(0); f.settle(); await f.advance(30); await f.advance(0);
	assert.equal(attempts, 1); release(); await f.flush();
	f.settle(); await f.advance(30); await f.advance(0); assert.equal(attempts, 2); release(); await f.flush();
});
test("default timers deliver in background and pending waits do not keep Node alive", { timeout: 5000 }, async (t) => {
	const f = fixture({ minimumDelayMs: 0 });
	let complete!: () => void;
	const delivered = new Promise<void>((resolve) => { complete = resolve; });
	f.channels[0]!.prepare = async (text) => () => { f.delivered.push({ name: "native", ...text }); complete(); };
	const dispatcher = new NotificationDispatcher({ ...f.options, now: undefined, schedule: undefined });
	t.after(() => dispatcher.retire());
	dispatcher.runStart(); dispatcher.message({ role: "assistant", stopReason: "stop" }); dispatcher.settled();
	assert.equal(f.delivered.length, 0);
	let deadline!: ReturnType<typeof setTimeout>;
	try {
		await Promise.race([delivered, new Promise<never>((_resolve, reject) => {
			deadline = setTimeout(() => reject(new Error("delivery did not complete")), 1000);
		})]);
		assert.equal(f.delivered.length, 1);
	} finally { clearTimeout(deadline); dispatcher.retire(); }
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import { NotificationDispatcher } from ${JSON.stringify(new URL("../extension/notification-dispatcher.ts", import.meta.url).href)};
		import { NOTIFICATION_DEFAULTS } from ${JSON.stringify(new URL("../extension/notification-config.ts", import.meta.url).href)};
		const dispatcher = new NotificationDispatcher({ mode: "tui", cwd: "/", settings: NOTIFICATION_DEFAULTS, channels: [], current: () => true, idle: () => true, queued: () => false, recovering: () => false });
		dispatcher.runStart(); dispatcher.settled();
	`], { timeout: 3000, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined);
});
