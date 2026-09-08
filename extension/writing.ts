import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { sanitizeForNotify } from "./notify.ts";
import { WRITING_CHECKER_URL } from "./paths.ts";
import type { WritingConfig } from "./state.ts";

export const DEFAULT_SENTENCE_WORD_LIMIT = 25;
export const MIN_SENTENCE_WORD_LIMIT = 10;
export const MAX_SENTENCE_WORD_LIMIT = 200;
export const DEFAULT_STATUS_WINDOW_TURNS = 10;
export const MIN_STATUS_WINDOW_TURNS = 3;
export const MAX_STATUS_WINDOW_TURNS = 100;
export const WRITING_QUOTATION_MAX_BYTES = 120;
export const MODEL_VISIBLE_WRITING_RULES = Object.freeze([
	"SEMICOLON",
	"CONTRACTION",
	"PARA6",
	"SENTENCE_LENGTH",
] as const);

export type SentenceWordLimit = number | false;
export type ModelVisibleWritingClass = "fail" | "house-style";

export interface WritingFinding {
	id: string;
	class: string;
	excerpt: string;
}

export interface WritingChecker {
	checkText(text: string, options?: { sentenceWordLimit?: SentenceWordLimit }): { findings: readonly WritingFinding[] };
}

export interface WritingCheckerModule extends WritingChecker {
	readonly DEFAULT_SENTENCE_WORD_LIMIT: number;
	readonly MIN_SENTENCE_WORD_LIMIT: number;
	readonly MAX_SENTENCE_WORD_LIMIT: number;
}

export interface WritingFindingSummary {
	failCount: number;
	styleCount: number;
	failQuotation?: string;
	styleQuotation?: string;
}

interface WritingWindowEntry {
	failCount: number;
	styleCount: number;
}

export interface WritingCounters {
	measuredTurns: number;
	failCount: number;
	styleCount: number;
	windowTurns: number;
	entries: WritingWindowEntry[];
	latest?: WritingFindingSummary;
}

export function createWritingCounters(windowTurns = DEFAULT_STATUS_WINDOW_TURNS): WritingCounters {
	return { measuredTurns: 0, failCount: 0, styleCount: 0, windowTurns, entries: [] };
}

export function resetWritingCounters(counters: WritingCounters, windowTurns = counters.windowTurns): void {
	counters.measuredTurns = 0;
	counters.failCount = 0;
	counters.styleCount = 0;
	counters.windowTurns = windowTurns;
	counters.entries.length = 0;
	counters.latest = undefined;
}

export function resizeWritingWindow(counters: WritingCounters, windowTurns: number): void {
	counters.windowTurns = windowTurns;
	while (counters.entries.length > windowTurns) {
		const removed = counters.entries.shift();
		if (removed) {
			counters.failCount -= removed.failCount;
			counters.styleCount -= removed.styleCount;
		}
	}
	counters.measuredTurns = counters.entries.length;
}

/** Load the dependency-free checker used by the turn hook. */
export async function loadWritingChecker(): Promise<WritingCheckerModule> {
	return import(WRITING_CHECKER_URL);
}

export type WritingTurnOutcome = "measured" | "no-text" | "failed";

function assistantText(message: TurnEndEvent["message"]): string | undefined {
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return undefined;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
	return text || undefined;
}

/** Cap checker-produced excerpt text by UTF-8 bytes without splitting a character. */
export function capWritingQuotation(excerpt: string, maxBytes = WRITING_QUOTATION_MAX_BYTES): string {
	const cap = Math.max(0, Math.floor(maxBytes));
	if (Buffer.byteLength(excerpt, "utf8") <= cap) return excerpt;
	const marker = "…";
	const open = "⟦";
	const close = "⟧";
	const framed = excerpt.startsWith(open) && excerpt.endsWith(close);
	const suffix = framed ? marker + close : marker;
	const prefix = framed ? open : "";
	const fixedBytes = Buffer.byteLength(prefix + suffix, "utf8");
	if (cap < fixedBytes) {
		let fallback = "";
		for (const character of excerpt) {
			if (Buffer.byteLength(fallback + character, "utf8") > cap) break;
			fallback += character;
		}
		return fallback;
	}
	const source = framed ? excerpt.slice(open.length, -close.length) : excerpt;
	const budget = cap - fixedBytes;
	let bytes = 0;
	let kept = "";
	for (const character of source) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > budget) break;
		kept += character;
		bytes += size;
	}
	return prefix + kept + suffix;
}

export function summarizeWritingFindings(findings: readonly WritingFinding[]): WritingFindingSummary {
	const visible = findings.filter((finding) => MODEL_VISIBLE_WRITING_RULES.includes(finding.id as (typeof MODEL_VISIBLE_WRITING_RULES)[number]));
	const fail = visible.filter((finding) => finding.class === "fail");
	const style = visible.filter((finding) => finding.class === "house-style");
	return {
		failCount: fail.length,
		styleCount: style.length,
		...(fail[0] ? { failQuotation: capWritingQuotation(fail[0].excerpt) } : {}),
		...(style[0] ? { styleQuotation: capWritingQuotation(style[0].excerpt) } : {}),
	};
}

