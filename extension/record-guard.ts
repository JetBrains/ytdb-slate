/** Built-in write accident protection. The check does not cover later path changes. */
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RecordGuardFacts {
	platform: string;
	home: string;
	stat(file: string): Promise<Pick<Stats, "dev" | "ino" | "isDirectory">>;
	readdir(file: string): Promise<string[]>;
	realpath(file: string): Promise<string>;
}
const defaults: RecordGuardFacts = { platform: process.platform, home: homedir(), stat: fs.stat, readdir: fs.readdir, realpath: fs.realpath };

/** Matches pi 1.0.0 resolveToCwd. Injected facts exercise native Windows forms. */
export function resolveRecordGuardPath(input: string, cwd: string, facts: Pick<RecordGuardFacts, "platform" | "home"> = defaults): string {
	const api = facts.platform === "win32" ? path.win32 : path.posix;
	const normalize = (value: string, toolInput = false): string => {
		let result = toolInput ? value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ") : value;
		if (toolInput && result.startsWith("@")) result = result.slice(1);
		if (facts.platform === "win32" && result.startsWith("/") && !result.startsWith("//") && !result.includes("\\")) {
			const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(result);
			if (match) result = `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
		}
		if (result === "~") return facts.home;
		if (result.startsWith("~/") || facts.platform === "win32" && result.startsWith("~\\")) return api.join(facts.home, result.slice(2));
		if (/^file:\/\//.test(result)) return fileURLToPath(result, { windows: facts.platform === "win32" });
		return result;
	};
	const target = normalize(input, true);
	return api.isAbsolute(target) ? api.resolve(target) : api.resolve(normalize(cwd), target);
}

export const RECORD_GUARD_REASON = "Built-in write and edit cannot change Slate records. Assigned writers must use slate_record. Other workers must request a record assignment.";
/** Compare nearest ancestor, real parents and protected descendants by device and inode. */
export async function recordGuardBlocks(input: unknown, cwd: string, projectRoot: string, facts: RecordGuardFacts = defaults): Promise<boolean> {
	try {
		if (typeof input !== "string" || input.length === 0) return true;
		const api = facts.platform === "win32" ? path.win32 : path.posix;
		const protectedPath = api.join(await facts.realpath(projectRoot), "slate-changes");
		let protectedIdentity: Pick<Stats, "dev" | "ino" | "isDirectory">;
		try { protectedIdentity = await facts.stat(protectedPath); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// With no protected folder, only a proven target outside its future name is safe.
			const target = resolveRecordGuardPath(input, cwd, facts);
			const fold = (value: string) => facts.platform === "win32" || facts.platform === "darwin" ? value.toLowerCase() : value;
			const relative = api.relative(fold(protectedPath), fold(target));
			if (relative === "" || !relative.startsWith(".." + api.sep) && relative !== ".." && !api.isAbsolute(relative)) return true;
			await facts.realpath(api.dirname(target));
			return false;
		}
		let ancestor = resolveRecordGuardPath(input, cwd, facts);
		while (true) {
			try { ancestor = await facts.realpath(ancestor); break; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const parent = api.dirname(ancestor);
				if (parent === ancestor) throw error;
				ancestor = parent;
			}
		}
		const nearestIdentity = await facts.stat(ancestor);
		while (true) {
			const identity = await facts.stat(ancestor);
			if (identity.dev === protectedIdentity.dev && identity.ino === protectedIdentity.ino) return true;
			const parent = api.dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
		// A second filesystem name can expose a protected descendant without a shared path parent.
		const seen = new Set<string>();
		const containsIdentity = async (folder: string): Promise<boolean> => {
			const identity = await facts.stat(folder);
			if (identity.dev === nearestIdentity.dev && identity.ino === nearestIdentity.ino) return true;
			const key = `${identity.dev}:${identity.ino}`;
			if (!identity.isDirectory() || seen.has(key)) return false;
			seen.add(key);
			for (const name of await facts.readdir(folder)) if (await containsIdentity(api.join(folder, name))) return true;
			return false;
		};
		return await containsIdentity(protectedPath);
	} catch { return true; }
}
