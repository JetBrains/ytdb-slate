import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openWorkerSession } from "../extension/worker.ts";
import { REVIEWER_WRITING_GUIDANCE, WORKER_WRITING_GUIDANCE } from "../extension/writing-reminder.ts";
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

function reminderFixture(
	send?: (message: unknown, options: unknown) => void,
	writing?: Parameters<typeof createWorkerReminderRuntime>[0],
): {
	emit: (name: string, event: unknown) => void;
	completedTurn: (reason: unknown) => void;
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

	const runtime = createWorkerReminderRuntime(writing);
	runtime.extension(api);
	return {
		completedTurn: runtime.completedTurn,
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
		"Reminder: ALL INDEPENDENT TOOL CALLS MUST be issued SIMULTANEOUSLY in ONE TURN. Use separate turns only when results depend on each other or conflict. When codemode is available, use it to run independent tool calls together, chain dependent calls, or filter large output while keeping large intermediate data in script variables.",
	);
	assert.equal(Buffer.byteLength(WORKER_REMINDER_TEXT), 330);
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

test("nested results leave both reminder state fields untouched", () => {
	for (const event of [
		{ ...toolResult, parentToolCallId: "parent" },
		{ ...toolResult, parentToolCallId: "" },
		{ ...toolResult, toolCallId: "/1" },
	]) {
		const fixture = reminderFixture();
		fixture.emit("tool_result", event);
		assert.equal(fixture.handledToolResult(), false);
		assert.equal(workerReminderDeliveryMissing([], fixture.handledToolResult(), false), false);
		assert.deepEqual(fixture.sent, []);
		fixture.emit("tool_result", { ...toolResult, toolCallId: "ordinary/middle" });
		assert.equal(fixture.sent.length, 1);
		fixture.emit("message_end", { message: { role: "assistant" } });
		fixture.emit("tool_result", event);
		assert.equal(fixture.sent.length, 1, "late nested result cannot claim the next turn");
		fixture.emit("tool_result", toolResult);
		assert.equal(fixture.sent.length, 2);
	}
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

const header = "[slate] Reminder:\n\n";
function toolRound(fixture: ReturnType<typeof reminderFixture>) {
	fixture.emit("message_end", { message: { role: "assistant" } });
	fixture.emit("tool_result", toolResult);
	return (fixture.sent.at(-1)?.message as { content?: string })?.content;
}

test("cadence uses the reported completion reason, not the tool batch outcome", () => {
	const body = WORKER_WRITING_GUIDANCE;
	const combined = WORKER_REMINDER_TEXT + "\n\n" + body;
	const first = reminderFixture(undefined, { interval: 1, standalone: header + body });
	const second = reminderFixture(undefined, { interval: 1, standalone: header + body });
	assert.equal(toolRound(first), WORKER_REMINDER_TEXT);
	for (const reason of ["pending", "error", "length", "aborted"]) first.completedTurn(reason);
	assert.equal(toolRound(first), WORKER_REMINDER_TEXT);
	first.completedTurn("toolUse");
	assert.equal(toolRound(first), combined);
	assert.equal(toolRound(first), WORKER_REMINDER_TEXT);
	assert.equal(toolRound(second), WORKER_REMINDER_TEXT);
	second.completedTurn("stop");
	assert.equal(toolRound(second), combined);
});

test("due writing waits through nested results and never sends at turn end", () => {
	const fixture = reminderFixture(undefined, { interval: 1, standalone: header + WORKER_WRITING_GUIDANCE });
	fixture.completedTurn("stop");
	fixture.completedTurn("stop");
	assert.deepEqual(fixture.sent, []);
	fixture.emit("tool_result", { ...toolResult, parentToolCallId: "outer" });
	fixture.emit("tool_result", { ...toolResult, toolCallId: "/inner" });
	assert.deepEqual(fixture.sent, []);
	assert.equal(fixture.handledToolResult(), false);
	assert.equal(toolRound(fixture), WORKER_REMINDER_TEXT + "\n\n" + WORKER_WRITING_GUIDANCE);
	fixture.emit("tool_result", { ...toolResult, toolCallId: "parallel" });
	assert.equal(fixture.sent.length, 1);
});

test("worker forms and the standalone byte boundary include the header", () => {
	for (const [body, standaloneBytes, incrementBytes, combinedBytes] of [
		[WORKER_WRITING_GUIDANCE, 1180, 1163, 1493],
		[REVIEWER_WRITING_GUIDANCE, 562, 545, 875],
	] as const) {
		const fixture = reminderFixture(undefined, { interval: 1, standalone: header + body });
		fixture.completedTurn("stop");
		assert.equal(Buffer.byteLength(header + body), standaloneBytes);
		const combined = toolRound(fixture)!;
		assert.equal(combined, WORKER_REMINDER_TEXT + "\n\n" + body);
		assert.equal(Buffer.byteLength(combined.slice(WORKER_REMINDER_TEXT.length)), incrementBytes);
		assert.equal(Buffer.byteLength(combined), combinedBytes);
	}
	const oversized = reminderFixture(undefined, { interval: 1, standalone: header + WORKER_WRITING_GUIDANCE + "x" });
	oversized.completedTurn("stop");
	assert.equal(toolRound(oversized), WORKER_REMINDER_TEXT);
	assert.equal(toolRound(oversized), WORKER_REMINDER_TEXT);
});

test("worker cadence defaults invalid intervals to four and accepts twenty", () => {
	for (const [interval, expected] of [[undefined, 4], [0, 4], [1.5, 4], [21, 4], [20, 20]] as const) {
		const fixture = reminderFixture(undefined, { interval, standalone: header + REVIEWER_WRITING_GUIDANCE });
		for (let turn = 0; turn < expected; turn++) {
			assert.equal(toolRound(fixture), WORKER_REMINDER_TEXT);
			fixture.completedTurn("stop");
		}
		assert.equal(toolRound(fixture), WORKER_REMINDER_TEXT + "\n\n" + REVIEWER_WRITING_GUIDANCE);
	}
});

test("a synchronous combined send failure leaves writing due for the same-round retry", () => {
	const body = REVIEWER_WRITING_GUIDANCE;
	const combined = WORKER_REMINDER_TEXT + "\n\n" + body;
	let attempts = 0;
	const fixture = reminderFixture(() => {
		if (++attempts === 1) throw new Error("synchronous send failure");
	}, { interval: 1, standalone: header + body });
	fixture.completedTurn("stop");
	assert.equal(toolRound(fixture), combined);
	fixture.emit("tool_result", { ...toolResult, toolCallId: "retry" });
	fixture.emit("tool_result", { ...toolResult, toolCallId: "duplicate" });
	assert.equal(fixture.sent.length, 2);
	assert.equal((fixture.sent[1]?.message as { content: string }).content, combined);
	assert.equal(toolRound(fixture), WORKER_REMINDER_TEXT);
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
	mkdirSync(join(scratch, "project"));
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
			modelRegistry: {
				getRegisteredProviderIds: () => [],
				getRegisteredNativeProvider: () => undefined,
				getRegisteredProviderConfig: () => undefined,
			},
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
