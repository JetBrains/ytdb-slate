/**
 * Shared writer and rollback helper for Slate episode and observation Markdown
 * artifacts. Other Slate state files have separate persistence paths.
 *
 * Node has no portable directory-descriptor-relative open. The descriptor and
 * path identity checks before and after writing prevent Slate from accepting
 * content when the current path no longer names the opened file. They cannot
 * make every concurrent same-user directory change atomic.
 */

import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	isSlateArtifactId,
	isSlateArtifactReference,
	slateArtifactReference,
	type SlateArtifactKind,
} from "./artifact-names.ts";
export {
	isSafeThreadId,
	isSlateArtifactId,
	isSlateArtifactReference,
	nextSlateEpisodeId,
	slateArtifactReference,
	SLATE_ARTIFACT_REFERENCE_MAX_BYTES,
	type SlateArtifactKind,
} from "./artifact-names.ts";

/** Identity of the file created by one successful write attempt. */
export interface SlateArtifactIdentity {
	readonly dev: number;
	readonly ino: number;
}

export interface SlateArtifactLocation {
	/** Absolute path for runtime file access. */
	absolutePath: string;
	/** Stable project-relative reference for persisted metadata and prose. */
	reference: string;
	/** Transient identity used to limit rollback to this write attempt. */
	identity: SlateArtifactIdentity;
}

const ARTIFACT_FILE_MODE = 0o666;
// Bound retries under hostile same-name replacement. Sixteen permits ordinary
// writer races while guaranteeing a deterministic refusal instead of a spin.
const WRITE_ATTEMPTS = 16;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const OPEN_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
/** A deterministic refusal by slate's rules rather than an unclassified platform error. */
export class SlateWriteRefused extends Error {}

/** Lexical directory helper retained for callers and tests. */
export function slateArtifactDir(cwd: string, kind: SlateArtifactKind): string {
	return join(cwd, CONFIG_DIR_NAME, "slate", kind);
}

function refuse(message: string): never {
	throw new SlateWriteRefused(message);
}

/** Verify one component, optionally creating it for a write. */
function ensureRealDirectory(path: string, create: boolean): void {
	let entry = lstatSync(path, { throwIfNoEntry: false });
	if (entry === undefined && create) {
		try {
			mkdirSync(path);
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
		}
		entry = lstatSync(path, { throwIfNoEntry: false });
	}
	if (entry?.isSymbolicLink()) refuse(`slate refused an artifact directory because that path is a symbolic link`);
	if (!entry?.isDirectory()) refuse(`slate refused an artifact directory because that path is not a directory`);
}

/** Resolve and verify every artifact parent component. */
function verifiedArtifactDirectory(cwd: string, kind: SlateArtifactKind, create: boolean): string {
	const root = realpathSync(cwd);
	let dir = root;
	for (const component of [CONFIG_DIR_NAME, "slate", kind]) {
		dir = join(dir, component);
		ensureRealDirectory(dir, create);
	}
	if (realpathSync(dir) !== dir) refuse(`slate refused an artifact directory because its path changed`);
	return dir;
}

function sameFile(a: ReturnType<typeof fstatSync>, b: NonNullable<ReturnType<typeof lstatSync>>): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

/** Remove the current name only when it still identifies the held descriptor. */
function removeIfSame(file: string, held: ReturnType<typeof fstatSync>): void {
	try {
		const current = lstatSync(file, { throwIfNoEntry: false });
		if (current?.isFile() && sameFile(held, current)) unlinkSync(file);
	} catch {
		/* cleanup is best effort and must not obscure the refusal */
	}
}

/**
 * Exclusive creation protects the final component. Rewriting an existing
 * regular file intentionally replaces its inode. Its old mode is not preserved,
 * and existing hard links continue to name the old inode. This differs from an
 * in-place truncation, but avoids following links and retains last-writer-wins.
 */
function writeFreshFile(dir: string, file: string, content: Buffer): SlateArtifactIdentity {
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		let fd: number;
		try {
			fd = openSync(file, OPEN_FLAGS, ARTIFACT_FILE_MODE);
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
			const existing = lstatSync(file, { throwIfNoEntry: false });
			if (existing === undefined) continue;
			if (existing.isSymbolicLink()) refuse(`slate refused an artifact file because that path is a symbolic link`);
			if (!existing.isFile()) refuse(`slate refused an artifact file because that path is not a regular file`);
			try {
				unlinkSync(file);
			} catch (unlinkError) {
				if ((unlinkError as { code?: string }).code === "ENOENT") continue;
				throw unlinkError;
			}
			continue;
		}

		let held: ReturnType<typeof fstatSync> | undefined;
		try {
			held = fstatSync(fd);
			const current = lstatSync(file, { throwIfNoEntry: false });
			const parentMatches = realpathSync(dir) === dir;
			if (!held.isFile() || !current?.isFile() || !sameFile(held, current) || !parentMatches) {
				removeIfSame(file, held);
				continue;
			}
			let offset = 0;
			while (offset < content.byteLength) {
				const written = writeSync(fd, content, offset, content.byteLength - offset);
				if (written <= 0) throw new Error("slate artifact write made no progress");
				offset += written;
			}
			// A competing same-id writer may replace the name while this descriptor is
			// being written. Return only when the canonical name still identifies it.
			const after = lstatSync(file, { throwIfNoEntry: false });
			if (!after?.isFile() || !sameFile(held, after) || realpathSync(dir) !== dir) {
				removeIfSame(file, held);
				continue;
			}
			return { dev: held.dev, ino: held.ino };
		} catch (error) {
			// A failed write must never leave readable worker output that the durable
			// record says was not stored. Do not unlink a competing replacement.
			if (held) removeIfSame(file, held);
			throw error;
		} finally {
			closeSync(fd);
		}
	}
	refuse(`slate refused an artifact because its path kept changing before the write`);
}

export function writeSlateArtifact(opts: {
	cwd: string;
	kind: SlateArtifactKind;
	id: string;
	content: string | Buffer;
}): SlateArtifactLocation {
	if (!isSlateArtifactId(opts.id)) refuse(`slate refused an invalid artifact id`);
	const reference = slateArtifactReference(opts.kind, opts.id);
	const dir = verifiedArtifactDirectory(opts.cwd, opts.kind, true);
	const absolutePath = join(dir, `${opts.id}.md`);
	const identity = writeFreshFile(dir, absolutePath, typeof opts.content === "string" ? Buffer.from(opts.content, "utf8") : opts.content);
	return { absolutePath, reference, identity };
}

/** Best-effort removal for rollback. Invalid ids or references are refused. */
export function removeSlateArtifact(opts: {
	cwd: string;
	kind: SlateArtifactKind;
	id: string;
	reference: string;
	identity: SlateArtifactIdentity;
}): boolean {
	if (!isSlateArtifactReference(opts.reference, opts.kind, opts.id)) refuse(`slate refused an invalid artifact reference`);
	const dir = verifiedArtifactDirectory(opts.cwd, opts.kind, false);
	const absolutePath = join(dir, `${opts.id}.md`);
	const entry = lstatSync(absolutePath, { throwIfNoEntry: false });
	if (entry === undefined) return false;
	if (entry.isSymbolicLink() || !entry.isFile()) refuse(`slate refused to remove a non-regular artifact`);
	if (entry.dev !== opts.identity.dev || entry.ino !== opts.identity.ino) return false;
	unlinkSync(absolutePath);
	return true;
}
