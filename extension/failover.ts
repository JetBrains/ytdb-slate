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

import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SlateConfig } from "./state.ts";

type RegistryModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

// Error messages reach ctx.ui.notify, and pi-tui renders control/ANSI codes
// verbatim — strip control characters and cap length before display (same
// pattern as handoff.ts's sanitizeForNotify).
function sanitizeForNotify(s: string, max = 120): string {
	const clean = s.replace(/[\u0000-\u001f\u007f\u009b]/g, "");
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
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
			dropped.push(`"${key}": ${JSON.stringify(value)}`);
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
 * One-shot guard (AF1): set BEFORE the model switch/steer, so that a retry
 * that fails again — or a setModel/steer that throws mid-way — can never
 * loop. It re-arms only on (a) an agent run settling with a non-error final
 * message, or (b) a genuine new user prompt via the `input` event. The
 * `input` event fires for interactive/rpc prompts and sendUserMessage, but
 * NOT for pi.sendMessage custom steers (verified: sendCustomMessage skips
 * the input-event path), so slate's own failover/pause steers cannot re-arm
 * the guard.
 *
 * Deliberately NOT gated on store.paused: failover must run while slate is
 * paused for handoff, so the handoff brief is written by a working model.
 */
export function registerOrchestratorFailover(pi: ExtensionAPI, getConfig: () => SlateConfig): void {
	/** Final assistant message of the last turn (agent_settled has no payload). */
	let lastAssistant: { stopReason?: string; errorMessage?: string; usage?: unknown } | undefined;
	/** One-shot guard (AF1). */
	let failedOver = false;

	pi.on("turn_end", async (event) => {
		const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: unknown };
		if (msg?.role === "assistant") lastAssistant = msg;
	});

	// Genuine new user prompt → re-arm (rule (b) above).
	pi.on("input", async () => {
		failedOver = false;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const msg = lastAssistant;
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
		const mapped = await resolveMappedModel(ctx, getConfig().modelFailover ?? {}, current.provider, current.id);
		if (!mapped) return; // no mapping / unknown / unauthed → the original failure stands

		// AF1: arm the guard BEFORE any side effect (setModel or steering).
		failedOver = true;
		const from = `${current.provider}/${current.id}`;
		const to = `${mapped.provider}/${mapped.id}`;
		try {
			// pi.setModel returns false when no API key is available, but can ALSO
			// throw on a failed live auth check despite the Promise<boolean>
			// contract — handle both. NOTE: on success it persists the mapped model
			// as the user's GLOBAL default (pi semantics; documented caveat).
			if (!(await pi.setModel(mapped))) {
				if (ctx.hasUI) {
					ctx.ui.notify(`slate: model failover to ${to} skipped — no API key. Keeping ${from}.`, "warning");
				}
				return;
			}
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`slate: model failover to ${to} failed — ${sanitizeForNotify(
						error instanceof Error ? error.message : String(error),
					)}. Keeping ${from}.`,
					"warning",
				);
			}
			return;
		}
		if (ctx.hasUI) {
			ctx.ui.notify(`slate: model failover ${from} ⇒ ${to} — retrying the failed turn`, "warning");
		}
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
