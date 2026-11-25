import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, statSync, type PathLike } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

const POINTER_LIMIT = 1_048_576;
const HEAD_LIMIT = 255;

export function realTextPath(path: PathLike): string {
	const bytes = realpathSync.native(path, { encoding: "buffer" });
	const text = bytes.toString("utf8");
	if (!Buffer.from(text).equals(bytes)) throw new Error(String(path) + ": real path is not valid text.");
	return text;
}

function directoryPath(path: PathLike): string {
	const resolved = realTextPath(path);
	if (!statSync(resolved).isDirectory()) throw new Error(resolved + " is not a directory.");
	return resolved;
}

function entryAt(path: string) {
	try { return lstatSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

function readPrefix(path: string, limit: number, rejectLarger: boolean): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) throw new Error(path + " is not a regular file.");
		if (rejectLarger && info.size > limit) throw new Error(path + " exceeds " + limit + " bytes.");
		const buffer = Buffer.alloc(Math.min(info.size, limit));
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, null);
			if (count === 0) break;
			length += count;
		}
		return buffer.subarray(0, length);
	} finally { closeSync(fd); }
}

function pointer(path: string, base: string, prefix = ""): string {
	try {
		if (!statSync(path).isFile()) throw new Error("The pointer is not a regular file.");
		const content = readPrefix(path, POINTER_LIMIT, true);
		let end = content.length;
		while (content[end - 1] === 13 || content[end - 1] === 10) end--;
		const bytes = content.subarray(prefix.length, end);
		if (content.toString("latin1", 0, prefix.length) !== prefix || !bytes.length || bytes.includes(0)) {
			throw new Error("Invalid pointer.");
		}
		const text = bytes.toString("utf8");
		// Let the file system follow links before it resolves parent segments.
		const parent = isAbsolute(text) ? "" : base + sep;
		if (Buffer.from(text).equals(bytes)) return directoryPath(parent + text);
		// Keep the original path bytes on systems that accept them.
		if (process.platform === "win32") throw new Error("The pointer path is not valid text.");
		return directoryPath(Buffer.concat([Buffer.from(parent), bytes]));
	} catch (error) {
		throw new Error(path + ": " + String(error), { cause: error });
	}
}

function validHead(path: string): boolean {
	const head = entryAt(path);
	if (head?.isSymbolicLink()) return readlinkSync(path).startsWith("refs/");
	if (!head?.isFile()) return false;
	const content = readPrefix(path, HEAD_LIMIT, false).toString("latin1");
	// Both detached hash formats have at least 40 hexadecimal digits.
	return /^ref:[ \t\r\n\v\f]*refs\//.test(content) || /^[0-9a-fA-F]{40}/.test(content);
}

function gitDirectoryKey(dir: string): string {
	const head = join(dir, "HEAD");
	if (!validHead(head)) throw new Error(head + " is not a valid Git HEAD.");
	const common = join(dir, "commondir");
	const key = entryAt(common) ? pointer(common, dir) : dir;
	accessSync(join(key, "objects"), constants.X_OK);
	accessSync(join(key, "refs"), constants.X_OK);
	return key;
}

export function resolveProjectKey(cwd: string): string {
	// The native path of `.` keeps bytes that process.cwd() can lose.
	const working = directoryPath(cwd === process.cwd() ? "." : cwd);
	for (let dir = working; ; dir = dirname(dir)) {
		const git = join(dir, ".git");
		if (entryAt(git)) {
			const entry = statSync(git);
			if (entry.isFile()) return gitDirectoryKey(pointer(git, dir, "gitdir: "));
			if (entry.isDirectory()) return gitDirectoryKey(directoryPath(git));
			throw new Error(git + " is neither a regular file nor a directory.");
		}
		if (entryAt(join(dir, "HEAD")) &&
			(entryAt(join(dir, "commondir")) || (entryAt(join(dir, "objects")) && entryAt(join(dir, "refs"))))) {
			return gitDirectoryKey(dir);
		}
		if (dirname(dir) === dir) return working;
	}
}
