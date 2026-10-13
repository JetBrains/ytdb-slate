import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationDispatcher, type NotificationDispatcherOptions } from "../extension/notification-dispatcher.ts";
import { resolveNotificationSettings } from "../extension/notification-config.ts";

const settings = resolveNotificationSettings({ minimumDelayMs: 0, cooldownMs: 0, detail: "message" }, undefined, () => {});
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
function arm(dispatcher: NotificationDispatcher) { dispatcher.runStart(); dispatcher.message({ role: "assistant", stopReason: "stop" }); dispatcher.settled(); }
function options(deliver: () => void): NotificationDispatcherOptions {
	return { mode: "tui", cwd: "/", settings, channels: [{ name: "native", prepare: async () => deliver }], current: () => true,
		idle: () => true, queued: () => false, recovering: () => false };
}
for (const phase of ["retire-unstarted", "lose-owner-at-callback"] as const) {
	test(`real timers release channel slots after ${phase}`, { timeout: 5000 }, async (t) => {
		let current = true, invoked = false, complete!: () => void;
		const a = new NotificationDispatcher({ ...options(() => { invoked = true; }), current: () => current,
			idle: () => { queueMicrotask(() => { if (phase === "retire-unstarted") a.retire(); else current = false; }); return true; } });
		t.after(() => a.retire()); arm(a); await pause(); assert.equal(invoked, false);
		const delivered = new Promise<void>((resolve) => { complete = resolve; });
		const b = new NotificationDispatcher(options(complete)); t.after(() => b.retire()); arm(b);
		let deadline!: ReturnType<typeof setTimeout>;
		try { await Promise.race([delivered, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("channel slot was not released")), 1000); })]); }
		finally { clearTimeout(deadline); a.retire(); b.retire(); }
	});
}
test("default admission timer contains throwing message access and leaves later delivery usable", { timeout: 5000 }, async (t) => {
	let badDeliveries = 0, reads = 0;
	const a = new NotificationDispatcher(options(() => { badDeliveries++; })); t.after(() => a.retire());
	a.runStart(); a.message({ role: "assistant", stopReason: "stop", get content(): never { reads++; throw new Error("private transformed message"); } }); a.settled();
	await pause(); assert.equal(reads, 1); assert.equal(badDeliveries, 0);
	let complete!: () => void;
	const delivered = new Promise<void>((resolve) => { complete = resolve; });
	const b = new NotificationDispatcher(options(complete)); t.after(() => b.retire()); arm(b);
	let deadline!: ReturnType<typeof setTimeout>;
	try { await Promise.race([delivered, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("later delivery blocked")), 1000); })]); }
	finally { clearTimeout(deadline); a.retire(); b.retire(); }
});
