import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import type { LogicalModelEffort } from "./logical-model-definitions.ts";
import {
	RecoveryOperation,
	type RecoveryCandidate,
	type RecoveryOwnership,
	type RecoveryOwnershipResult,
} from "./logical-model-recovery.ts";

export type AttemptResult<T> =
	| { kind: "success"; value: T; actualEffort: LogicalModelEffort }
	| { kind: "retry-exhausted" }
	| { kind: "cancelled" }
	| { kind: "terminal-fault"; reason: string }
	| { kind: "unknown"; reason: string };

export type SwitchValidation =
	| { ok: true }
	| { ok: false; kind: "unavailable" | "unsupported"; reason: string };

export interface CompressorRetryPolicy {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly baseDelayMs: number;
}

/** Raw Pi retry evidence for one physical compressor route. */
export class CompressorRetryEvidence {
	readonly #responses: unknown[] = [];
	readonly #scheduled: Array<{ attempt: number; maxAttempts: number }> = [];
	#started = 0;
	#finished: { success: boolean; attempt: number } | undefined;
	#malformed = false;

	response<T>(value: T): T {
		this.#responses.push(value);
		return value;
	}

	readonly callbacks = Object.freeze({
		onRetryScheduled: (attempt: number, maxAttempts: number) => {
			if (!Number.isInteger(attempt) || !Number.isInteger(maxAttempts)) this.#malformed = true;
			else this.#scheduled.push({ attempt, maxAttempts });
		},
		onRetryAttemptStart: () => { this.#started++; },
		onRetryFinished: (success: boolean, attempt: number) => {
			if (typeof success !== "boolean" || !Number.isInteger(attempt) || this.#finished !== undefined) this.#malformed = true;
			else this.#finished = { success, attempt };
		},
	});

	get responses(): readonly unknown[] { return this.#responses; }

	classify(input: {
		final: unknown;
		policy: CompressorRetryPolicy | undefined;
		actualEffort: LogicalModelEffort;
		aborted: boolean;
		threw: boolean;
		retryable: boolean;
	}): AttemptResult<string> {
		if (input.aborted || (!input.threw && (input.final as { stopReason?: unknown } | null)?.stopReason === "aborted")) return { kind: "cancelled" };
		if (input.threw) return { kind: "unknown", reason: "The compressor call threw without cancellation evidence." };
		if (typeof input.final !== "object" || input.final === null) return { kind: "unknown", reason: "The compressor returned no valid assistant message." };
		const message = input.final as { stopReason?: unknown; content?: unknown };
		if (typeof message.stopReason !== "string") return { kind: "unknown", reason: "The compressor returned no valid final stop reason." };
		if (["stop", "length", "toolUse"].includes(message.stopReason)) {
			if (!Array.isArray(message.content)) return { kind: "unknown", reason: "The compressor returned malformed content." };
			const text = message.content
				.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
				.map((part) => part.text).join("\n").trim();
			return text === ""
				? { kind: "terminal-fault", reason: "The compressor returned empty output." }
				: { kind: "success", value: text, actualEffort: input.actualEffort };
		}
		if (message.stopReason !== "error") return { kind: "unknown", reason: `The compressor returned unknown stop reason ${JSON.stringify(message.stopReason)}.` };
		if (!input.retryable) return { kind: "terminal-fault", reason: "The compressor returned a terminal provider error." };
		const policy = input.policy;
		if (!policy || policy.enabled !== true) return { kind: "unknown", reason: "Compressor retries were disabled, so exhaustion is not proved." };
		if (policy.maxRetries === 0) return this.#responses.length === 1 && this.#responses[0] === input.final
			? { kind: "retry-exhausted" }
			: { kind: "unknown", reason: "The zero-budget compressor outcome did not match one physical response." };
		const completeSchedule = this.#scheduled.length === policy.maxRetries && this.#scheduled.every((item, index) => item.attempt === index + 1 && item.maxAttempts === policy.maxRetries);
		const finished = this.#finished?.success === false && this.#finished.attempt === policy.maxRetries;
		if (!this.#malformed && completeSchedule && this.#started === policy.maxRetries && finished && this.#responses.length === policy.maxRetries + 1 && this.#responses.at(-1) === input.final) {
			return { kind: "retry-exhausted" };
		}
		return { kind: "unknown", reason: "The compressor failure did not carry complete Pi retry-exhaustion evidence." };
	}
}

type WorkerRetryEvent =
	| { type: "agent_end"; willRetry: boolean }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number }
	| { type: "auto_retry_end"; success: boolean; attempt: number };

/** Direct worker-session retry evidence, reset for each physical route. */
export class WorkerRetryEvidence {
	readonly #events: WorkerRetryEvent[] = [];
	#malformed = false;

	reset(): void {
		this.#events.length = 0;
		this.#malformed = false;
	}

	observe(event: { type?: unknown; [key: string]: unknown }): void {
		if (event.type === "auto_retry_start") {
			if (!Number.isInteger(event.attempt) || !Number.isInteger(event.maxAttempts) || (event.attempt as number) < 1 || (event.maxAttempts as number) < (event.attempt as number)) {
				this.#malformed = true;
				return;
			}
			this.#events.push({ type: "auto_retry_start", attempt: event.attempt as number, maxAttempts: event.maxAttempts as number });
			return;
		}
		if (event.type === "auto_retry_end") {
			if (typeof event.success !== "boolean" || !Number.isInteger(event.attempt) || (event.attempt as number) < 1) {
				this.#malformed = true;
				return;
			}
			this.#events.push({ type: "auto_retry_end", success: event.success, attempt: event.attempt as number });
			return;
		}
		if (event.type === "agent_end") {
			if (typeof event.willRetry !== "boolean") {
				this.#malformed = true;
				return;
			}
			this.#events.push({ type: "agent_end", willRetry: event.willRetry });
		}
	}

	classify<T>(input: {
		final?: { stopReason?: unknown; errorMessage?: unknown };
		value: T;
		actualEffort: LogicalModelEffort;
		aborted: boolean;
		contextWindow?: number;
	}): AttemptResult<T> {
		if (input.aborted || input.final?.stopReason === "aborted") return { kind: "cancelled" };
		const stopReason = input.final?.stopReason;
		if (typeof stopReason !== "string") return { kind: "unknown", reason: "The worker produced no valid final stop reason." };
		if (["stop", "length", "toolUse"].includes(stopReason)) return { kind: "success", value: input.value, actualEffort: input.actualEffort };
		if (stopReason !== "error") return { kind: "unknown", reason: `The worker produced unknown stop reason ${JSON.stringify(stopReason)}.` };
		const final = input.final as AssistantMessage;
		if (isContextOverflow(final, input.contextWindow)) return { kind: "terminal-fault", reason: "The worker failure is a context-window fault." };
		if (!isRetryableAssistantError(final)) return { kind: "terminal-fault", reason: "The worker failure is not an eligible transient provider fault." };
		if (this.#malformed) return { kind: "unknown", reason: "The worker retry events were malformed." };

		const starts = this.#events.filter((event): event is Extract<WorkerRetryEvent, { type: "auto_retry_start" }> => event.type === "auto_retry_start");
		const maxAttempts = starts[0]?.maxAttempts;
		if (maxAttempts === undefined || starts.length !== maxAttempts) {
			return { kind: "unknown", reason: "The worker failure did not reach the configured Pi retry bound." };
		}
		const orderedStarts = starts.every((event, index) => event.attempt === index + 1 && event.maxAttempts === maxAttempts);
		const expected: WorkerRetryEvent[] = [];
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			expected.push({ type: "agent_end", willRetry: true });
			expected.push({ type: "auto_retry_start", attempt, maxAttempts });
		}
		expected.push({ type: "agent_end", willRetry: false });
		expected.push({ type: "auto_retry_end", success: false, attempt: maxAttempts });
		const exactSequence = orderedStarts && this.#events.length === expected.length && this.#events.every((event, index) => {
			const wanted = expected[index]!;
			return event.type === wanted.type && JSON.stringify(event) === JSON.stringify(wanted);
		});
		return exactSequence
			? { kind: "retry-exhausted" }
			: { kind: "unknown", reason: "The worker failure did not carry ordered Pi retry-exhaustion evidence." };
	}
}

