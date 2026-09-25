import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SUMMARY_WIDGET_KEY = "slate-startup-summary";
export function preferencePath(agentDir = getAgentDir()): string {
	return join(agentDir, "slate-preferences.json");
}

function jsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPreferences(path: string): Record<string, unknown> {
	try {
		lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot read ${path}: ${String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read or parse ${path}: ${String(error)}`);
	}
	if (!jsonObject(parsed)) throw new Error(`${path} must contain a JSON object.`);
	return parsed;
}

export function readStartupSummary(path = preferencePath()): { enabled: boolean; warning?: string } {
	try {
		const value = readPreferences(path).startupSummary;
		if (value === undefined) return { enabled: true };
		if (typeof value === "boolean") return { enabled: value };
		return { enabled: true, warning: `slate: ${path} needs a boolean startupSummary value. The summary is on.` };
	} catch (error) {
		return { enabled: true, warning: `slate: ${error instanceof Error ? error.message : String(error)} The summary is on.` };
	}
}

export type SaveResult = { path: string; durabilityWarning?: string };

/** The optional hook only injects a failure at a test boundary before replacement. */
export function saveStartupSummary(enabled: boolean, path = preferencePath(), hooks: { beforeReplace?: () => void; syncFolder?: (folder: string) => void } = {}): SaveResult {
	// Read before any mutation. A malformed or unreadable old file must not be replaced.
	const previous = readPreferences(path);
	mkdirSync(dirname(path), { recursive: true });
	// Write through a link rather than replacing the link itself.
	let entry: ReturnType<typeof lstatSync> | undefined;
	try { entry = lstatSync(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const target = entry?.isSymbolicLink() ? realpathSync(path) : path;
	let mode: number | undefined;
	try { mode = statSync(target).mode & 0o7777; }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const temp = join(dirname(target), `.slate-preferences-${randomUUID()}.tmp`);
	try {
		const fd = openSync(temp, "wx", 0o666);
		try {
			writeFileSync(fd, `${JSON.stringify({ ...previous, startupSummary: enabled }, null, 2)}\n`);
			if (mode !== undefined) fchmodSync(fd, mode);
			fsyncSync(fd);
		} finally { closeSync(fd); }
		hooks.beforeReplace?.();
		renameSync(temp, target);
	} catch (error) {
		try { unlinkSync(temp); } catch (cleanupError) {
			if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`${error instanceof Error ? error.message : String(error)}. The temporary file ${temp} could not be removed: ${String(cleanupError)}`, { cause: error });
			}
		}
		throw error;
	}
	// Windows does not offer a portable directory flush. The replacement is complete.
	if (process.platform === "win32") return { path };
	try { (hooks.syncFolder ?? syncFolder)(dirname(target)); }
	catch (error) {
		if (!unsupportedFolderFlush(error)) return {
			path,
			durabilityWarning: `Startup summary is saved in ${path}, but the folder could not be flushed. The choice may not survive a crash: ${String(error)}`,
		};
	}
	return { path };
}

function syncFolder(folder: string): void {
	const fd = openSync(folder, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

function unsupportedFolderFlush(error: unknown): boolean {
	return ["ENOTSUP", "EOPNOTSUPP", "EINVAL", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

type SummaryStyleKind = "heading" | "action" | "command" | "dim";
type SummaryStyle = (kind: SummaryStyleKind, text: string) => string;
type SummaryPart = [text: string, kind?: SummaryStyleKind];

export function renderStartupSummary(style?: SummaryStyle): string[] {
	const lines: SummaryPart[][] = [
		[["What Slate does, step by step:", "heading"]],
		[["1. Research:", "heading"], [" Slate studies your request and the code through worker threads."]],
		[["2. Risk approval:", "heading"], [" Slate lists the risks of the change, and "], ["you approve or reject", "action"], [" each one."]],
		[["3. Design:", "heading"], [" when a risk needs it, Slate writes a design, "], ["you check it", "action"], [", reviewers test it, and "], ["you approve it", "action"], ["."]],
		[["4. Tracks:", "heading"], [" Slate splits the work into tracks, workers implement and check each track, and reviewers review it when a risk needs it."]],
		[["5. Final acceptance:", "heading"], [" you review the whole change and "], ["accept it", "action"], ["."]],
		[["6. Delivery:", "heading"], [" Slate prepares the final commit, or a pull request that "], ["only you merge", "action"], ["."]],
		[["Run ", "dim"], ["/slate summary off", "command"], [" or ", "dim"], ["/slate summary on", "command"], [" to hide or show this summary when orchestrator mode starts.", "dim"]],
	];
	return lines.map((parts) => parts.map(([text, kind]) => kind && style ? style(kind, text) : text).join(""));
}
