import { appendFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const EVIDENCE = process.env.SLATE_REMINDER_EVIDENCE;
const TOOL_MARKER = process.env.SLATE_REMINDER_TOOL_MARKER;
const SCENARIO = process.env.SLATE_REMINDER_SCENARIO;
const TOOL_NAME = "writing_reminder_canary";
const CUSTOM_TYPE = "slate-writing-reminder";
const HEADER = "[slate] Reminder:";
const FINDINGS_HEADING = "Recent writing findings:";
const REQUIREMENTS_HEADING = "Writing and conversation requirements:";
const DESIGN_HEADING = "Design requirements:";
const REQUIREMENT_FRAGMENTS = [
	"Use short, active language. Keep exact technical terms. Do not use semicolons or contractions.",
	"Write for a reader whose first language is not English.",
	"Use plain words that appear in standard libraries and textbooks. Treat any other term as new. A multi-word noun phrase, an abbreviation and a CamelCase name are terms.",
	"Avoid idioms.",
	"Replace bare-reference openers with the subject they reference.",
	"Explain each term, including project-specific, at first use.",
	"Define each abbreviation at first use.",
	"Express one idea in each sentence.",
	"Use one term for each concept.",
	"Do not explain an idea with a metaphor.",
	"Do not invent a term when the project already has one.",
	"Keep a design statement only if a different reasonable implementation keeps it true.",
	"Present to the user any item the approved goals do not list.",
	"Never add or remove an approved goal yourself.",
	"Propose a repeated regression as a non-goal candidate.",
	"Present what changed when you update a design.",
	"Assume the user knows software but not this project.",
	"Exclude research logs, worker task text, and the project's own agent instruction file.",
];
const SUCCESS = "SLATE_REMINDER_REACHED_NEXT_MODEL_CALL_7f31c2";
const FINDING_TEXT = `${"界".repeat(42)}; ${"界".repeat(42)}. One. Two. Three. Four. Five. Six. Seven.\n\nThe report was accepted.`;

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

function toolCalls(model, call) {
	return message(model, [
		{ type: "toolCall", id: `writing-reminder-${call}-1`, name: TOOL_NAME, arguments: {} },
		{ type: "toolCall", id: `writing-reminder-${call}-2`, name: TOOL_NAME, arguments: {} },
	], "toolUse", { input: call === 5 ? 60_000 : 25_000 + call, output: 1 });
}

function reminderInputs(context) {
	return context.messages.filter((item) => item?.role === "user" && textOf(item.content).startsWith(`${HEADER}\n\n`));
}

function completeRequirementStructure(text) {
	const writing = text.indexOf(REQUIREMENTS_HEADING);
	const design = text.indexOf(DESIGN_HEADING);
	return writing >= 0 && design > writing && REQUIREMENT_FRAGMENTS.every((fragment) => text.split(fragment).length === 2);
}

export default function reminderCanary(pi) {
	let calls = 0;
	let sessionMeta = {};
	const customMessages = [];

	pi.on("session_start", (_event, ctx) => {
		sessionMeta = { trusted: ctx.isProjectTrusted(), cwd: ctx.cwd };
	});
	pi.on("message_start", (event) => {
		const item = event.message;
		if (item?.role === "custom" && item.customType === CUSTOM_TYPE) {
			customMessages.push({ content: textOf(item.content), deliveryId: item.details?.deliveryId });
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
			if (calls === 1) return completedStream(message(model, [{ type: "text", text: FINDING_TEXT }], "stop", { input: 25_000, output: 1 }));
			if (calls === 2) return completedStream(toolCalls(model, calls));

			const inputs = reminderInputs(context);
			const newest = inputs.at(-1);
			const detailsAbsent = inputs.every((item) => !Object.prototype.hasOwnProperty.call(item, "details"));
			if (SCENARIO === "off" || calls === 6) {
				const observed = {
					...sessionMeta,
					scenario: SCENARIO,
					calls,
					findingText: FINDING_TEXT,
					providerReminderContents: inputs.map((item) => textOf(item.content)),
					providerNewestReminder: textOf(newest?.content),
					providerRequirementStructures: inputs.map((item) => completeRequirementStructure(textOf(item.content))),
					providerReminderDetailsAbsent: detailsAbsent,
					customMessages,
				};
				writeFileSync(EVIDENCE, JSON.stringify(observed, null, 2));
				const expectedCount = SCENARIO === "off" ? 1 : 2;
				const valid = inputs.length === expectedCount && customMessages.length === expectedCount && detailsAbsent;
				return completedStream(message(model, [{ type: "text", text: valid ? SUCCESS : "SLATE_REMINDER_MISSING_FROM_NEXT_MODEL_CALL" }], "stop", { input: 25_100 + calls, output: 1 }));
			}

			if (calls === 3) return completedStream(message(model, [{ type: "text", text: SUCCESS }], "stop", { input: 25_100, output: 1 }));
			if (calls === 4) return completedStream(message(model, [{ type: "text", text: "The report is ready." }], "stop", { input: 25_200, output: 1 }));
			if (calls === 5) return completedStream(toolCalls(model, calls));
			return completedStream(message(model, [{ type: "text", text: "UNEXPECTED_PROVIDER_CALL" }], "stop", { input: 25_300, output: 1 }));
		},
	});
}
