import { sanitizeForNotify } from "./notify.ts";
import type { WritingConfig } from "./state.ts";

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
