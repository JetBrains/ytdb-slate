/**
 * Per-model request throttle for worker provider calls.
 *
 * ONE instance belongs to ONE main slate session (index.ts creates it at
 * session_start and ThreadManager binds it BY VALUE at construction, the CN20
 * rule every other session-scoped component follows). Every worker session of
 * that main session shares this instance, so the limit is a session-wide limit
 * and not a per-worker one.
 *
 * WHAT IT COUNTS: one LOGICAL request — one call of the SDK stream function.
 * pi-ai's own network retries live INSIDE that call (pi-ai
 * api/openai-responses.js calls onPayload once and then runs
 * retryProviderRequest), so a retried request still counts once.
 *
 * WHICH REQUESTS: only requests whose resolved model uses the
 * `openai-responses` interface, which is exactly the interface slate's prompt
 * cache key supports. Counters are INDEPENDENT for each provider/id, and the
 * cache key is shared by all of them: key identity and counter identity are
 * deliberately separate.
 *
 * ADMISSION: prune, capacity check and timestamp insert happen in ONE
 * synchronous block with no intervening await, so two overlapping admissions
 * cannot both read the same free slot (check-then-act race).
 *
 * FAIRNESS is approximate and randomized on purpose. There is no queue, no
 * arrival order and no bounded wait. A waiter re-competes after every delay,
 * and a FRESH arrival takes one delay before it competes while that model has
 * waiters, which is what keeps a late arrival from always winning.
 *
 * ERRORS ARE NOT SWALLOWED. A cancelled wait rejects, and the request is never
 * sent. Nothing here converts a failure into a silent pass.
 */

import { sanitizeForNotify } from "./notify.ts";

/** The rolling window the limiter counts over. */
export const THROTTLE_WINDOW_MS = 60_000;

/** The one provider interface in scope, matching slate's prompt-cache-key support. */
export const THROTTLED_API = "openai-responses";

export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 12;
export const DEFAULT_BASE_WAIT_MS = 1000;
export const DEFAULT_JITTER_MS = 1000;

/**
 * Accepted configuration ranges. The base wait has a POSITIVE floor because a
 * zero base wait plus a zero jitter bound would make the recheck loop spin with
 * no delay at all. The upper bounds keep one wait inside the window and keep the
 * retained timestamp history small.
 */
export const MIN_MAX_REQUESTS_PER_MINUTE = 1;
export const MAX_MAX_REQUESTS_PER_MINUTE = 1000;
export const MIN_BASE_WAIT_MS = 1;
export const MAX_BASE_WAIT_MS = 60_000;
export const MIN_JITTER_MS = 0;
export const MAX_JITTER_MS = 60_000;

/** Raw project configuration, as read from `.pi/slate.json`. */
export interface RequestThrottleConfig {
	enabled?: boolean;
	maxRequestsPerMinute?: number;
	baseWaitMs?: number;
	jitterMs?: number;
}

/** Session-sanitized configuration. Every field is present and usable. */
export interface SanitizedRequestThrottle {
	enabled: boolean;
	maxRequestsPerMinute: number;
	baseWaitMs: number;
	jitterMs: number;
}

export const REQUEST_THROTTLE_DEFAULTS: SanitizedRequestThrottle = {
	enabled: true,
	maxRequestsPerMinute: DEFAULT_MAX_REQUESTS_PER_MINUTE,
	baseWaitMs: DEFAULT_BASE_WAIT_MS,
	jitterMs: DEFAULT_JITTER_MS,
};

/** Raised when a caller cancels while the throttle holds a request back. */
export class RequestThrottleAbort extends Error {}

function warnIgnored(warn: (msg: string) => void, key: string, raw: unknown, expected: string, fallback: number | boolean): void {
	warn(
		`slate: ignoring requestThrottle.${key} ${sanitizeForNotify(String(raw))} — expected ${expected}. Using ${String(fallback)}.`,
	);
}

function wholeNumberIn(raw: unknown, low: number, high: number): number | undefined {
	return typeof raw === "number" && Number.isInteger(raw) && raw >= low && raw <= high ? raw : undefined;
}

/**
 * Validate the request-throttle configuration eagerly at session start.
 *
 * An invalid value warns by name and falls back to the documented default, the
 * same discipline every other slate config key follows. The limiter is enabled
 * by default and `enabled: false` is its own switch, independent of
 * `cacheKeyEnabled`.
 */
