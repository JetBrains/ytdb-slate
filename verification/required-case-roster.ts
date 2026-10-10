import { fileURLToPath } from "node:url";

export type RequiredFile = { file: string; names: string[]; platforms?: string[] };

export const requiredRoster: RequiredFile[] = [{
	file: fileURLToPath(new URL("../test/notification-push-portable.test.ts", import.meta.url)),
	names: [
		"portable push sends exactly one ntfy request through the real localhost lookup child",
		"lookup child self-deadline closes a stalled lookup and leaves no process",
	],
}];

/** Validate the whole roster before platform selection. Names are globally unique. */
export function selectRequiredFiles(roster = requiredRoster, platform: string = process.platform) {
	const files = new Set<string>(), names = new Set<string>();
	for (const entry of roster) {
		if (!entry.file || files.has(entry.file) || entry.names.length === 0)
			throw new Error("required roster needs unique files and nonempty case lists");
		files.add(entry.file);
		for (const name of entry.names) {
			if (!name || names.has(name)) throw new Error("required roster needs globally unique nonempty names");
			names.add(name);
		}
		if (entry.platforms && (entry.platforms.length === 0 || new Set(entry.platforms).size !== entry.platforms.length))
			throw new Error("required roster needs a nonempty unique platform list");
	}
	const selected = new Map(roster.filter((entry) => !entry.platforms || entry.platforms.includes(platform))
		.map((entry) => [entry.file, entry.names]));
	if (selected.size === 0) throw new Error(`required roster has no cases for ${platform}`);
	return selected;
}
