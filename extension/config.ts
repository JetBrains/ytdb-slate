import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SlateConfig } from "./state.ts";

// Only loader-produced home-only views can cross an untrusted-project boundary.
// JSON fields, prototypes, and copies cannot manufacture this permission.
const homeOnlyConfigs = new WeakSet<object>();

export function permitsSlateConfig(config: SlateConfig | undefined, projectTrusted: boolean): boolean {
	return projectTrusted || (config !== undefined && homeOnlyConfigs.has(config));
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Merge JSON objects without inherited keys, prototype setters, or input mutation. */
export function mergeConfig(home: unknown, project: unknown): unknown {
	if (Array.isArray(project)) return project.map((value) => mergeConfig(undefined, value));
	if (!object(project)) return project;
	const merged: Record<string, unknown> = {};
	const set = (key: string, value: unknown) => Object.defineProperty(merged, key, {
		value, enumerable: true, configurable: true, writable: true,
	});
	if (object(home)) {
		for (const key of Object.keys(home)) set(key, mergeConfig(undefined, home[key]));
	}
	for (const key of Object.keys(project)) {
		set(key, mergeConfig(Object.hasOwn(merged, key) ? merged[key] : undefined, project[key]));
	}
	return merged;
}

function readSource(file: string, root: string, warn: (message: string) => void): {
	config: Record<string, unknown>; present: boolean; invalid: boolean;
} {
	const empty = { config: {} as Record<string, unknown>, present: false, invalid: false };
	try {
		lstatSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
		warn(`slate: ${file} could not be read. Logical model policy is blocked.`);
		return { ...empty, present: true, invalid: true };
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!object(parsed)) {
			warn(`slate: ${file} must contain one JSON object. Logical model policy is blocked.`);
			return { ...empty, present: true, invalid: true };
		}
		const config = mergeConfig(undefined, parsed) as Record<string, unknown>;
		// Resolve before merging so replacement never loses its source directory.
		for (const key of ["orchestratorPromptDocs", "workerPromptDocs"]) {
			if (Array.isArray(config[key])) config[key] = config[key].map((path: unknown) =>
				typeof path === "string" ? resolve(root, path) : path);
		}
		for (const key of ["doctrineExtraPath", "reviewPerspectivesPath"]) {
			if (typeof config[key] === "string" && config[key]) config[key] = resolve(root, config[key]);
		}
		return { config, present: true, invalid: false };
	} catch {
		warn(`slate: ${file} could not be parsed or read. Logical model policy is blocked.`);
		return { ...empty, present: true, invalid: true };
	}
}

/** Read once per parent session. Pi project trust remains a separate decision. */
export function loadConfig(cwd: string, projectTrusted: boolean, warn: (message: string) => void): SlateConfig {
	const agentDir = getAgentDir();
	const home = readSource(join(agentDir, "slate.json"), agentDir, warn);
	// Do not even inspect the untrusted project file.
	const project = projectTrusted ? readSource(join(cwd, CONFIG_DIR_NAME, "slate.json"), cwd, warn) : undefined;
	const config = mergeConfig(home.config, project?.config ?? {}) as SlateConfig;
	// A valid override cannot erase another permitted source's failure.
	if (home.invalid || project?.invalid) config.router = null;
	if (!projectTrusted && home.present) homeOnlyConfigs.add(config);
	return config;
}
