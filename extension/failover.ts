/**
 * Model failover: shared helpers for the `modelFailover` config map
 * ("provider/id" → "provider/id"), consumed by the three retry sites
 * (worker dispatch, episode compression, orchestrator), plus the
 * orchestrator-side registration itself (registerOrchestratorFailover).
 *
 * Rules baked in here:
 *  - SINGLE HOP: a mapping's target is never itself re-looked-up in the map,
 *    so chains and cycles in the config are inert — one failed model buys at
 *    most one retry on its mapped model.
 *  - Classification is STATE-based, not message-based (AF10): pi signals
 *    preflight auth failures as plain Errors with prose messages, so
 *    substring matching would silently break on a pi wording change (peer dep
 *    is "*"). Instead, isAuthFailure re-runs the registry auth check, which
 *    reads credentials fresh on every call.
 *  - Context-overflow failures never qualify (isContextOverflow): switching
 *    models cannot shrink an oversized prompt, and pi has its own overflow
 *    handling. "aborted" stops never qualify either (AF11): a user or
 *    orchestrator cancellation must not be answered with a retry.
 */

import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withGlobalModelDefaultRestored } from "./model-default.ts";
import type { SlateConfig } from "./state.ts";

type RegistryModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

// Error messages reach ctx.ui.notify, and pi-tui renders control/ANSI codes
// verbatim — strip control characters and cap length before display (same
// pattern as handoff.ts's sanitizeForNotify).
function sanitizeForNotify(s: string, max = 120): string {
	const clean = s.replace(/[\u0000-\u001f\u007f\u009b]/g, "");
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// Console-first reporting, for FAILURES ONLY: the console line is
// unconditional, so a failover that could not happen still surfaces in
// headless runs and at teardown — the has-UI branch is exactly the one that
// vanishes there — and the UI notification is the extra. Success notices keep
// their has-UI gate: an unconditional stderr write during an interactive turn
// scribbles pi-tui's differentially rendered frame, and a failover that worked
// is not news worth that cost. ctx.hasUI is a getter that THROWS on a stale
// context, so it is guarded: an unguarded check would be a crash, not a test.
function reportFailure(ctx: ExtensionContext, message: string): void {
	console.warn(message);
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
	} catch {
		/* stale ctx — the console line above stands */
	}
}

// UI-only notice, as before this module gained a restore mechanism: shown when
// a UI exists, silent otherwise — only the guard is new, since ctx.hasUI throws
// on a stale context.
function notifyUi(ctx: ExtensionContext, message: string): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
	} catch {
		/* stale ctx — a cosmetic notice is not worth unwinding the handler */
	}
}

/** "provider/id": slash at index > 0 with a non-empty id after it. */
function isModelSpec(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

/**
 * Validate the raw `modelFailover` config value. Keeps only entries where key
 * and value are both "provider/id" strings and key !== value (a self-mapping
 * could never help). Drops everything else with ONE aggregate warning;
 * non-object input yields an empty map (absent = feature off, silently).
 */
export function sanitizeModelFailover(
	raw: unknown,
	warn: (msg: string) => void,
): Record<string, string> {
	if (raw === undefined) return {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warn('slate: ignoring modelFailover — expected an object mapping "provider/id" to "provider/id"');
		return {};
	}
	const map: Record<string, string> = {};
	const dropped: string[] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (isModelSpec(key) && isModelSpec(value) && key !== value) {
			map[key] = value;
		} else {
			// CQ1: keys/values come from user-edited slate.json and reach
			// ctx.ui.notify — strip control/ANSI codes before display.
			dropped.push(sanitizeForNotify(`"${key}": ${JSON.stringify(value)}`));
		}
	}
	if (dropped.length > 0) {
		warn(
			`slate: dropped invalid modelFailover entries (need "provider/id" → "provider/id", key ≠ value):\n` +
				dropped.join("\n"),
		);
	}
	return map;
}

/**
 * True iff a finished assistant message is a failure that a model switch
 * could plausibly fix: stopReason "error" that is NOT a context overflow.
 * Never true for "aborted" (or any other stopReason), or for a missing
 * message.
 */
export function isFailoverCandidate(
	msg: { stopReason?: string; errorMessage?: string; usage?: unknown } | undefined,
	contextWindow: number | undefined,
): boolean {
	if (!msg || msg.stopReason !== "error") return false;
	return !isContextOverflow(msg as AssistantMessage, contextWindow);
}

/**
 * Resolve the failover target for the current model: look up
 * map["provider/id"], resolve it against the registry, and verify auth.
 * Returns the Model when all three succeed, undefined otherwise. Single hop:
 * the result is returned as-is, never fed back through the map.
 */
