/** Pure names and references for Slate episode and observation artifacts. */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { isSlateSessionName } from "./session-names.ts";

/** Project-local artifact directories under <config dir>/slate/. */
export type SlateArtifactKind = "episodes" | "observations";

/** UTF-8 uses at least one byte per character, so 240 bytes always fit the header's 240-character field cap. */
export const SLATE_ARTIFACT_REFERENCE_MAX_BYTES = 240;
const CONTROL_OR_PORTABLE_SEPARATOR = /[\u0000-\u001f\u007f-\u009f/\\<>:"|?*]/u;
const EPISODE_SUFFIX = /\.e(0|[1-9]\d*)$/u;

function utf8Length(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function slateArtifactReference(kind: SlateArtifactKind, id: string): string;
export function slateArtifactReference(sessionName: string, kind: SlateArtifactKind, id: string): string;
export function slateArtifactReference(first: string, second: string, third?: string): string {
	return third === undefined
		? `${CONFIG_DIR_NAME}/slate/${first}/${second}.md`
		: `${CONFIG_DIR_NAME}/slate/sessions/${first}/${second}/${third}.md`;
}

function legacySlateArtifactReference(kind: SlateArtifactKind, id: string): string {
	return slateArtifactReference(kind, id);
}

/**
 * Accept generated ids and safe restored names without rewriting them. The id
 * must be one portable filename component with a non-negative safe-integer
 * episode suffix. The byte bound keeps either canonical reference untruncated.
 */
export function isSlateArtifactId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value === "." || value === "..") return false;
	if (CONTROL_OR_PORTABLE_SEPARATOR.test(value) || value.endsWith(".") || value.endsWith(" ")) return false;
	const suffix = EPISODE_SUFFIX.exec(value);
	if (!suffix || suffix.index === 0) return false;
	const episode = Number(suffix[1]);
	if (!Number.isSafeInteger(episode) || episode < 0) return false;
	return utf8Length(slateArtifactReference("observations", value)) <= SLATE_ARTIFACT_REFERENCE_MAX_BYTES;
}

/** A thread id that can safely prefix every canonical episode artifact id. */
export function isSafeThreadId(value: unknown): value is string {
	return typeof value === "string" && isSlateArtifactId(`${value}.e0`);
}

/** Return the single canonical episode id for one thread. */
export function slateEpisodeId(threadId: unknown): string | undefined {
	if (!isSafeThreadId(threadId)) return undefined;
	const id = `${threadId}.e1`;
	return isSlateArtifactId(id) ? id : undefined;
}

/** Validate the exact canonical spelling, optionally for one kind and id. */
export function isSlateArtifactReference(
	value: unknown,
	kind?: SlateArtifactKind,
	id?: string,
): value is string {
	if (typeof value !== "string" || utf8Length(value) > SLATE_ARTIFACT_REFERENCE_MAX_BYTES) return false;
	const kinds: readonly SlateArtifactKind[] = kind ? [kind] : ["episodes", "observations"];
	return kinds.some((candidate) => {
		const legacyPrefix = `${CONFIG_DIR_NAME}/slate/${candidate}/`;
		if (value.startsWith(legacyPrefix) && value.endsWith(".md")) {
			const foundId = value.slice(legacyPrefix.length, -3);
			return isSlateArtifactId(foundId) && (id === undefined || foundId === id) && value === legacySlateArtifactReference(candidate, foundId);
		}
		const sessionPrefix = `${CONFIG_DIR_NAME}/slate/sessions/`;
		if (!value.startsWith(sessionPrefix) || !value.endsWith(".md")) return false;
		const rest = value.slice(sessionPrefix.length);
		const slash = rest.indexOf("/");
		if (slash < 0) return false;
		const sessionName = rest.slice(0, slash);
		const artifactPrefix = `${candidate}/`;
		const tail = rest.slice(slash + 1);
		if (!isSlateSessionName(sessionName) || !tail.startsWith(artifactPrefix)) return false;
		const foundId = tail.slice(artifactPrefix.length, -3);
		return isSlateArtifactId(foundId) && (id === undefined || foundId === id) && value === slateArtifactReference(sessionName, candidate, foundId);
	});
}
