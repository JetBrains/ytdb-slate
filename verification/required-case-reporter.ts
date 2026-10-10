import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectRequiredFiles } from "./required-case-roster.ts";

export type ResultEvent = { type: string; data: {
	file?: string; name?: string; skip?: unknown; todo?: unknown; expectFailure?: unknown;
	details?: { type?: string }; success?: boolean;
	counts?: { tests: number; passed: number; failed: number; cancelled: number; skipped: number; todo: number };
} };

/** Check structured Node results against the independent delivery roster. */
export async function inspectRequiredResults(
	events: AsyncIterable<ResultEvent> | Iterable<ResultEvent>, requiredFiles: Map<string, string[]>,
) {
	const seen = new Map<string | undefined, number>(), summaries = new Set<string>(), errors: string[] = [];
	const expectedNames = new Set([...requiredFiles.values()].flat());
	const helperFile = fileURLToPath(new URL("../test/required-case.ts", import.meta.url));
	for await (const { type, data } of events) {
		const file = typeof data.file === "string" ? resolve(data.file) : undefined;
		const names = file === undefined ? undefined : requiredFiles.get(file);
		if (!names && !expectedNames.has(data.name ?? "") && file !== helperFile) continue;
		if (type === "test:pass" || type === "test:fail") {
			if (type !== "test:pass" || "skip" in data || "todo" in data || "expectFailure" in data)
				errors.push(`${data.name}: ${type}, skip, todo or expected failure`);
			if (data.details?.type === "suite") continue;
			seen.set(data.name, (seen.get(data.name) ?? 0) + 1);
			if (!expectedNames.has(data.name ?? "")) errors.push(`unexpected required-file case: ${data.name}`);
		}
		if (type === "test:summary" && names && file !== undefined) {
			if (summaries.has(file)) errors.push(`duplicate summary: ${file}`);
			summaries.add(file);
			const c = data.counts;
			if (!data.success || !c || c.tests !== names.length || c.passed !== names.length ||
				c.failed !== 0 || c.cancelled !== 0 || c.skipped !== 0 || c.todo !== 0)
				errors.push(`required-file counts do not match: ${file} ${JSON.stringify(c)}`);
		}
	}
	for (const [file, names] of requiredFiles) {
		if (!summaries.has(file)) errors.push(`missing required-file summary: ${file}`);
		for (const name of names)
			if (seen.get(name) !== 1) errors.push(`required case must report exactly once: ${name}`);
	}
	return errors;
}

export default async function* requiredResults(events: AsyncIterable<ResultEvent>) {
	const errors = await inspectRequiredResults(events, selectRequiredFiles());
	if (errors.length) {
		process.exitCode = 1;
		yield `REQUIRED CASE VERDICT: FAIL\n${errors.join("\n")}\n`;
	} else yield "REQUIRED CASE VERDICT: PASS\n";
}
