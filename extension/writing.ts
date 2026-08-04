import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { sanitizeForNotify } from "./notify.ts";
import type { WritingConfig } from "./state.ts";

export interface WritingChecker {
	checkText(text: string): { findings: readonly { class: string }[] };
}

export interface WritingCounters {
	measuredTurns: number;
	findingTurns: number;
}

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

/** Human-only turn telemetry. It never returns a hook result and always fails open. */
export function measureWritingTurn(message: TurnEndEvent["message"], checker: WritingChecker, counters: WritingCounters): void {
	try {
		const text = assistantText(message);
		if (text === undefined) return;
		const result = checker.checkText(text);
		counters.measuredTurns += 1;
		if (result.findings.some((finding) => finding.class === "fail")) counters.findingTurns += 1;
	} catch {
		// A checker cap or implementation error must never fail a turn.
	}
}

/** The known `writing` keys. Report anything else as a likely typo. */
const WRITING_KEYS = ["check"];

/**
 * Validate the raw `writing` config value. An absent value silently returns the
 * default. A wrong shape warns once and returns the default. Unknown keys and a
 * wrong-typed `check` value warn, while valid input is copied into a new object.
 */
export function sanitizeWritingConfig(raw: unknown, warn: (msg: string) => void): Required<WritingConfig> {
	const defaults: Required<WritingConfig> = { check: false };
	if (raw === undefined) return defaults;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warn('slate: ignoring writing — expected an object like { "check": true }');
		return defaults;
	}
	const value = raw as { check?: unknown };

	const unknownKeys = Object.keys(value).filter((key) => !WRITING_KEYS.includes(key));
	if (unknownKeys.length > 0) {
		warn(
			`slate: ignoring unknown writing key(s): ${sanitizeForNotify(unknownKeys.join(", "))} (known: ${WRITING_KEYS.map(
				(key) => `"${key}"`,
			).join(", ")})`,
		);
	}

	let rawCheck: unknown;
	if (Object.prototype.hasOwnProperty.call(value, "check")) {
		try {
			rawCheck = value.check;
		} catch {
			warn("slate: ignoring writing.check — could not read the value (defaulting to false)");
		}
	}
	let check = false;
	if (rawCheck !== undefined) {
		if (typeof rawCheck !== "boolean") {
			warn("slate: ignoring writing.check — expected true or false (defaulting to false)");
		} else {
			check = rawCheck;
		}
	}

	return { check };
}