/** Extension-visible retry evidence for one main-session physical route. */
export class MainRetryEvidence {
	readonly #turns: Array<{ message: { stopReason?: unknown; errorMessage?: unknown }; route?: string; effort?: LogicalModelEffort }> = [];

	reset(): void { this.#turns.length = 0; }

	observe(message: { stopReason?: unknown; errorMessage?: unknown }, route: string | undefined, effort: LogicalModelEffort | undefined): void {
		this.#turns.push({ message, ...(route === undefined ? {} : { route }), ...(effort === undefined ? {} : { effort }) });
	}

	settle(input: {
		route: string | undefined;
		effort: LogicalModelEffort | undefined;
		policy: CompressorRetryPolicy | undefined;
		isRetryable(message: { stopReason?: unknown; errorMessage?: unknown }): boolean;
		isContextOverflow(message: { stopReason?: unknown; errorMessage?: unknown }): boolean;
	}): AttemptResult<undefined> {
		const turns = this.#turns.splice(0);
		const final = turns.at(-1)?.message;
		if (!final || typeof final.stopReason !== "string") return { kind: "unknown", reason: "The main session settled without a complete final assistant response." };
		if (final.stopReason === "aborted") return { kind: "cancelled" };
		if (["stop", "length", "toolUse"].includes(final.stopReason)) return { kind: "success", value: undefined, actualEffort: input.effort ?? "off" };
		if (final.stopReason !== "error") return { kind: "unknown", reason: `The main session returned unknown stop reason ${JSON.stringify(final.stopReason)}.` };
		if (input.isContextOverflow(final)) return { kind: "terminal-fault", reason: "The main-session failure is a context-window fault." };
		if (!input.isRetryable(final)) return { kind: "terminal-fault", reason: "The main-session failure is not an eligible transient provider fault." };
		const policy = input.policy;
		if (!policy || policy.enabled !== true || !Number.isInteger(policy.maxRetries) || policy.maxRetries < 0) return { kind: "unknown", reason: "Main-session retries were disabled or unreadable, so exhaustion is not proved." };
		let suffixStart = turns.length;
		while (suffixStart > 0 && turns[suffixStart - 1]!.message.stopReason === "error") suffixStart--;
		const retrySuffix = turns.slice(suffixStart);
		const expected = policy.maxRetries + 1;
		const matching = retrySuffix.length === expected && retrySuffix.every((turn) =>
			input.isRetryable(turn.message) &&
			turn.route !== undefined && turn.route === input.route &&
			turn.effort !== undefined && turn.effort === input.effort
		);
		return matching ? { kind: "retry-exhausted" } : { kind: "unknown", reason: "The final main-session retry suffix did not match the settled route, effort, and retry snapshot." };
	}
}

export interface RecoveryAttemptContext<TToolResult> {
	candidate: RecoveryCandidate;
	retainedToolResults: readonly TToolResult[];
}

export interface RecoveryExecutionInput<T, TToolResult> {
	candidates: readonly RecoveryCandidate[];
	retainedToolResults: readonly TToolResult[];
	validateSwitch(candidate: RecoveryCandidate): SwitchValidation | Promise<SwitchValidation>;
	attempt(context: RecoveryAttemptContext<TToolResult>): AttemptResult<T> | Promise<AttemptResult<T>>;
}

export type RecoveryExecutionResult<T> =
	| { kind: "success"; value: T; candidate: RecoveryCandidate; actualEffort: LogicalModelEffort; attempted: readonly RecoveryCandidate[] }
	| { kind: "cancelled"; candidate: RecoveryCandidate; attempted: readonly RecoveryCandidate[] }
	| { kind: "terminal-fault"; candidate: RecoveryCandidate; reason: string; attempted: readonly RecoveryCandidate[] }
	| { kind: "unknown"; candidate: RecoveryCandidate; reason: string; attempted: readonly RecoveryCandidate[] }
	| { kind: "exhausted"; attempted: readonly RecoveryCandidate[] };

export async function executeRecovery<T, TToolResult>(
	input: RecoveryExecutionInput<T, TToolResult>,
): Promise<RecoveryExecutionResult<T>> {
	const operation = new RecoveryOperation();
	const attempted: RecoveryCandidate[] = [];
	for (const candidate of input.candidates) {
		if (!operation.enter(candidate)) continue;
		let validation: SwitchValidation;
		try {
			validation = await input.validateSwitch(candidate);
		} catch {
			return Object.freeze({ kind: "unknown", candidate, reason: "Switch validation threw before producing evidence.", attempted: Object.freeze([...attempted]) });
		}
		if (!validation.ok && validation.kind === "unavailable") continue;
		if (!validation.ok) return Object.freeze({ kind: "terminal-fault", candidate, reason: validation.reason, attempted: Object.freeze([...attempted]) });
		attempted.push(candidate);
		let result: AttemptResult<T>;
		try {
			result = await input.attempt({ candidate, retainedToolResults: input.retainedToolResults });
		} catch {
			return Object.freeze({ kind: "unknown", candidate, reason: "Execution adapter threw before producing evidence.", attempted: Object.freeze([...attempted]) });
		}
		if (result.kind === "retry-exhausted") continue;
		if (result.kind === "success") return Object.freeze({ kind: "success", value: result.value, candidate, actualEffort: result.actualEffort, attempted: Object.freeze([...attempted]) });
		if (result.kind === "cancelled") return Object.freeze({ kind: "cancelled", candidate, attempted: Object.freeze([...attempted]) });
		return Object.freeze({ kind: result.kind, candidate, reason: result.reason, attempted: Object.freeze([...attempted]) });
	}
	return Object.freeze({ kind: "exhausted", attempted: Object.freeze([...attempted]) });
}

export interface RetainedCompletedResult<T> {
	completed: T;
	compression:
		| { kind: "compressed"; candidate: RecoveryCandidate; actualEffort: LogicalModelEffort }
		| { kind: "failed"; reason: "exhausted" | "cancelled" | "terminal-fault" | "unknown"; notice: string };
}

export async function executeCompression<TCompleted, TCompressed, TToolResult>(
	completed: TCompleted,
	input: RecoveryExecutionInput<TCompressed, TToolResult>,
): Promise<RetainedCompletedResult<TCompleted> & { compressed?: TCompressed }> {
	const result = await executeRecovery(input);
	if (result.kind === "success") {
		return Object.freeze({ completed, compressed: result.value, compression: Object.freeze({ kind: "compressed", candidate: result.candidate, actualEffort: result.actualEffort }) });
	}
	const reason = result.kind;
	const notice = reason === "cancelled" ? "Compression was cancelled. The bounded completed result was retained." : "Compression failed. The bounded completed result was retained.";
	return Object.freeze({ completed, compression: Object.freeze({ kind: "failed", reason, notice }) });
}

export type OwnedExecutionResult<T> =
	| { kind: "completed"; value: T }
	| Extract<RecoveryOwnershipResult, { kind: "busy" }>
	| { kind: "exception"; error: unknown };

export async function executeWithRecoveryOwnership<T>(
	ownership: RecoveryOwnership,
	sessionKey: string,
	savedDefaultKey: string | undefined,
	execute: () => T | Promise<T>,
): Promise<OwnedExecutionResult<T>> {
	const admission = ownership.acquire(sessionKey, savedDefaultKey);
	if (admission.kind === "busy") return admission;
	try {
		return { kind: "completed", value: await execute() };
	} catch (error) {
		return { kind: "exception", error };
	} finally {
		admission.lease.release();
	}
}