export function sanitizeRequestThrottle(raw: unknown, warn: (msg: string) => void): SanitizedRequestThrottle {
	if (raw === undefined) return { ...REQUEST_THROTTLE_DEFAULTS };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warn(
			`slate: ignoring requestThrottle ${sanitizeForNotify(String(raw))} — expected an object. Using the built-in request throttle defaults.`,
		);
		return { ...REQUEST_THROTTLE_DEFAULTS };
	}
	const value = raw as RequestThrottleConfig;
	let enabled = REQUEST_THROTTLE_DEFAULTS.enabled;
	if (value.enabled !== undefined) {
		if (typeof value.enabled === "boolean") enabled = value.enabled;
		else warnIgnored(warn, "enabled", value.enabled, "a boolean", REQUEST_THROTTLE_DEFAULTS.enabled);
	}
	let maxRequestsPerMinute = REQUEST_THROTTLE_DEFAULTS.maxRequestsPerMinute;
	if (value.maxRequestsPerMinute !== undefined) {
		const parsed = wholeNumberIn(value.maxRequestsPerMinute, MIN_MAX_REQUESTS_PER_MINUTE, MAX_MAX_REQUESTS_PER_MINUTE);
		if (parsed !== undefined) maxRequestsPerMinute = parsed;
		else
			warnIgnored(
				warn,
				"maxRequestsPerMinute",
				value.maxRequestsPerMinute,
				`a whole number from ${MIN_MAX_REQUESTS_PER_MINUTE} to ${MAX_MAX_REQUESTS_PER_MINUTE}`,
				REQUEST_THROTTLE_DEFAULTS.maxRequestsPerMinute,
			);
	}
	let baseWaitMs = REQUEST_THROTTLE_DEFAULTS.baseWaitMs;
	if (value.baseWaitMs !== undefined) {
		const parsed = wholeNumberIn(value.baseWaitMs, MIN_BASE_WAIT_MS, MAX_BASE_WAIT_MS);
		if (parsed !== undefined) baseWaitMs = parsed;
		else
			warnIgnored(
				warn,
				"baseWaitMs",
				value.baseWaitMs,
				`a whole number from ${MIN_BASE_WAIT_MS} to ${MAX_BASE_WAIT_MS}`,
				REQUEST_THROTTLE_DEFAULTS.baseWaitMs,
			);
	}
	let jitterMs = REQUEST_THROTTLE_DEFAULTS.jitterMs;
	if (value.jitterMs !== undefined) {
		const parsed = wholeNumberIn(value.jitterMs, MIN_JITTER_MS, MAX_JITTER_MS);
		if (parsed !== undefined) jitterMs = parsed;
		else
			warnIgnored(
				warn,
				"jitterMs",
				value.jitterMs,
				`a whole number from ${MIN_JITTER_MS} to ${MAX_JITTER_MS}`,
				REQUEST_THROTTLE_DEFAULTS.jitterMs,
			);
	}
	return { enabled, maxRequestsPerMinute, baseWaitMs, jitterMs };
}

/**
 * The counter identity of one request, or undefined when the request is out of
 * scope.
 *
 * A model whose interface is not `openai-responses` is out of scope and is
 * never delayed and never counted. A model that IS in scope but carries no
 * usable provider/id pair counts under one shared fallback identity, because
 * admitting an unidentified in-scope request without counting it would be the
 * one silent bypass this feature must not have.
 */
export function throttleIdentity(model: unknown): string | undefined {
	if (typeof model !== "object" || model === null) return undefined;
	const candidate = model as { api?: unknown; provider?: unknown; id?: unknown };
	if (candidate.api !== THROTTLED_API) return undefined;
	const provider = typeof candidate.provider === "string" && candidate.provider !== "" ? candidate.provider : undefined;
	const id = typeof candidate.id === "string" && candidate.id !== "" ? candidate.id : undefined;
	if (provider === undefined || id === undefined) return `${THROTTLED_API}/unidentified`;
	return `${provider}/${id}`;
}

/** Test seams: a clock, a random source and a cancellable timer. */
export interface RequestThrottleDeps {
	now?: () => number;
	random?: () => number;
	/** Run a waiter after `delayMs`. The returned function cancels the pending run. */
	schedule?: (delayMs: number, run: () => void) => () => void;
	/** Schedule inactive-model cleanup. Defaults to an unreferenced Node timer. */
	scheduleExpiry?: (delayMs: number, run: () => void) => () => void;
}

export interface RequestThrottle {
	readonly settings: SanitizedRequestThrottle;
	/** Resolve when the request may be sent. Reject when the caller cancels. */
	admit(model: unknown, signal?: AbortSignal): Promise<void>;
	/** Retained state, for tests and for the bounded-state claim. */
	inspect(): { models: number; timestamps: number; waiters: number };
}

/** One model's recent admissions and its current waiter count. */
interface ModelWindow {
	times: number[];
	waiters: number;
	cancelExpiry?: () => void;
}

