/** One writing or design requirement rendered in prompt guidance. */
export interface WritingRequirement {
	text: string;
}

/** The ordered source of truth for writing doctrine and reminders. */
export const WRITING_REQUIREMENTS: readonly WritingRequirement[] = Object.freeze([
	Object.freeze({ text: "Avoid idioms." }),
	Object.freeze({ text: "Replace bare-reference openers with the subject they reference." }),
	Object.freeze({ text: "Explain each project-specific term at first use." }),
	Object.freeze({ text: "Define each abbreviation at first use." }),
	Object.freeze({ text: "Express one idea in each sentence." }),
	Object.freeze({ text: "Use one term for each concept." }),
	Object.freeze({ text: "Do not explain an idea with a metaphor." }),
	Object.freeze({ text: "Do not invent a term when the project already has one." }),
	Object.freeze({ text: "Use plain words that appear in standard libraries and textbooks." }),
]);

/** The ordered source of truth for design reminders. */
export const DESIGN_REQUIREMENTS: readonly WritingRequirement[] = Object.freeze([
	Object.freeze({ text: "Keep a design statement only if a different reasonable implementation keeps it true." }),
	Object.freeze({ text: "Present to the user any item the approved goals do not list." }),
	Object.freeze({ text: "Never add or remove an approved goal yourself." }),
	Object.freeze({ text: "Propose a repeated regression as a non-goal candidate." }),
	Object.freeze({ text: "Present what changed when you update a design." }),
	Object.freeze({ text: "Assume the user knows software but not this project." }),
]);

/** The shared exclusion guard for doctrine and hidden reminders. */
export const WRITING_SCOPE_EXCLUSION =
	"Exclude research logs, worker task text, and the project's own agent instruction file.";

export const WRITING_REMINDER_CUSTOM_TYPE = "slate-writing-reminder";

export interface WritingReminderDeliveryDetails {
	deliveryId: number;
}

export interface PendingWritingReminder {
	deliveryId: number;
	nextMarkTokens: number;
	consumeForce: boolean;
	expectedContent: string;
}

export interface WritingReminderRuntime {
	markTokens: number;
	sentThisRound: boolean;
	forceNext: boolean;
	deliverySequence: number;
	adoptedThisSessionStart: boolean;
	pending?: PendingWritingReminder;
}

export interface WritingReminderGate {
	orchestratorMode: boolean;
	trusted: boolean;
	paused: boolean;
}

export interface WritingReminderDecision {
	send: boolean;
	nextMarkTokens: number;
}

export function createWritingReminderRuntime(): WritingReminderRuntime {
	return {
		markTokens: 0,
		sentThisRound: false,
		forceNext: false,
		deliverySequence: 0,
		adoptedThisSessionStart: false,
	};
}

/** Convert a configured percentage of the effective budget to a token cadence. */
export function writingReminderInterval(effectiveBudgetTokens: number, remindPercent: number): number {
	return Math.max(8_192, Math.floor((effectiveBudgetTokens * remindPercent) / 100));
}

/** Decide whether policy gates permit a reminder before checking its cadence. */
export function writingReminderGateOpen(gate: WritingReminderGate, sentThisRound: boolean): boolean {
	return gate.orchestratorMode && gate.trusted && !gate.paused && !sentThisRound;
}

/**
 * Decide one cadence step. A smaller trustworthy usage lowers the mark.
 * Force sends without usage and leaves the mark unchanged.
 */
export function decideWritingReminder(
	markTokens: number,
	usageTokens: number | null | undefined,
	intervalTokens: number | undefined,
	forceNext: boolean,
): WritingReminderDecision {
	const trustworthyUsage =
		typeof usageTokens === "number" && Number.isFinite(usageTokens) && usageTokens >= 0 ? usageTokens : undefined;
	const loweredMark = trustworthyUsage === undefined ? markTokens : Math.min(markTokens, trustworthyUsage);
	if (forceNext) return { send: true, nextMarkTokens: trustworthyUsage ?? loweredMark };
	if (trustworthyUsage === undefined || intervalTokens === undefined) {
		return { send: false, nextMarkTokens: loweredMark };
	}
	const send = trustworthyUsage >= loweredMark + intervalTokens;
	return { send, nextMarkTokens: send ? trustworthyUsage : loweredMark };
}

