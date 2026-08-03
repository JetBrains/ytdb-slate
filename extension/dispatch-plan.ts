/**
 * Pure decisions for the within-turn dispatch registry and turn-end join.
 *
 * This module deliberately imports no SDK package. threads.ts owns promises and
 * mutable maps; index.ts owns lifecycle hooks and delivery. Keeping the
 * vocabulary and finite-state decisions here lets both test nets attack the
 * rules without loading threads.ts (which transitively imports pi-ai).
 */

/** A session-scoped dispatch handle. It is not, and cannot be mistaken for, an episode id. */
export type DispatchTicket = `d${number}`;

/** The persisted global, per-project high-water mark from which tickets are minted. */
export interface DispatchTicketMint {
	readonly ticket: DispatchTicket;
	readonly sequence: number;
}

const TICKET = /^d([1-9]\d*)$/;

/**
 * Parse the complete ticket vocabulary. Leading zeroes, zero, unsafe integers,
 * whitespace and episode-shaped ids are refused rather than repaired.
 */
export function parseDispatchTicket(value: unknown): DispatchTicket | undefined {
	if (typeof value !== "string") return undefined;
	const match = TICKET.exec(value);
	if (!match) return undefined;
	const sequence = Number(match[1]);
	return Number.isSafeInteger(sequence) ? (value as DispatchTicket) : undefined;
}

export function isDispatchTicket(value: unknown): value is DispatchTicket {
	return parseDispatchTicket(value) !== undefined;
}

/**
 * Mint the next ticket from a persisted high-water mark. The caller writes the
 * returned sequence back to store.dispatchSeq before exposing the ticket.
 *
 * Invalid persisted values throw. Falling back to zero would silently reuse d1
 * after a snapshot/schema defect, making a stale ticket look current.
 */
export function mintDispatchTicket(highWater: unknown): DispatchTicketMint {
	if (typeof highWater !== "number" || !Number.isSafeInteger(highWater) || highWater < 0) {
		throw new Error("slate: dispatchSeq must be a non-negative safe integer.");
	}
	if (highWater === Number.MAX_SAFE_INTEGER) {
		throw new Error("slate: dispatch ticket sequence is exhausted.");
	}
	const sequence = highWater + 1;
	return { ticket: `d${sequence}`, sequence };
}

/** States owned by one session's outstanding-dispatch registry. */
export type DispatchRegistryState = "pending" | "settled" | "joined" | "abandoned";
export type DispatchRegistryEvent = "settle" | "join" | "abandon";

/**
 * Apply one registry transition. There are only four legal edges:
 *
 *   pending --settle--> settled --join--> joined
 *       |                     |
 *       +------abandon--------+
 *
 * Joined and abandoned are terminal. In particular, duplicate settlement or
 * joining pending work is refused instead of being hidden as idempotency; the
 * join's idempotency belongs to decideDispatchDelivery's run identity gate.
 */
export function transitionDispatchState(state: DispatchRegistryState, event: DispatchRegistryEvent): DispatchRegistryState {
	if (state === "pending" && event === "settle") return "settled";
	if ((state === "pending" || state === "settled") && event === "abandon") return "abandoned";
	if (state === "settled" && event === "join") return "joined";
	throw new Error(`slate: illegal dispatch registry transition ${state} --${event}-->`);
}

/** The mechanical result of one dispatch. It makes no claim that the task succeeded. */
export type DispatchOutcome<T> =
	| { readonly kind: "ok"; readonly value: T }
	| { readonly kind: "failed"; readonly value: T }
	| { readonly kind: "aborted"; readonly reason?: unknown }
	| { readonly kind: "rejected"; readonly reason: unknown };

export interface DispatchOutcomeValue {
	readonly episode: {
		/** "ok" means only that the worker ended cleanly; it is not semantic task success. */
		readonly status: "ok" | "failed";
	};
}

/**
 * Classify a settled registry promise. Abort is explicit and wins over both a
 * rejection and an episode status, leaving the later work-abort policy open:
 * this function observes cancellation; it does not cause it.
 */
export function classifyDispatchOutcome<T extends DispatchOutcomeValue>(
	settled: PromiseSettledResult<T>,
	aborted: boolean,
): DispatchOutcome<T> {
	if (aborted) {
		return settled.status === "rejected" ? { kind: "aborted", reason: settled.reason } : { kind: "aborted" };
	}
	if (settled.status === "rejected") return { kind: "rejected", reason: settled.reason };
	return settled.value.episode.status === "ok"
		? { kind: "ok", value: settled.value }
		: { kind: "failed", value: settled.value };
}

/** Stable identity of the SDK run whose agent_end is being handled. */
export type DispatchRunIdentity = object;

export interface DispatchDeliveryInput {
	readonly aborted: boolean;
	readonly settledCount: number;
	readonly runIdentity: DispatchRunIdentity;
	readonly alreadyJoined?: DispatchRunIdentity;
}

/**
 * followUp is the sole active delivery channel: steer remains user-owned.
 * Durable custom messages are a distinct late-failure mechanism, sent only
 * while idle; they are intentionally not claimed to survive compaction, whose
 * summary may discard their self-describing plain-text content.
 */
export type DispatchDeliveryDecision =
	| { readonly kind: "deliver"; readonly mode: "followUp" }
	| { readonly kind: "skip"; readonly reason: "aborted" | "empty" | "already-joined" };

/**
 * Decide delivery at agent_end. The identity comparison makes the decision
 * idempotent for duplicate agent_end events and re-arms it for a continuation
 * run. Abort and an empty join always suppress delivery, preventing resurrection
 * of a cancelled turn and an engine-level empty-envelope loop.
 */
export function decideDispatchDelivery(input: DispatchDeliveryInput): DispatchDeliveryDecision {
	if (input.alreadyJoined !== undefined && Object.is(input.runIdentity, input.alreadyJoined)) {
		return { kind: "skip", reason: "already-joined" };
	}
	if (input.aborted) return { kind: "skip", reason: "aborted" };
	if (!Number.isSafeInteger(input.settledCount) || input.settledCount <= 0) {
		return { kind: "skip", reason: "empty" };
	}
	return { kind: "deliver", mode: "followUp" };
}
