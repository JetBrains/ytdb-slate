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
	"Choose the simplest solution with the fewest changes that keeps every approved goal, the product and implementation quality, and every required gate.",
	"Keep a design statement only if a different reasonable implementation keeps it true.",
	"Present to the user any item the approved goals do not list.",
	"Never add or remove an approved goal yourself.",
	"Propose a repeated regression as a non-goal candidate.",
	"Present what changed when you update a design.",
	"Assume the user knows software but not this project.",
	"Exclude research logs, worker task text, and the project's own agent instruction file.",
];
const FINDING_TEXT = `${"界".repeat(42)}; ${"界".repeat(42)}. One. Two. Three. Four. Five. Six. Seven.\n\nThe report was accepted.`;
const CLEAN_TEXT = "The report is ready.";

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

function message(model, content, stopReason, call) {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 25_000 + call,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 25_001 + call,
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

function findingToolCalls(model, call) {
	return message(model, [
		{ type: "text", text: FINDING_TEXT },
		{ type: "toolCall", id: `writing-reminder-${call}-1`, name: TOOL_NAME, arguments: {} },
		{ type: "toolCall", id: `writing-reminder-${call}-2`, name: TOOL_NAME, arguments: {} },
	], "toolUse", call);
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
	const providerCalls = [];

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
			const inputs = reminderInputs(context);
			providerCalls.push({
				call: calls,
				reminderContents: inputs.map((item) => textOf(item.content)),
				reminderDetailsAbsent: inputs.every((item) => !Object.prototype.hasOwnProperty.call(item, "details")),
				requirementStructures: inputs.map((item) => completeRequirementStructure(textOf(item.content))),
			});
			writeFileSync(EVIDENCE, JSON.stringify({
				...sessionMeta,
				scenario: SCENARIO,
				calls,
				findingText: FINDING_TEXT,
				providerCalls,
				customMessages,
			}, null, 2));

			if (SCENARIO === "main" && calls === 1) return completedStream(findingToolCalls(model, calls));
			if (SCENARIO !== "main" && calls === 1) return completedStream(message(model, [{ type: "text", text: FINDING_TEXT }], "stop", calls));
			return completedStream(message(model, [{ type: "text", text: CLEAN_TEXT }], "stop", calls));
		},
	});
}
