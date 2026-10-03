/** Shared change-record names and action-local destination assignments. */
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

export type RecordWriterRole = "record-only" | "implementer";
export type RecordMode = "create" | "append" | "replace";
export interface RecordNameRule {
	readonly recordClass: "research-log" | "implementer-report" | "status" | "design";
	readonly writerRole: RecordWriterRole;
	readonly modes: readonly RecordMode[];
	readonly prefix: string;
	readonly suffix: string;
	readonly hasIdentifier: boolean;
}

function rule(recordClass: RecordNameRule["recordClass"], writerRole: RecordWriterRole,
	modes: RecordMode[], prefix: string, suffix = "", hasIdentifier = false): RecordNameRule {
	return Object.freeze({ recordClass, writerRole, modes: Object.freeze(modes), prefix, suffix, hasIdentifier });
}
const reportRule = rule("implementer-report", "implementer", ["create", "append"], "track-", "-implementer-report.md", true);
export const RECORD_NAME_RULES: readonly RecordNameRule[] = Object.freeze([
	rule("research-log", "record-only", ["append"], "research-log.md"),
	rule("research-log", "record-only", ["create", "append"], "track-", "-research-log.md", true),
	reportRule,
	rule("status", "record-only", ["create", "replace"], "status.md"),
	rule("design", "record-only", ["create", "replace"], "root-design.md"),
	rule("design", "record-only", ["create", "replace"], "track-", "-design.md", true),
]);

/** Match exact names only. Paths, alternative spellings, and normalization are not supported. */
export function recordNameRule(value: unknown): RecordNameRule | undefined {
	if (typeof value !== "string") return undefined;
	return RECORD_NAME_RULES.find((candidate) => candidate.hasIdentifier
		? value.startsWith(candidate.prefix) && value.endsWith(candidate.suffix) &&
			isTrackIdentifier(value.slice(candidate.prefix.length, -candidate.suffix.length))
		: value === candidate.prefix);
}

export function implementerReportName(value: unknown): string {
	return `${reportRule.prefix}${trackIdentifier(value)}${reportRule.suffix}`;
}

export const READ_ONLY_EARLIER_LOG_PREFIX = "Read-only earlier log: ";
/** The argument is one validated change-folder name, not a path. */
export function readOnlyEarlierLogLine(change: string): string {
	if (!isChangeFolder(change)) throw new Error("The read-only source needs a valid change folder.");
	return `${READ_ONLY_EARLIER_LOG_PREFIX}slate-changes/${change}/research-log.md`;
}

/** Compare first-line bytes exactly. Do not trim carriage returns or other bytes. */
export function matchesReadOnlyEarlierLogLine(firstLine: Uint8Array, change: string): boolean {
	return Buffer.from(firstLine).equals(Buffer.from(readOnlyEarlierLogLine(change), "ascii"));
}

export interface RecordAssignment {
	readonly currentFolder: string;
	readonly writerRole: RecordWriterRole;
	readonly names: readonly string[];
}

function currentRecordFolder(current: unknown, source: unknown): string {
	if (!isChangeFolder(current)) throw new Error("Record writing requires an open change with a valid folder.");
	if (source !== undefined && (!isChangeFolder(source) || source === current)) {
		throw new Error("The read-only source folder is invalid or matches the current folder.");
	}
	return `slate-changes/${current}`;
}

/** Used before Pi conversion and again for the value that builds the assignment. */
export function validateRecordsInput(args: Record<string, unknown>, current: unknown, source: unknown): readonly string[] | undefined {
	if (!Object.prototype.hasOwnProperty.call(args, "records")) return undefined;
	const value = args.records;
	if (!Array.isArray(value) || value.length === 0) throw new Error("records must be a nonempty list of exact record names.");
	const names: string[] = [];
	const seen = new Set<string>();
	for (const name of value) {
		if (recordNameRule(name)?.writerRole !== "record-only") {
			throw new Error("records accepts research-log.md, track-<number>-research-log.md, status.md, root-design.md, or track-<number>-design.md. Use the trackNumber rules for <number>. Names must not contain paths.");
		}
		if (seen.has(name)) throw new Error("records must not contain duplicate names.");
		seen.add(name);
		names.push(name);
	}
	if (args.type !== "general" || Object.prototype.hasOwnProperty.call(args, "trackNumber")) {
		throw new Error("records requires type general without trackNumber.");
	}
	currentRecordFolder(current, source);
	return names;
}

/** Build fresh action authority from trusted current facts. Never save this value. */
export function buildRecordAssignment(args: Record<string, unknown>, current: unknown, source: unknown): RecordAssignment | undefined {
	const names = validateRecordsInput(args, current, source);
	if (names !== undefined) {
		return Object.freeze({ currentFolder: currentRecordFolder(current, source), writerRole: "record-only", names: Object.freeze(names) });
	}
	if (args.type === "implementer" && current !== undefined) {
		return Object.freeze({ currentFolder: currentRecordFolder(current, source), writerRole: "implementer",
			names: Object.freeze([implementerReportName(args.trackNumber)]) });
	}
	return undefined;
}
