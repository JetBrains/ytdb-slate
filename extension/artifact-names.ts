/** Pure names and references for Slate episode and observation artifacts. */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Project-local artifact directories under <config dir>/slate/. */
export type SlateArtifactKind = "episodes" | "observations";

/** UTF-8 uses at least one byte per character, so 240 bytes always fit the header's 240-character field cap. */
export const SLATE_ARTIFACT_REFERENCE_MAX_BYTES = 240;
const CONTROL_OR_PORTABLE_SEPARATOR = /[\u0000-\u001f\u007f-\u009f/\\<>:"|?*]/u;
const EPISODE_SUFFIX = /\.e(0|[1-9]\d*)$/u;

function utf8Length(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function slateArtifactReference(kind: SlateArtifactKind, id: string): string {
	return `${CONFIG_DIR_NAME}/slate/${kind}/${id}.md`;
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
		const prefix = `${CONFIG_DIR_NAME}/slate/${candidate}/`;
		if (!value.startsWith(prefix) || !value.endsWith(".md")) return false;
		const foundId = value.slice(prefix.length, -3);
		return isSlateArtifactId(foundId) && (id === undefined || foundId === id) && value === slateArtifactReference(candidate, foundId);
	});
}
