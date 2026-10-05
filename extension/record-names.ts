/** Shared track identifiers, report names, and read-only source references. */
import { isChangeFolder } from "./artifact-names.ts";

export const TRACK_IDENTIFIER_MAX = 128;
const TRACK_COMPONENT_MAX = String(Number.MAX_SAFE_INTEGER);
export const TRACK_IDENTIFIER_PATTERN = "^[1-9][0-9]*(?:\\.[1-9][0-9]*)*$";
const identifierPattern = new RegExp(TRACK_IDENTIFIER_PATTERN);

function isTrackIdentifier(value: string): boolean {
	return value.length <= TRACK_IDENTIFIER_MAX && identifierPattern.exec(value)?.[0] === value &&
		value.split(".").every((part) => part.length < TRACK_COMPONENT_MAX.length ||
			(part.length === TRACK_COMPONENT_MAX.length && part <= TRACK_COMPONENT_MAX));
}

/** Check original dispatch values without conversion and preserve accepted spelling. */
export function trackIdentifier(value: unknown): string {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	if (typeof value === "string" && isTrackIdentifier(value)) return value;
	throw new Error("trackNumber must be a positive safe integer or a canonical dotted identifier of at most 128 ASCII characters. Each component must be 1 through 9007199254740991, with no leading zero.");
}

export function implementerReportName(value: unknown): string {
	return `track-${trackIdentifier(value)}-implementer-report.md`;
}

export const READ_ONLY_EARLIER_LOG_PREFIX = "Read-only earlier log: ";
/** The argument is one validated change-folder name, not a path. */
export function readOnlyEarlierLogLine(change: string): string {
	if (!isChangeFolder(change)) throw new Error("The read-only source needs a valid change folder.");
	return `${READ_ONLY_EARLIER_LOG_PREFIX}slate-changes/${change}/research-log.md`;
}
