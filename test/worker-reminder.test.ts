import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openWorkerSession } from "../extension/worker.ts";
import {
	isWorkerReminderMessage,
	createWorkerReminderRuntime,
	workerReminderDeliveryMissing,
	WORKER_REMINDER_CUSTOM_TYPE,
	WORKER_REMINDER_TEXT,
} from "../extension/worker-reminder.ts";

type Handler = (event: unknown, context?: unknown) => unknown;

interface SentMessage {
	message: unknown;
	options: unknown;
}

function reminderFixture(send?: (message: unknown, options: unknown) => void): {
	emit: (name: string, event: unknown) => void;
	handledToolResult: () => boolean;
	sent: SentMessage[];
} {
	const handlers = new Map<string, Handler[]>();
	const sent: SentMessage[] = [];
	const api = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
			send?.(message, options);
		},
	} as unknown as ExtensionAPI;

	const runtime = createWorkerReminderRuntime();
	runtime.extension(api);
	return {
		emit(name, event) {
			for (const handler of handlers.get(name) ?? []) handler(event);
		},
		handledToolResult: runtime.handledToolResult,
		sent,
	};
}

const toolResult = {
	type: "tool_result",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: "unchanged" }],
	details: { source: "fixture" },
	isError: false,
};

test("worker reminder contract is exact and separate from the writing reminder", () => {
	assert.equal(WORKER_REMINDER_CUSTOM_TYPE, "slate-worker-reminder");
	assert.equal(
		WORKER_REMINDER_TEXT,
		"Reminder: ALL INDEPENDENT TOOL CALLS MUST be issued SIMULTANEOUSLY in ONE TURN. Use separate turns only when results depend on each other or conflict.",
	);
	assert.equal(Buffer.byteLength(WORKER_REMINDER_TEXT), 150);
	assert.match(WORKER_REMINDER_TEXT, /^[\x00-\x7f]+$/);
	assert.notEqual(WORKER_REMINDER_CUSTOM_TYPE, "slate-writing-reminder");
});

test("factory sends once per turn without changing the tool result", () => {
	const fixture = reminderFixture();
	const original = structuredClone(toolResult);

	assert.equal(fixture.handledToolResult(), false);
	fixture.emit("tool_result", toolResult);
	assert.equal(fixture.handledToolResult(), true);
	fixture.emit("tool_result", { ...toolResult, toolCallId: "call-2" });
	fixture.emit("message_end", { message: { role: "user", content: "not a reset" } });
	fixture.emit("tool_result", { ...toolResult, toolCallId: "call-3" });

	assert.deepEqual(fixture.sent, [{
		message: {
			customType: "slate-worker-reminder",
			content: WORKER_REMINDER_TEXT,
			display: false,
		},
		options: { deliverAs: "steer" },
	}]);
	assert.deepEqual(toolResult, original);

	fixture.emit("message_end", { message: { role: "assistant", content: [] } });
	fixture.emit("tool_result", { ...toolResult, toolCallId: "call-4" });
	assert.equal(fixture.sent.length, 2);
});

test("factory claims synchronously and retries after a synchronous send failure", () => {
	let fixture: ReturnType<typeof reminderFixture>;
	let calls = 0;
	fixture = reminderFixture(() => {
		calls += 1;
		if (calls === 1) throw new Error("queue unavailable");
		if (calls === 2) fixture.emit("tool_result", { ...toolResult, toolCallId: "nested" });
	});

	fixture.emit("tool_result", toolResult);
	fixture.emit("tool_result", { ...toolResult, toolCallId: "retry" });

	assert.equal(calls, 2);
	assert.equal(fixture.sent.length, 2);
});

test("factory state is local to concurrently interleaved worker sessions", () => {
	const first = reminderFixture();
	const second = reminderFixture();

	first.emit("tool_result", { ...toolResult, toolCallId: "first-a" });
	second.emit("tool_result", { ...toolResult, toolCallId: "second-a" });
	first.emit("tool_result", { ...toolResult, toolCallId: "first-b" });
	second.emit("tool_result", { ...toolResult, toolCallId: "second-b" });

	assert.equal(first.sent.length, 1);
	assert.equal(second.sent.length, 1);
});

test("worker reminder message predicate rejects malformed and hostile values", () => {
	assert.equal(isWorkerReminderMessage({ role: "custom", customType: WORKER_REMINDER_CUSTOM_TYPE }), true);
	assert.equal(isWorkerReminderMessage({ role: "custom", customType: "other" }), false);
	assert.equal(isWorkerReminderMessage({ role: "toolResult", customType: WORKER_REMINDER_CUSTOM_TYPE }), false);
	assert.equal(isWorkerReminderMessage(null), false);
	assert.equal(isWorkerReminderMessage("message"), false);

	const hostile = {};
	Object.defineProperty(hostile, "role", {
		get() {
			throw new Error("unreadable role");
		},
	});
	assert.equal(isWorkerReminderMessage(hostile), false);
});

test("worker loader reports component loading errors with an empty allowlist", { timeout: 5000 }, async () => {
	const scratch = mkdtempSync(join(tmpdir(), "slate-worker-reminder-loader-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
	const originalWarn = console.warn;
	const warnings: string[] = [];
	process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
	process.env.PI_OFFLINE = "1";
	DefaultResourceLoader.prototype.getExtensions = function getExtensions() {
		return {
			...originalGetExtensions.call(this),
			extensions: [],
			errors: [{ path: "bad\ncomponent", error: "failed\rto load" }],
		};
	};
	console.warn = (message?: unknown) => warnings.push(String(message));
	let session: Awaited<ReturnType<typeof openWorkerSession>> | undefined;
	try {
		const ctx = {
			cwd: join(scratch, "project"),
			hasUI: false,
			isProjectTrusted: () => false,
			model: undefined,
		} as unknown as ExtensionContext;
		session = await openWorkerSession({ ctx, extensionPaths: [] });
		assert.deepEqual(warnings, ["slate: worker extension failed to load — badcomponent: failedto load"]);
	} finally {
		session?.dispose();
		DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
		console.warn = originalWarn;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("delivery detection requires intact history and session-local handler evidence", () => {
	const reminder = { role: "custom", customType: WORKER_REMINDER_CUSTOM_TYPE };
	assert.equal(workerReminderDeliveryMissing([], false, false), false);
	assert.equal(workerReminderDeliveryMissing([{ role: "toolResult" }], false, false), false);
	assert.equal(workerReminderDeliveryMissing([], true, false), true);
	assert.equal(workerReminderDeliveryMissing([{ role: "toolResult" }], true, false), true);
	assert.equal(workerReminderDeliveryMissing([], true, true), false);
	assert.equal(workerReminderDeliveryMissing([{ role: "toolResult" }, reminder], true, false), false);
	assert.equal(workerReminderDeliveryMissing([
		{ role: "toolResult" },
		{ role: "assistant" },
		{ role: "toolResult" },
		reminder,
	], true, false), false);
	assert.equal(workerReminderDeliveryMissing([{ role: "custom", customType: "other" }], true, false), true);
});
