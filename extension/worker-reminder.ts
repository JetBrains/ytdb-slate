import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { WRITING_REMINDER_HEADER } from "./writing-reminder.ts";
import { DEFAULT_REMIND_TURNS, isWritingRemindTurns } from "./writing.ts";

export const WORKER_REMINDER_CUSTOM_TYPE = "slate-worker-reminder";

export const WORKER_REMINDER_TEXT =
	"Reminder: ALL INDEPENDENT TOOL CALLS MUST be issued SIMULTANEOUSLY in ONE TURN. Use separate turns only when results depend on each other or conflict. When codemode is available, use it to run independent tool calls together, chain dependent calls, or filter large output while keeping large intermediate data in script variables.";

const MAX_WRITING_BYTES = 1180;
const WRITING_HEADER = `${WRITING_REMINDER_HEADER}\n\n`;

function combinedReminder(standalone: string): string | undefined {
	if (!standalone.startsWith(WRITING_HEADER) || Buffer.byteLength(standalone) > MAX_WRITING_BYTES) return;
	const increment = `\n\n${standalone.slice(WRITING_HEADER.length)}`;
	return Buffer.byteLength(increment) <= MAX_WRITING_BYTES ? WORKER_REMINDER_TEXT + increment : undefined;
}

export interface WorkerReminderRuntime {
	extension: ExtensionFactory;
	handledToolResult(): boolean;
	completedTurn(reason: unknown): void;
}

/** Create one hidden reminder component with session-local cadence and delivery evidence. */
export function createWorkerReminderRuntime(writing?: { interval?: number; standalone: string }): WorkerReminderRuntime {
	const interval = isWritingRemindTurns(writing?.interval) ? writing.interval : DEFAULT_REMIND_TURNS;
	const standalone = writing?.standalone;
	let turns = 0;
	let sentThisTurn = false;
	let handledToolResult = false;
	const extension: ExtensionFactory = (pi) => {
		pi.on("message_end", (event) => {
			if (event.message.role === "assistant") sentThisTurn = false;
		});

		pi.on("tool_result", (event) => {
			if (event.parentToolCallId !== undefined || event.toolCallId.startsWith("/")) return;
			handledToolResult = true;
			if (sentThisTurn) return;
			sentThisTurn = true;
			let combined: string | undefined;
			if (standalone !== undefined && turns === interval) {
				try { combined = combinedReminder(standalone); }
				catch { /* The tool reminder still uses its send slot. */ }
			}
			try {
				pi.sendMessage(
					{
						customType: WORKER_REMINDER_CUSTOM_TYPE,
						content: combined ?? WORKER_REMINDER_TEXT,
						display: false,
					},
					{ deliverAs: "steer" },
				);
				if (combined !== undefined) turns = 0;
			} catch {
				sentThisTurn = false;
			}
		});
	};
	return {
		extension,
		handledToolResult: () => handledToolResult,
		completedTurn(reason) {
			if (standalone !== undefined && turns < interval && (reason === "stop" || reason === "toolUse")) turns++;
		},
	};
}

/** Match a persisted worker reminder without trusting the message shape or its property accessors. */
export function isWorkerReminderMessage(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	try {
		const candidate = message as { role?: unknown; customType?: unknown };
		return candidate.role === "custom" && candidate.customType === WORKER_REMINDER_CUSTOM_TYPE;
	} catch {
		return false;
	}
}

/** Detect a missing reminder only when the action history stayed intact after the handler ran. */
export function workerReminderDeliveryMissing(
	messages: readonly unknown[],
	handledToolResult: boolean,
	actionCompacted: boolean,
): boolean {
	return handledToolResult && !actionCompacted && !messages.some(isWorkerReminderMessage);
}
