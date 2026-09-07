import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const WORKER_REMINDER_CUSTOM_TYPE = "slate-worker-reminder";

export const WORKER_REMINDER_TEXT =
	"Reminder: ALL INDEPENDENT TOOL CALLS MUST be issued SIMULTANEOUSLY in ONE TURN. Use separate turns only when results depend on each other or conflict.";

export interface WorkerReminderRuntime {
	extension: ExtensionFactory;
	handledToolResult(): boolean;
}

/** Create one hidden reminder component and its session-local delivery evidence. */
export function createWorkerReminderRuntime(): WorkerReminderRuntime {
	let sentThisTurn = false;
	let handledToolResult = false;
	const extension: ExtensionFactory = (pi) => {
		pi.on("message_end", (event) => {
			if (event.message.role === "assistant") sentThisTurn = false;
		});

		pi.on("tool_result", () => {
			handledToolResult = true;
			if (sentThisTurn) return;
			sentThisTurn = true;
			try {
				pi.sendMessage(
					{
						customType: WORKER_REMINDER_CUSTOM_TYPE,
						content: WORKER_REMINDER_TEXT,
						display: false,
					},
					{ deliverAs: "steer" },
				);
			} catch {
				sentThisTurn = false;
			}
		});
	};
	return { extension, handledToolResult: () => handledToolResult };
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
