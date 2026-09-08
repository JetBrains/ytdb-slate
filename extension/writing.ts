import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { sanitizeForNotify } from "./notify.ts";
import { WRITING_CHECKER_URL } from "./paths.ts";
import type { WritingConfig } from "./state.ts";

export const DEFAULT_SENTENCE_WORD_LIMIT = 25;
export const MIN_SENTENCE_WORD_LIMIT = 10;
export const MAX_SENTENCE_WORD_LIMIT = 200;

export type SentenceWordLimit = number | false;

export interface WritingChecker {
	checkText(text: string, options?: { sentenceWordLimit?: SentenceWordLimit }): { findings: readonly { class: string }[] };
}

export interface WritingCheckerModule extends WritingChecker {
	readonly DEFAULT_SENTENCE_WORD_LIMIT: number;
	readonly MIN_SENTENCE_WORD_LIMIT: number;
	readonly MAX_SENTENCE_WORD_LIMIT: number;
}

export interface WritingCounters {
	measuredTurns: number;
	findingTurns: number;
}

/** Load the dependency-free checker used by the turn hook. */
export async function loadWritingChecker(): Promise<WritingCheckerModule> {
	return import(WRITING_CHECKER_URL);
}

/**
 * FX2. Three outcomes, because two of them used to be one.
 *
 * - `measured`: the checker read prose and the counters moved.
 * - `no-text`: the turn carried no prose to measure. A tool-call-only turn, a
 *   thinking-plus-tool-call turn, and an aborted or failed turn all land here,
 *   and they are the MAJORITY of turns in an orchestrator session. Nothing is
 *   wrong, so the caller must leave the counters and the status alone.
 * - `failed`: the checker was asked and did not answer.
 *
 * The caller cannot recover this from the counters: `no-text` and `failed` both
 * leave them unchanged, and reading that as a failure replaced a healthy
 * `writing 3/3` with `writing unavailable` on the next tool call.
 */
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

/**
 * Human-only turn telemetry. It never returns a hook result and always fails
 * open; the returned outcome is the caller's only report of what happened.
 */
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
		// An unreadable message is not a checker failure either.
		return "no-text";
	}
	if (text === undefined) return "no-text";
	try {
		const result = checker.checkText(text, { sentenceWordLimit });
		const hasFailFinding = result.findings.some((finding) => finding.class === "fail");
		counters.measuredTurns += 1;
		if (hasFailFinding) counters.findingTurns += 1;
		return "measured";
	} catch {
		// A checker cap or implementation error must never fail a turn.
		return "failed";
	}
}

/** The known `writing` keys. Report anything else as a likely typo. */
const WRITING_KEYS = ["check", "remind", "remindPercent", "sentenceWordLimit"];

/** Validate the raw `writing` config and retain its configurable limits. */
export function sanitizeWritingConfig(
	raw: unknown,
	warn: (msg: string) => void,
): Pick<Required<WritingConfig>, "remindPercent" | "sentenceWordLimit"> {
	const defaults = { remindPercent: 5, sentenceWordLimit: DEFAULT_SENTENCE_WORD_LIMIT as SentenceWordLimit };
	if (raw === undefined) return defaults;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warn('slate: ignoring writing — expected an object like { "remindPercent": 5, "sentenceWordLimit": 25 }');
		return defaults;
	}
	const value = raw as { check?: unknown; remind?: unknown; remindPercent?: unknown; sentenceWordLimit?: unknown };

	const unknownKeys = Object.keys(value).filter((key) => !WRITING_KEYS.includes(key));
	if (unknownKeys.length > 0) {
		warn(
			`slate: ignoring unknown writing key(s): ${sanitizeForNotify(unknownKeys.join(", "))} (known: ${WRITING_KEYS.map(
				(key) => `"${key}"`,
			).join(", ")})`,
		);
	}

	if (
		Object.prototype.hasOwnProperty.call(value, "check") ||
		Object.prototype.hasOwnProperty.call(value, "remind")
	) {
		warn(
			"slate: writing.check and writing.remind are ignored writing keys. Remove them from slate.json. Slate controls writing checks and reminders automatically for trusted projects in orchestrator mode.",
		);
	}

	let rawPercent: unknown;
	if (Object.prototype.hasOwnProperty.call(value, "remindPercent")) {
		try {
			rawPercent = value.remindPercent;
		} catch {
			warn("slate: ignoring writing.remindPercent — could not read the value (defaulting to 5)");
		}
	}
	let remindPercent = defaults.remindPercent;
	if (rawPercent !== undefined) {
		if (typeof rawPercent === "number" && Number.isFinite(rawPercent) && rawPercent > 0 && rawPercent <= 100) {
			remindPercent = rawPercent;
		} else {
			warn("slate: ignoring writing.remindPercent — expected a finite number in (0, 100] (defaulting to 5)");
		}
	}

	let rawSentenceWordLimit: unknown;
	if (Object.prototype.hasOwnProperty.call(value, "sentenceWordLimit")) {
		try {
			rawSentenceWordLimit = value.sentenceWordLimit;
		} catch {
			warn("slate: ignoring writing.sentenceWordLimit — could not read the value (defaulting to 25)");
		}
	}
	let sentenceWordLimit = defaults.sentenceWordLimit;
	if (rawSentenceWordLimit !== undefined) {
		if (rawSentenceWordLimit === false) {
			sentenceWordLimit = false;
		} else if (
			Number.isSafeInteger(rawSentenceWordLimit) &&
			(rawSentenceWordLimit as number) >= MIN_SENTENCE_WORD_LIMIT &&
			(rawSentenceWordLimit as number) <= MAX_SENTENCE_WORD_LIMIT
		) {
			sentenceWordLimit = rawSentenceWordLimit as number;
		} else {
			warn("slate: ignoring writing.sentenceWordLimit — expected a whole number from 10 to 200, or false (defaulting to 25)");
		}
	}

	return { remindPercent, sentenceWordLimit };
}
