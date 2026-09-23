/** Pure names and references for Slate episode and observation artifacts. */

import { randomBytes } from "node:crypto";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Project-local artifact directories under <config dir>/slate/. */
export type SlateArtifactKind = "episodes" | "observations";

/** UTF-8 uses at least one byte per character, so 240 bytes always fit the header's 240-character field cap. */
export const SLATE_ARTIFACT_REFERENCE_MAX_BYTES = 240;
const CONTROL_OR_PORTABLE_SEPARATOR = /[\u0000-\u001f\u007f-\u009f/\\<>:"|?*]/u;
const EPISODE_SUFFIX = /\.e(0|[1-9]\d*)$/u;
/** UTC creation time followed by 128 random bits. No user or Pi identifier enters a path. */
const RUNTIME_FOLDER = /^runtime-\d{8}T\d{6}Z-[0-9a-f]{32}$/u;

export function isRuntimeStorageFolder(value: unknown): value is string {
	if (typeof value !== "string" || !RUNTIME_FOLDER.test(value)) return false;
	const stamp = `${value.slice(8, 12)}-${value.slice(12, 14)}-${value.slice(14, 16)}T${value.slice(17, 19)}:${value.slice(19, 21)}:${value.slice(21, 23)}.000Z`;
	const parsed = new Date(stamp);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === stamp;
}

export function createRuntimeStorageFolder(): string {
	return `runtime-${new Date().toISOString().replace(/[-:]/gu, "").slice(0, 15)}Z-${randomBytes(16).toString("hex")}`;
}

function utf8Length(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function slateArtifactReference(kind: SlateArtifactKind, id: string, folder?: string): string {
	return `${CONFIG_DIR_NAME}/slate/${folder ? `${folder}/` : ""}${kind}/${id}.md`;
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
		const root = `${CONFIG_DIR_NAME}/slate/`;
		if (!value.startsWith(root) || !value.endsWith(".md")) return false;
		const parts = value.slice(root.length).split("/");
		const folder = parts.length === 3 && isRuntimeStorageFolder(parts[0]) ? parts[0] : undefined;
		const foundKind = folder ? parts[1] : parts.length === 2 ? parts[0] : undefined;
		const foundId = (folder ? parts[2] : parts[1])?.slice(0, -3);
		return foundKind === candidate && isSlateArtifactId(foundId) &&
			(id === undefined || foundId === id) && value === slateArtifactReference(candidate, foundId, folder);
	});
}