/** Claim a round before queueing. Cadence and force remain uncommitted. */
export function claimWritingReminder(
	runtime: WritingReminderRuntime,
	decision: WritingReminderDecision,
	expectedContent: string,
): WritingReminderRuntime {
	if (!decision.send) return { ...runtime, markTokens: decision.nextMarkTokens };
	const deliveryId = runtime.deliverySequence + 1;
	return {
		...runtime,
		sentThisRound: true,
		deliverySequence: deliveryId,
		pending: { deliveryId, nextMarkTokens: decision.nextMarkTokens, consumeForce: runtime.forceNext, expectedContent },
	};
}

export function writingReminderDeliveryDetails(deliveryId: number): WritingReminderDeliveryDetails {
	return { deliveryId };
}

/** Match pi's hidden details and exact content to the current queue claim. */
export function writingReminderDeliveryMatches(
	runtime: WritingReminderRuntime,
	details: unknown,
	content: unknown,
): boolean {
	if (!runtime.pending || typeof details !== "object" || details === null) return false;
	try {
		return (
			(details as { deliveryId?: unknown }).deliveryId === runtime.pending.deliveryId &&
			content === runtime.pending.expectedContent
		);
	} catch {
		return false;
	}
}

/** Commit cadence and force when pi starts the matching custom message. */
export function commitWritingReminder(
	runtime: WritingReminderRuntime,
	details: unknown,
	content: unknown,
): WritingReminderRuntime {
	if (!writingReminderDeliveryMatches(runtime, details, content)) return runtime;
	return {
		...runtime,
		markTokens: runtime.pending?.nextMarkTokens ?? runtime.markTokens,
		forceNext: runtime.pending?.consumeForce ? false : runtime.forceNext,
		pending: undefined,
	};
}

/** Open the next round and discard any queue claim that never started delivery. */
export function rearmWritingReminder(runtime: WritingReminderRuntime): WritingReminderRuntime {
	return { ...runtime, sentThisRound: false, pending: undefined };
}

/** Reset session cadence and preserve force only for this cycle's adoption. */
export function resetWritingReminderSession(runtime: WritingReminderRuntime): WritingReminderRuntime {
	return {
		markTokens: 0,
		sentThisRound: false,
		forceNext: runtime.adoptedThisSessionStart && runtime.forceNext,
		deliverySequence: runtime.deliverySequence,
		adoptedThisSessionStart: false,
		pending: undefined,
	};
}

export function renderWritingDoctrineRequirements(indent = ""): string {
	return WRITING_REQUIREMENTS.map((requirement) => `${indent}- ${requirement.text}`).join("\n");
}

export function renderWritingScopeExclusion(indent = ""): string {
	return `${indent}${WRITING_SCOPE_EXCLUSION}`;
}

const WRITING_REMINDER_HEADER = "[slate] Reminder:";

const WRITING_REMINDER_MESSAGE = [
	WRITING_REMINDER_HEADER,
	"",
	"Writing requirements:",
	...WRITING_REQUIREMENTS.map((requirement) => `- ${requirement.text}`),
	"",
	"Design requirements:",
	...DESIGN_REQUIREMENTS.map((requirement) => `- ${requirement.text}`),
	"",
	WRITING_SCOPE_EXCLUSION,
].join("\n");

export function renderWritingReminder(): string {
	return WRITING_REMINDER_MESSAGE.slice(`${WRITING_REMINDER_HEADER}\n\n`.length);
}

/** The complete hidden custom-message content. */
export function renderWritingReminderMessage(): string {
	return WRITING_REMINDER_MESSAGE;
}
