/**
 * Durable final worker output for one episode-producing dispatch.
 *
 * Observations are separate from compressed episodes so later orchestration can
 * recover exact finding prose. This module owns the bounded, guarded write and
 * returns every fact that the episode metadata will need. It never returns a
 * path unless the file exists.
 */

import { sanitizeForNotify } from "./notify.ts";
import { writeSlateArtifact } from "./slate-files.ts";

// Worker responses are normally much smaller. This ceiling limits accidental
// or hostile output while retaining enough exact prose for review findings.
export const OBSERVATIONS_MAX_BYTES = 64 * 1024;

// This duplicates model-default.ts's marker instead of importing that module.
// model-default.ts loads global settings machinery, while this module stays a
// small file-format helper that can be tested without that unrelated runtime.
const OBSERVATIONS_TRUNCATION_MARK = " […truncated]";

export type FindingsGrammarResult = "present" | "absent" | "malformed";

export type ObservationRecord =
	| {
		stored: true;
		path: string;
		/** UTF-8 bytes stored on disk, including the marker when truncated. */
		bytes: number;
		truncated: boolean;
		grammar: FindingsGrammarResult;
	}
	| {
		stored: false;
		reason: "no-final-message" | "no-final-text";
		grammar: "absent";
	}
	| {
		stored: false;
		reason: "write-failed";
		grammar: FindingsGrammarResult;
	};

/** Capture adds transient zero-findings and warning facts. */
export type ObservationCapture =
	| (Extract<ObservationRecord, { stored: true }> & { zeroFindings: boolean })
	| Extract<ObservationRecord, { reason: "no-final-message" | "no-final-text" }>
	| (Extract<ObservationRecord, { reason: "write-failed" }> & { zeroFindings: boolean; warning: string });

/** Remove transient zero-findings and warnings without changing durable facts. */
export function durableObservation(capture: ObservationCapture | ObservationRecord): ObservationRecord {
	if (capture.stored) {
		return {
			stored: true,
			path: capture.path,
			bytes: capture.bytes,
			truncated: capture.truncated,
			grammar: capture.grammar,
		};
	}
	if (capture.reason === "no-final-message" || capture.reason === "no-final-text") return capture;
	return { stored: false, reason: "write-failed", grammar: capture.grammar };
}

/** Detect whether any line has exactly five pipe-separated fields. */
export function findingsGrammar(text: string): FindingsGrammarResult {
	const candidates = text.split(/\r?\n/).filter((line) => line.includes("|"));
	if (candidates.length === 0) return "absent";
	return candidates.some((line) => line.split("|").length === 5) ? "present" : "malformed";
}

/** Pure policy gate. The caller derives `judgementType` from the charter set. */
export function shouldWarnFindingsGrammar(
	status: "ok" | "failed",
	judgementType: boolean,
	grammar: FindingsGrammarResult,
	zeroFindings = false,
): boolean {
	const acceptedZeroFindings = zeroFindings && grammar === "absent";
	return status === "ok" && judgementType && grammar !== "present" && !acceptedZeroFindings;
}

/** The bounded response ends with Slate's exact zero-findings line. */
export function hasZeroFindings(text: string): boolean {
	const lines = text.split(/\r?\n/);
	while (lines.at(-1) === "") lines.pop();
	return lines.at(-1) === "No findings.";
}

function boundedObservation(text: string): { content: Buffer; truncated: boolean } {
	const source = Buffer.from(text, "utf8");
	if (source.byteLength <= OBSERVATIONS_MAX_BYTES) return { content: source, truncated: false };

	let end = OBSERVATIONS_MAX_BYTES;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let prefix = "";
	while (end > 0) {
		try {
			prefix = decoder.decode(source.subarray(0, end));
			break;
		} catch {
			end--;
		}
	}
	// The marker is outside the safety ceiling by design. It can put the stored
	// file slightly over the cap so truncated output is never mistaken for whole.
	return { content: Buffer.from(`${prefix}${OBSERVATIONS_TRUNCATION_MARK}`, "utf8"), truncated: true };
}

/**
 * Store a final assistant message. Undefined means no final message existed.
 * Empty text means that the final message had no text blocks. Neither writes a
 * file. Whitespace-only text remains content.
 * The write itself belongs to the shared safe writer in
 * slate-files.ts, which validates the episode id and refuses to follow a
 * symbolic link at any component of the path.
 *
 * A REFUSED id and a FAILED write are deliberately one outcome. Both mean "there
 * is no file to point at", the durable record already distinguishes stored from
 * not stored, and a second not-stored reason would have to be understood by the
 * sanitizer, the episode header and the reader rule to say nothing an operator
 * can act on differently.
 */
export function captureObservation(cwd: string, episodeId: string, text: string | undefined): ObservationCapture;
export function captureObservation(cwd: string, sessionName: string, episodeId: string, text: string | undefined, corpusName?: unknown): ObservationCapture;
export function captureObservation(cwd: string, first: string, second: string | undefined, third?: string, corpusName?: unknown): ObservationCapture {
	const legacy = arguments.length === 3;
	const sessionName = legacy ? undefined : first;
	const episodeId = legacy ? first : (second as string);
	const text = legacy ? second : third;
	if (text === undefined) return { stored: false, reason: "no-final-message", grammar: "absent" };
	if (text.length === 0) return { stored: false, reason: "no-final-text", grammar: "absent" };

	const bounded = boundedObservation(text);
	// Grammar describes the exact bounded text written below. Decoding is safe
	// because boundedObservation preserves UTF-8 boundaries and adds a UTF-8 marker.
	const boundedText = bounded.content.toString("utf8");
	const grammar = findingsGrammar(boundedText);
	const zeroFindings = hasZeroFindings(boundedText);
	try {
		const written = writeSlateArtifact({ cwd, sessionName, corpusName, kind: "observations", id: episodeId, content: bounded.content });
		return {
			stored: true,
			path: written.reference,
			bytes: bounded.content.byteLength,
			truncated: bounded.truncated,
			grammar,
			zeroFindings,
		};
	} catch {
		return {
			stored: false,
			reason: "write-failed",
			grammar,
			zeroFindings,
			// SE1: the id reaches a user-visible warning, so it goes through the same
			// notification sanitizer every other display string in this repo uses.
			warning: `slate: could not store observations for episode ${sanitizeForNotify(episodeId, 80)}. The episode will continue without them.`,
		};
	}
}
