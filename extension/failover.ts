/**
 * Model failover: shared helpers for the `modelFailover` config map
 * ("provider/id" → "provider/id"), consumed by the three retry sites
 * (worker dispatch, episode compression, orchestrator turn end).
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
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type RegistryModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

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