function recordSummary(counters: WritingCounters, summary: WritingFindingSummary): void {
	resizeWritingWindow(counters, counters.windowTurns);
	counters.entries.push({ failCount: summary.failCount, styleCount: summary.styleCount });
	counters.failCount += summary.failCount;
	counters.styleCount += summary.styleCount;
	if (counters.entries.length > counters.windowTurns) {
		const removed = counters.entries.shift();
		if (removed) {
			counters.failCount -= removed.failCount;
			counters.styleCount -= removed.styleCount;
		}
	}
	counters.measuredTurns = counters.entries.length;
	counters.latest = summary;
}

/** Measure one assistant turn. All state stays in the session-local counters object. */
export function measureWritingTurn(
	message: TurnEndEvent["message"],
	checker: WritingChecker,
	counters: WritingCounters,
	sentenceWordLimit: SentenceWordLimit = DEFAULT_SENTENCE_WORD_LIMIT,
): WritingTurnOutcome {
	let text: string | undefined;
	try {
		text = assistantText(message);
	} catch {
		return "no-text";
	}
	if (text === undefined) return "no-text";
	try {
		const result = checker.checkText(text, { sentenceWordLimit });
		recordSummary(counters, summarizeWritingFindings(result.findings));
		return "measured";
	} catch {
		counters.latest = undefined;
		return "failed";
	}
}

/** The known `writing` keys. Report anything else as a likely typo. */
const WRITING_KEYS = ["check", "remind", "remindPercent", "sentenceWordLimit", "statusWindowTurns", "findings"];

/** Validate the raw `writing` config and retain its configurable limits. */
export function sanitizeWritingConfig(
	raw: unknown,
	warn: (msg: string) => void,
): Pick<Required<WritingConfig>, "remindPercent" | "sentenceWordLimit" | "statusWindowTurns" | "findings"> {
	const defaults = {
		remindPercent: 5,
		sentenceWordLimit: DEFAULT_SENTENCE_WORD_LIMIT as SentenceWordLimit,
		statusWindowTurns: DEFAULT_STATUS_WINDOW_TURNS,
		findings: true,
	};
	if (raw === undefined) return defaults;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warn('slate: ignoring writing — expected an object like { "sentenceWordLimit": 25, "statusWindowTurns": 10, "findings": true }');
		return defaults;
	}
	const value = raw as Record<string, unknown>;
	const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(value, key);

	const unknownKeys = Object.keys(value).filter((key) => !WRITING_KEYS.includes(key));
	if (unknownKeys.length > 0) {
		warn(`slate: ignoring unknown writing key(s): ${sanitizeForNotify(unknownKeys.join(", "))} (known: ${WRITING_KEYS.map((key) => `"${key}"`).join(", ")})`);
	}
	if (hasOwn("check") || hasOwn("remind")) {
		warn("slate: writing.check and writing.remind are ignored writing keys. Remove them from slate.json. Slate controls writing checks and reminders automatically for trusted projects in orchestrator mode.");
	}

	const read = (key: string, fallback: unknown): unknown => {
		if (!hasOwn(key)) return undefined;
		try {
			return value[key];
		} catch {
			warn(`slate: ignoring writing.${key} — could not read the value (defaulting to ${String(fallback)})`);
			return undefined;
		}
	};

	let remindPercent = defaults.remindPercent;
	const rawPercent = read("remindPercent", 5);
	if (rawPercent !== undefined) {
		if (typeof rawPercent === "number" && Number.isFinite(rawPercent) && rawPercent > 0 && rawPercent <= 100) remindPercent = rawPercent;
		else warn("slate: ignoring writing.remindPercent — expected a finite number in (0, 100] (defaulting to 5)");
	}

	let sentenceWordLimit = defaults.sentenceWordLimit;
	const rawSentenceWordLimit = read("sentenceWordLimit", 25);
	if (rawSentenceWordLimit !== undefined) {
		if (rawSentenceWordLimit === false) sentenceWordLimit = false;
		else if (Number.isSafeInteger(rawSentenceWordLimit) && (rawSentenceWordLimit as number) >= MIN_SENTENCE_WORD_LIMIT && (rawSentenceWordLimit as number) <= MAX_SENTENCE_WORD_LIMIT) sentenceWordLimit = rawSentenceWordLimit as number;
		else warn("slate: ignoring writing.sentenceWordLimit — expected a whole number from 10 to 200, or false (defaulting to 25)");
	}

	let statusWindowTurns = defaults.statusWindowTurns;
	const rawStatusWindowTurns = read("statusWindowTurns", 10);
	if (rawStatusWindowTurns !== undefined) {
		if (Number.isSafeInteger(rawStatusWindowTurns) && (rawStatusWindowTurns as number) >= MIN_STATUS_WINDOW_TURNS && (rawStatusWindowTurns as number) <= MAX_STATUS_WINDOW_TURNS) statusWindowTurns = rawStatusWindowTurns as number;
		else warn("slate: ignoring writing.statusWindowTurns — expected a whole number from 3 to 100 (defaulting to 10)");
	}

	let findings = defaults.findings;
	const rawFindings = read("findings", true);
	if (rawFindings !== undefined) {
		if (typeof rawFindings === "boolean") findings = rawFindings;
		else warn("slate: ignoring writing.findings — expected true or false (defaulting to true)");
	}

	return { remindPercent, sentenceWordLimit, statusWindowTurns, findings };
}
