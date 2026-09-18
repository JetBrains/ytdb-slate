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