export async function resolveMappedModel(
	ctx: ExtensionContext,
	map: Record<string, string>,
	currentProvider: string,
	currentId: string,
): Promise<RegistryModel | undefined> {
	const target = map[`${currentProvider}/${currentId}`];
	if (!isModelSpec(target)) return undefined;
	const slash = target.indexOf("/");
	const model = ctx.modelRegistry.find(target.slice(0, slash), target.slice(slash + 1));
	if (!model) return undefined;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return undefined;
	} catch {
		return undefined;
	}
	return model;
}

/**
 * State-based auth classification (AF10): after a caught preflight throw,
 * re-run the registry auth check on the model that was in use. True when
 * credentials are missing/bad NOW — no error-message parsing. A throwing
 * check counts as failed auth: if credentials cannot even be resolved, a
 * mapped-model retry is the right response.
 */
export async function isAuthFailure(ctx: ExtensionContext, model: RegistryModel): Promise<boolean> {
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		return !auth.ok;
	} catch {
		return true;
	}
}

/**
 * Orchestrator-side model failover.
 *
 * Trigger point is `agent_settled`: pi fires it only after its own retry,
 * compaction, and queued-continuation logic is fully done — so a mapped
 * retry never races or duplicates pi's built-in retries. The event carries
 * no payload, so the final assistant message of the last turn is cached from
 * `turn_end` (which fires even for errored/aborted runs).
 *
 * One-shot guard (AF1): armed synchronously BEFORE the handler's first await
 * (CN3 — a second, independent run can settle and enter this handler while
 * the first invocation is parked at an await; the pre-await arm makes the
 * second invocation bail on the guard check). The guard deliberately STAYS
 * armed on the no-map/no-auth/setModel-failed early-outs: failover cannot
 * succeed right now anyway, and the guard re-arms on the next non-error
 * settle or user prompt. Re-arm rules: (a) an agent run settling with a
 * non-error final message, or (b) a genuine new user prompt via the `input`
 * event. The `input` event fires for interactive/rpc prompts and
 * sendUserMessage, but NOT for pi.sendMessage custom steers (verified:
 * sendCustomMessage skips the input-event path), so slate's own
 * failover/pause steers cannot re-arm the guard.
 *
 * BG2 (cancel during pi's auto-retry backoff): cancelling during the backoff
 * sleep emits NO extension-visible event — `auto_retry_end` is a
 * session-subscriber event only, no fresh turn_end fires, and agent.abort()
 * no-ops because the agent loop already returned — so the settle after a
 * cancel is indistinguishable by event shape from "retries exhausted". The
 * guard below reconstructs the distinction: pi retries an error iff
 * isRetryableAssistantError(msg) (agent-session's _isRetryableError minus
 * the overflow case, which isFailoverCandidate already excluded), so for a
 * retryable error "exhausted" means exactly maxRetries+1 consecutive errored
 * turns, while a backoff cancel settles with ≤ maxRetries of them. The
 * consecutive counter mirrors pi's own _retryAttempt reset-on-success rule.
 * RESIDUAL GAP: the retry settings are re-read here at settle time, so a
 * mid-flight settings change — or a pi release changing its retry semantics
 * (peer dep "*") — can desync the threshold; the failure mode is a skipped
 * failover (conservative), or a failover on a cancelled run only if
 * maxRetries was LOWERED mid-cycle.
 *
 * Deliberately NOT gated on store.paused: failover must run while slate is
 * paused for handoff, so the handoff brief is written by a working model.
 */
