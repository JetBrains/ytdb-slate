import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { realTextPath, resolveProjectKey } from "./project-key.ts";
import { isModelSpec, isThinkingLevel, type ThinkingLevel } from "./state.ts";

export const SUMMARY_WIDGET_KEY = "slate-startup-summary";
export function preferencePath(agentDir = getAgentDir()): string {
	return join(agentDir, "slate-preferences.json");
}

function jsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPreferences(path: string): { target: string; mode?: number; data: Record<string, unknown> } {
	let target: string;
	let mode: number;
	let parsed: unknown;
	try {
		try { lstatSync(path); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return { target: path, data: {} };
		}
		target = realTextPath(path);
		mode = statSync(target).mode & 0o7777;
		parsed = JSON.parse(readFileSync(target, "utf8"));
	} catch (error) {
		throw new Error(`Cannot read or parse ${path}: ${String(error)}`);
	}
	if (!jsonObject(parsed)) throw new Error(`${path} must contain a JSON object.`);
	return { target, mode, data: parsed };
}

export function readStartupSummary(path = preferencePath()): { enabled: boolean; warning?: string } {
	try {
		const value = readPreferences(path).data.startupSummary;
		if (value === undefined) return { enabled: false };
		if (typeof value === "boolean") return { enabled: value };
		return { enabled: true, warning: `slate: ${path} needs a boolean startupSummary value. The summary is on.` };
	} catch (error) {
		return { enabled: true, warning: `slate: ${error instanceof Error ? error.message : String(error)} The summary is on.` };
	}
}

export type SaveResult = { path: string; durabilityWarning?: string };

type WriteHooks = { beforeReplace?: () => void; syncFolder?: (folder: string) => void };

export function saveStartupSummary(enabled: boolean, path = preferencePath(), hooks: WriteHooks = {}): SaveResult {
	return updatePreferences(path, "Startup summary", (data) => {
		data.startupSummary = enabled;
		return true;
	}, hooks)!;
}

function checkStoreParent(folder: string): void {
	for (;;) {
		try {
			realTextPath(folder);
			return;
		} catch (error) {
			const parent = dirname(folder);
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === folder) throw error;
			folder = parent;
		}
	}
}

function updatePreferences(path: string, label: string, update: (data: Record<string, unknown>) => boolean, hooks: WriteHooks): SaveResult | undefined {
	const { target, mode, data } = readPreferences(path);
	if (!update(data)) return undefined;
	if (mode === undefined) checkStoreParent(dirname(target));
	mkdirSync(dirname(target), { recursive: true });
	const temp = join(dirname(target), `.slate-preferences-${randomUUID()}.tmp`);
	// The temporary file must not expose store content to more readers than the target.
	const fd = openSync(temp, "wx", mode ?? 0o666);
	try {
		try {
			writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
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
			durabilityWarning: `${label} is saved in ${path}, but the folder could not be flushed. The change may not survive a crash: ${String(error)}`,
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

type ProjectModel = { model: string; thinkingLevel: ThinkingLevel };
type ProjectModelRead =
	| { kind: "entry"; key: string; entry: ProjectModel }
	| { kind: "none"; key: string }
	| { kind: "invalid-entry"; key: string }
	| { kind: "store-unreadable"; key: string; reason: string }
	| { kind: "key-unavailable"; reason: string };

function projectModels(data: Record<string, unknown>): Record<string, unknown> {
	if (data.projectModels === undefined) return {};
	if (!jsonObject(data.projectModels)) throw new Error("projectModels must be a JSON object.");
	return data.projectModels;
}

function validProjectModel(value: unknown): value is ProjectModel {
	return jsonObject(value) && isModelSpec(value.model) && isThinkingLevel(value.thinkingLevel);
}

export function readProjectModel(cwd: string, path = preferencePath()): ProjectModelRead {
	let key;
	try { key = resolveProjectKey(cwd); }
	catch (error) { return { kind: "key-unavailable", reason: String(error) }; }
	try {
		const entries = projectModels(readPreferences(path).data);
		if (!Object.hasOwn(entries, key)) return { kind: "none", key };
		const entry = entries[key];
		return validProjectModel(entry) ? { kind: "entry", key, entry } : { kind: "invalid-entry", key };
	} catch (error) {
		return { kind: "store-unreadable", key, reason: String(error) };
	}
}

export function writeProjectModel(cwd: string, entry: ProjectModel | undefined, path = preferencePath(), hooks: WriteHooks = {}) {
	let key;
	try { key = resolveProjectKey(cwd); }
	catch (error) { throw new Error(`Cannot determine the project key: ${String(error)}`); }
	const saved = updatePreferences(path, "Project model change", (data) => {
		const entries = projectModels(data);
		if (entry !== undefined) {
			if (!validProjectModel(entry)) throw new Error("A provider/id model and a valid thinking level are required.");
			data.projectModels = { ...entries, [key]: entry };
		} else {
			if (!Object.hasOwn(entries, key)) return false;
			delete entries[key];
		}
		return true;
	}, hooks);
	return { key, saved };
}

type SummaryStyleKind = "heading" | "action" | "command" | "dim";
type SummaryStyle = (kind: SummaryStyleKind, text: string) => string;
type SummaryPart = [text: string, kind?: SummaryStyleKind];

export function renderStartupSummary(style?: SummaryStyle): string[] {
	const lines: SummaryPart[][] = [
		[["What Slate does, step by step:", "heading"]],
		[["1. Research:", "heading"], [" Slate studies your request and the code through worker threads."]],
		[["2. Risks:", "heading"], [" Slate judges risks and required reviews internally."]],
		[["3. Solution:", "heading"], [" Slate presents a short plan or a required design. "], ["You approve the short plan or validate the design. If adversarial design review is required, you give final design approval after it. Otherwise, design validation includes final approval", "action"], ["."]],
		[["4. Tracks:", "heading"], [" a code track implements one bounded part of approved work. Required reviewers check it. A design track plans a larger part of the work and owns child tracks. "], ["You accept each code track in a multi-track change and each design track with all its child tracks", "action"], [". At required boundaries, run "], ["/slate handoff --track-boundary", "command"], [" to continue in a new main session."]],
		[["5. Final acceptance:", "heading"], [" you review the whole change and "], ["accept it", "action"], ["."]],
		[["6. Delivery:", "heading"], [" Without draft publishing, accepted branch history is the delivery. With it, Slate prepares one pull request for the whole change on one branch. "], ["Only you merge", "action"], [" after final acceptance. A merge is not final acceptance."]],
		[["Run ", "dim"], ["/slate summary off", "command"], [" or ", "dim"], ["/slate summary on", "command"], [" to disable or enable automatic display. On applies at the next automatic opportunity. Off also hides the panel now.", "dim"]],
	];
	return lines.map((parts) => parts.map(([text, kind]) => kind && style ? style(kind, text) : text).join(""));
}
