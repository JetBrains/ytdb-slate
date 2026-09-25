import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	REVIEW_COMMON_POLICY_DOC, REVIEW_IMPLEMENTATION_INPUT_DOC, WRITING_CHECKER, WRITING_GUIDANCE_DOC,
	REVIEW_RI_DOC, REVIEW_CN_DOC, REVIEW_DU_DOC, REVIEW_SE_DOC, REVIEW_PF_DOC, REVIEW_TQ_DOC,
	REVIEW_PL_DOC, REVIEW_LX_DOC, REVIEW_NL_DOC, REVIEW_CB_DOC, REVIEW_GR_DOC, REVIEW_UF_DOC,
} from "./paths.ts";

/** Names are selectors. Prefixes identify findings and never select files. */
export const REVIEW_PERSPECTIVES = [
	{ name: "Reviewer I", prefix: "RI", focusArea: null, file: REVIEW_RI_DOC },
	{ name: "Concurrency reviewer", prefix: "CN", focusArea: "concurrency defect", file: REVIEW_CN_DOC },
	{ name: "Data loss and recovery reviewer", prefix: "DU", focusArea: "data loss", file: REVIEW_DU_DOC },
	{ name: "Security reviewer", prefix: "SE", focusArea: "security weakness", file: REVIEW_SE_DOC },
	{ name: "Performance reviewer", prefix: "PF", focusArea: "performance degradation", file: REVIEW_PF_DOC },
	{ name: "Test-quality and structure reviewer", prefix: "TQ", focusArea: "test-quality defect", file: REVIEW_TQ_DOC },
	{ name: "Prose reviewer", prefix: "PL", focusArea: "unreadable user-facing prose", file: REVIEW_PL_DOC },
	{ name: "Licensing reviewer", prefix: "LX", focusArea: "licensing exposure", file: REVIEW_LX_DOC },
	{ name: "Non-local logic defect reviewer", prefix: "NL", focusArea: "non-local logic defect", file: REVIEW_NL_DOC },
	{ name: "Consumer contract break reviewer", prefix: "CB", focusArea: "consumer contract break", file: REVIEW_CB_DOC },
	{ name: "Governing-rule defect reviewer", prefix: "GR", focusArea: "governing-rule defect", file: REVIEW_GR_DOC },
	{ name: "Unreported failure reviewer", prefix: "UF", focusArea: "unreported failure", file: REVIEW_UF_DOC },
] as const;

export type ReviewPerspective = (typeof REVIEW_PERSPECTIVES)[number]["name"];

/** Undefined means the manual route. Every supplied selection is checked before thread creation. */
export function validateReviewPerspectives(value: unknown, type: unknown): ReviewPerspective[] | undefined {
	if (value === undefined) return undefined;
	if (type !== "reviewer") throw new Error("reviewPerspectives requires thread type reviewer (implementation review only).");
	if (!Array.isArray(value) || value.length === 0 || value.some((name) => typeof name !== "string")) {
		throw new Error("reviewPerspectives must be a non-empty list of built-in perspective names.");
	}
	const seen = new Set<string>();
	for (const name of value) {
		if (!REVIEW_PERSPECTIVES.some((role) => role.name === name)) {
			throw new Error(`Unknown review perspective ${JSON.stringify(name)}. Choose a built-in perspective name.`);
		}
		if (seen.has(name)) throw new Error(`Duplicate review perspective ${JSON.stringify(name)}.`);
		seen.add(name);
	}
	if (value.length > 1 && (seen.has("Reviewer I") || seen.has("Test-quality and structure reviewer"))) {
		throw new Error("Reviewer I and Test-quality and structure reviewer each require a one-item reviewPerspectives list.");
	}
	return value as ReviewPerspective[];
}

export type ReviewFileReader = (file: string) => string;

/** Load all required shipped files atomically, without treating prompt-doc skips as success. */
export function loadImplementationReviewGuidance(
	selected: readonly ReviewPerspective[],
	read: ReviewFileReader = (file) => readFileSync(file, "utf8"),
): string {
	const required = [
		{ label: "common review policy", file: REVIEW_COMMON_POLICY_DOC },
		{ label: "implementation-review inputs", file: REVIEW_IMPLEMENTATION_INPUT_DOC },
		...selected.map((name) => {
			const role = REVIEW_PERSPECTIVES.find((candidate) => candidate.name === name);
			if (!role) throw new Error(`Unknown review perspective ${JSON.stringify(name)}.`);
			return { label: `${name} charter`, file: role.file };
		}),
	];
	return required.map(({ label, file }) => {
		let content: string;
		try {
			content = read(file);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Required ${label} (${basename(file)}) is unavailable: ${reason}`);
		}
		if (typeof content !== "string" || !content.trim()) {
			throw new Error(`Required ${label} (${basename(file)}) is empty after whitespace trimming.`);
		}
		if (file === REVIEW_COMMON_POLICY_DOC) {
			content = content.replaceAll("<installed-writing-checker>", WRITING_CHECKER)
				.replaceAll("<installed-writing-guidance>", WRITING_GUIDANCE_DOC);
		}
		return content.trim();
	}).join("\n\n");
}