export function registerOrchestratorFailover(pi: ExtensionAPI, getConfig: () => SlateConfig): void {
	/** Final assistant message of the last turn (agent_settled has no payload). */
	let lastAssistant: { stopReason?: string; errorMessage?: string; usage?: unknown } | undefined;
	/** Consecutive errored assistant turns in the current settle cycle (BG2). */
	let consecutiveErrors = 0;
	/** One-shot guard (AF1). */
	let failedOver = false;

	pi.on("turn_end", async (event) => {
		const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: unknown };
		if (msg?.role !== "assistant") return;
		lastAssistant = msg;
		// Mirrors pi's auto-retry counter: any non-error assistant message resets
		// it (agent-session resets _retryAttempt on success the same way).
		if (msg.stopReason === "error") consecutiveErrors++;
		else consecutiveErrors = 0;
	});

	// Genuine new user prompt → re-arm (rule (b) above) and drop stale caches.
	pi.on("input", async () => {
		failedOver = false;
		lastAssistant = undefined;
		consecutiveErrors = 0;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const msg = lastAssistant;
		const errors = consecutiveErrors;
		// BG3/CN5: consume the caches — a later settle that produced no fresh
		// turn_end (e.g. a run throwing before its first turn completes) must
		// never re-classify this run's message.
		lastAssistant = undefined;
		consecutiveErrors = 0;
		if (!msg || msg.stopReason !== "error") {
			// Non-error settle (including aborts — never fail over on abort):
			// the model works, re-arm the guard (rule (a) above).
			failedOver = false;
			return;
		}
		if (failedOver) return;
		const current = ctx.model;
		if (!current) return;
		if (!isFailoverCandidate(msg, current.contextWindow)) return;

		// BG2 guard (see header): for a retryable error, only pi exhausting its
		// auto-retries reaches settle with maxRetries+1 consecutive errored
		// turns; fewer means the user cancelled during a backoff sleep — a
		// cancelled run must NEVER fail over. Non-retryable errors (quota,
		// billing, auth…) fail fast with no backoff to cancel, so they pass.
		// SettingsManager.create is a synchronous, lock-protected read of the
		// same merged settings pi uses. READ-ONLY, and it must stay that way: a
		// setter call on this throwaway instance would write straight into the
		// user's GLOBAL settings unmediated — every write goes through
		// model-default.ts instead.
		if (isRetryableAssistantError(msg as AssistantMessage)) {
			try {
				const retry = SettingsManager.create(ctx.cwd, getAgentDir(), {
					projectTrusted: ctx.isProjectTrusted(),
				}).getRetrySettings();
				if (retry.enabled && errors <= retry.maxRetries) return;
			} catch {
				return; // cannot read retry settings ⇒ cannot rule out a cancel → stand down
			}
		}

		// AF1/CN3: arm the guard BEFORE the first await — a concurrent settle
		// entering this handler while we are parked below must bail above. Stays
		// armed on every early-out (see header).
		failedOver = true;
		const mapped = await resolveMappedModel(ctx, getConfig().modelFailover ?? {}, current.provider, current.id);
		if (!mapped) return; // no mapping / unknown / unauthed → the original failure stands
		const from = `${current.provider}/${current.id}`;
		const to = `${mapped.provider}/${mapped.id}`;
		// pi.setModel persists the switch into the user's GLOBAL settings
		// (defaultProvider, defaultModel and, through its thinking cascade,
		// defaultThinkingLevel) — a session-scoped failover must not leave that
		// behind, so the switch runs inside the shared restore wrapper, which
		// puts back exactly what THIS switch changed (model-default.ts).
		// Sequencing matters: the wrapper completes the restore BEFORE the
		// steer below, so settings are already clean even if the steer then
		// fails on a stale context.
		// Set when pi.setModel THREW: the throw can land after pi already wrote the
		// pair (it persists before the thinking cascade and the model-select
		// emission), so that case must still be treated as "may have persisted"
		// even though the switch failed. Read by the predicate below, which runs
		// after the callback has resolved.
		let mayHaveWritten = false;
		const switched = await withGlobalModelDefaultRestored(
			pi,
			ctx,
			getConfig(),
			mapped,
			async () => {
				try {
					// pi.setModel returns false when no API key is available, but can ALSO
					// throw on a failed live auth check despite the Promise<boolean>
					// contract — handle both.
					if (!(await pi.setModel(mapped))) {
						reportFailure(ctx, `slate: model failover to ${to} skipped — no API key. Keeping ${from}.`);
						return false;
					}
				} catch (error) {
					mayHaveWritten = true;
					reportFailure(
						ctx,
						`slate: model failover to ${to} failed — ${sanitizeForNotify(
							error instanceof Error ? error.message : String(error),
						)}. Keeping ${from}.`,
					);
					return false;
				}
				return true;
			},
			// A plain false return means pi.setModel bailed on its own auth check
			// BEFORE touching settings (the extension-facing setModel returns false
			// ahead of the session setter), so nothing can have been persisted and
			// the whole post-switch phase is skipped — unless it failed by THROWING.
			(ok) => ok || mayHaveWritten,
		);
		if (!switched) return;
		notifyUi(ctx, `slate: model failover ${from} ⇒ ${to} — retrying the failed turn`);
		pi.sendMessage(
			{
				customType: "slate-failover",
				content:
					`[slate] The previous turn failed due to a model API failure. The model has been switched to ${to}. ` +
					"The conversation context is intact — re-issue the failed action and continue.",
				display: true,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	});
}