export function createRequestThrottle(
	settings: SanitizedRequestThrottle = REQUEST_THROTTLE_DEFAULTS,
	deps: RequestThrottleDeps = {},
): RequestThrottle {
	const now = deps.now ?? (() => Date.now());
	const random = deps.random ?? Math.random;
	const schedule =
		deps.schedule ??
		((delayMs: number, run: () => void) => {
			const timer = setTimeout(run, delayMs);
			return () => clearTimeout(timer);
		});
	const scheduleExpiry =
		deps.scheduleExpiry ??
		((delayMs: number, run: () => void) => {
			const timer = setTimeout(run, delayMs);
			timer.unref?.();
			return () => clearTimeout(timer);
		});
	const windows = new Map<string, ModelWindow>();
	const frozen: SanitizedRequestThrottle = { ...settings };

	/** Prune the model's window to the rolling period and return the live entry. */
	const windowFor = (key: string, at: number): ModelWindow => {
		let entry = windows.get(key);
		if (entry === undefined) {
			entry = { times: [], waiters: 0 };
			windows.set(key, entry);
		}
		const cutoff = at - THROTTLE_WINDOW_MS;
		let drop = 0;
		while (drop < entry.times.length && (entry.times[drop] as number) <= cutoff) drop += 1;
		if (drop > 0) entry.times.splice(0, drop);
		return entry;
	};

	/** Forget a model that holds neither a recent admission nor a waiter. */
	const forgetIfIdle = (key: string): void => {
		const entry = windows.get(key);
		if (entry === undefined || entry.times.length > 0 || entry.waiters > 0) return;
		entry.cancelExpiry?.();
		windows.delete(key);
	};

	/**
	 * Expire an inactive model without waiting for another request from that model.
	 * One timer follows the oldest retained timestamp. The callback prunes again
	 * against the current clock, then either forgets the model or follows its next
	 * timestamp. This bounds history to one rolling window and prevents a lifetime
	 * map of models that were used only once.
	 */
	const armExpiry = (key: string, entry: ModelWindow): void => {
		if (entry.cancelExpiry !== undefined || entry.times.length === 0) return;
		const delayMs = Math.max(1, (entry.times[0] as number) + THROTTLE_WINDOW_MS - now() + 1);
		entry.cancelExpiry = scheduleExpiry(delayMs, () => {
			entry.cancelExpiry = undefined;
			windowFor(key, now());
			if (entry.times.length === 0) forgetIfIdle(key);
			else armExpiry(key, entry);
		});
	};

	/**
	 * One randomized delay for one waiter.
	 *
	 * The waiter registration, the timer and the abort listener are created and
	 * removed together: whichever of the two outcomes happens first clears the
	 * timer, removes the listener, drops the registration and forgets an idle
	 * model. A cancellation therefore leaves no timer, no waiter count and no map
	 * entry behind, and the caller's request is never sent.
	 */
	const waitOnce = (key: string, entry: ModelWindow, signal: AbortSignal | undefined): Promise<void> => {
		entry.waiters += 1;
		const randomUnit = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
		const delayMs = frozen.baseWaitMs + Math.floor(randomUnit * (frozen.jitterMs + 1));
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			let cancelTimer: (() => void) | undefined;
			const onAbort = () => finish(new RequestThrottleAbort("Request was aborted while the slate request throttle was waiting for capacity. The request was not sent."));
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				cancelTimer?.();
				signal?.removeEventListener("abort", onAbort);
				entry.waiters -= 1;
				forgetIfIdle(key);
				if (error !== undefined) reject(error);
				else resolve();
			};
			if (signal?.aborted === true) {
				finish(new RequestThrottleAbort("Request was aborted before the slate request throttle admitted it. The request was not sent."));
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			cancelTimer = schedule(delayMs, () => finish());
		});
	};

	return {
		settings: frozen,
		async admit(model: unknown, signal?: AbortSignal): Promise<void> {
			if (!frozen.enabled) return;
			const key = throttleIdentity(model);
			if (key === undefined) return;
			if (signal?.aborted === true) {
				throw new RequestThrottleAbort("Request was aborted before the slate request throttle admitted it. The request was not sent.");
			}
			// `waited` is why a waiter cannot be blocked by its own registration: once
			// this caller has taken a delay it competes for capacity whatever the
			// waiter count is, so a model whose only arrival is this one still admits.
			let waited = false;
			for (;;) {
				// ONE synchronous admission unit: prune, check, insert. No await inside.
				const at = now();
				const entry = windowFor(key, at);
				if (entry.times.length < frozen.maxRequestsPerMinute && (entry.waiters === 0 || waited)) {
					entry.times.push(at);
					armExpiry(key, entry);
					return;
				}
				// The entry stays in the map across the wait: either it still holds a
				// recent admission, or this caller's own registration keeps it alive.
				await waitOnce(key, entry, signal);
				waited = true;
			}
		},
		inspect() {
			let timestamps = 0;
			let waiters = 0;
			for (const entry of windows.values()) {
				timestamps += entry.times.length;
				waiters += entry.waiters;
			}
			return { models: windows.size, timestamps, waiters };
		},
	};
}
