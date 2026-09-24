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
const STORAGE_FOLDER = /^(?:runtime|change)-\d{8}T\d{6}Z-[0-9a-f]{32}$/u;

function isStorageFolder(value: unknown, prefix: "runtime" | "change"): value is string {
	if (typeof value !== "string" || !STORAGE_FOLDER.test(value) || !value.startsWith(`${prefix}-`)) return false;
	const stamp = `${value.slice(prefix.length + 1, prefix.length + 5)}-${value.slice(prefix.length + 5, prefix.length + 7)}-${value.slice(prefix.length + 7, prefix.length + 9)}T${value.slice(prefix.length + 10, prefix.length + 12)}:${value.slice(prefix.length + 12, prefix.length + 14)}:${value.slice(prefix.length + 14, prefix.length + 16)}.000Z`;
	const parsed = new Date(stamp);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === stamp;
}

export function isRuntimeStorageFolder(value: unknown): value is string { return isStorageFolder(value, "runtime"); }
export function isChangeFolder(value: unknown): value is string { return isStorageFolder(value, "change"); }

function createStorageFolder(prefix: "runtime" | "change"): string {
	return `${prefix}-${new Date().toISOString().replace(/[-:]/gu, "").slice(0, 15)}Z-${randomBytes(16).toString("hex")}`;
}
export function createRuntimeStorageFolder(): string { return createStorageFolder("runtime"); }
export function createChangeFolder(): string { return createStorageFolder("change"); }

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
