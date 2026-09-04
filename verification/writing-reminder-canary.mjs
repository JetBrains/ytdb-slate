import { appendFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const EVIDENCE = process.env.SLATE_REMINDER_EVIDENCE;
const TOOL_MARKER = process.env.SLATE_REMINDER_TOOL_MARKER;
const TOOL_NAME = "writing_reminder_canary";
const CUSTOM_TYPE = "slate-writing-reminder";
// This independent copy makes the integration check detect any shipped-renderer drift.
const REMINDER = `[slate] Reminder:

Writing requirements:
- Avoid idioms.
- Replace bare-reference openers with the subject they reference.
- Explain each project-specific term at first use.
- Define each abbreviation at first use.
- Express one idea in each sentence.
- Use one term for each concept.
- Do not explain an idea with a metaphor.
- Do not invent a term when the project already has one.
- Use plain words that appear in standard libraries and textbooks.

Design requirements:
- Keep a design statement only if a different reasonable implementation keeps it true.
- Present to the user any item the approved goals do not list.
- Never add or remove an approved goal yourself.
- Propose a repeated regression as a non-goal candidate.
- Present what changed when you update a design.
- Assume the user knows software but not this project.

Exclude research logs, worker task text, and the project's own agent instruction file.`;
const SUCCESS = "SLATE_REMINDER_REACHED_NEXT_MODEL_CALL_7f31c2";

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

function message(model, content, stopReason, usage) {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usage.input + usage.output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function completedStream(output) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...output, stopReason: "pending" } });
		stream.push({ type: "done", reason: output.stopReason, message: output });
		stream.end();
	});
	return stream;
}

export default function reminderCanary(pi) {
	let calls = 0;
	let sessionMeta = {};
	let observedCustomMetadata = false;
	let observedDeliveryId;

	pi.on("session_start", (_event, ctx) => {
		sessionMeta = { trusted: ctx.isProjectTrusted(), cwd: ctx.cwd };
	});
	pi.on("message_start", (event) => {
		const item = event.message;
		if (item?.role === "custom" && item.customType === CUSTOM_TYPE && textOf(item.content) === REMINDER) {
			observedCustomMetadata = true;
			observedDeliveryId = item.details?.deliveryId;
		}
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Writing reminder integration canary",
		description: "Execute the deterministic writing-reminder integration canary.",
		parameters: Type.Object({}),
		async execute() {
			appendFileSync(TOOL_MARKER, "executed\n");
			return { content: [{ type: "text", text: "CANARY_TOOL_RESULT_ONLY" }], details: { canary: true } };
		},
	});

	// Slate restricts tools after `/slate on`. This handler runs after slate's
	// before_agent_start handler and adds only this test tool to that real set.
	pi.on("before_agent_start", () => {
		const active = pi.getActiveTools();
		if (!active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
	});

	pi.registerProvider("slate-reminder-fake", {
		name: "Slate reminder offline canary",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "offline-canary-key",
		api: "openai-completions",
		models: [{
			id: "reminder-model",
			name: "Reminder model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 1_024,
		}],
		streamSimple(model, context) {
			calls += 1;
			if (calls === 1) {
				const output = message(model, [
					{ type: "toolCall", id: "writing-reminder-call-1", name: TOOL_NAME, arguments: {} },
					{ type: "toolCall", id: "writing-reminder-call-2", name: TOOL_NAME, arguments: {} },
				], "toolUse", { input: 25_000, output: 1 });
				return completedStream(output);
			}

			// Pi normalizes custom messages to user messages at the provider boundary.
			// The message_start observation proves the pre-normalization metadata. This
			// provider observation proves the exact content reached the next API call.
			const reminderInputs = context.messages.filter(
				(item) => item?.role === "user" && textOf(item.content) === REMINDER,
			);
			const deliveryIdSafe = Number.isSafeInteger(observedDeliveryId) && observedDeliveryId > 0;
			const providerReminderDetailsAbsent = reminderInputs.every(
				(item) => !Object.prototype.hasOwnProperty.call(item, "details"),
			);
			const observed = {
				...sessionMeta,
				expectedReminder: REMINDER,
				calls,
				processCwd: process.cwd(),
				reminderCount: reminderInputs.length,
				providerReminderContents: reminderInputs.map((item) => textOf(item.content)),
				customMetadataObserved: observedCustomMetadata,
				deliveryId: observedDeliveryId,
				deliveryIdSafe,
				providerReminderDetailsAbsent,
				messageShapes: context.messages.map((item) => ({
					role: item?.role,
					text: textOf(item?.content),
					detailsPresent: Object.prototype.hasOwnProperty.call(item, "details"),
				})),
				exactReminder:
					reminderInputs.length === 1 && observedCustomMetadata && deliveryIdSafe && providerReminderDetailsAbsent,
			};
			writeFileSync(EVIDENCE, JSON.stringify(observed, null, 2));
			const answer = observed.exactReminder ? SUCCESS : "SLATE_REMINDER_MISSING_FROM_NEXT_MODEL_CALL";
			return completedStream(message(model, [{ type: "text", text: answer }], "stop", { input: 25_100, output: 1 }));
		},
	});
}
