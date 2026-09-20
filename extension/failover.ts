import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentModelSpec, readLiveEffort, type BaseModelTracker } from "./base-model.ts";
import { MainRetryEvidence, type CompressorRetryPolicy } from "./logical-model-adapters.ts";
import type { LogicalRuntime } from "./logical-model-runtime.ts";
import { RecoveryOperation, type RecoveryAdmission, type RecoveryCandidate, type RecoveryLease } from "./logical-model-recovery.ts";
import { withGlobalModelDefaultRestored } from "./model-default.ts";
import { sanitizeForNotify } from "./notify.ts";
import type { SlateConfig } from "./state.ts";

export const MAIN_RECOVERY_SESSION_KEY = "slate:main-session";
export const SAVED_DEFAULT_RESOURCE_KEY = "slate:global-model-default";
const CONTINUATION = "[slate] The previous main-session response exhausted Pi retries on an eligible transient provider failure. Continue from the retained conversation state. Inspect existing tool results before any new call. Do not replay a completed call.";

type MainOperation = {
	runtime: Readonly<LogicalRuntime>;
	sessionEpoch: number;
	admission: RecoveryAdmission;
	lease: RecoveryLease;
	candidates: readonly RecoveryCandidate[];
	visited: RecoveryOperation;
	next: number;
	transitioning: boolean;
	active?: RecoveryCandidate;
};

function report(ctx: ExtensionContext, message: string): void {
	console.warn(message);
	try { if (ctx.hasUI) ctx.ui.notify(message, "warning"); } catch { /* stale context */ }
}

function notice(ctx: ExtensionContext, message: string): void {
	try { if (ctx.hasUI) ctx.ui.notify(message, "warning"); } catch { /* cosmetic */ }
}

function routeOf(ctx: ExtensionContext): { provider: string; model: string } | undefined {
	try {
		const model = ctx.model;
		return model ? { provider: model.provider, model: model.id } : undefined;
	} catch { return undefined; }
}

/** Main-session logical recovery using only extension-visible retry evidence. */
export function registerOrchestratorFailover(
	pi: ExtensionAPI,
	getConfig: () => SlateConfig,
	getBaseModel: () => BaseModelTracker,
	getRuntime: () => Readonly<LogicalRuntime> | undefined,
	getRetryPolicy: () => CompressorRetryPolicy | undefined,
	getSessionEpoch: () => number = () => 0,
): void {
	const evidence = new MainRetryEvidence();
	let operation: MainOperation | undefined;

	const finish = (held: MainOperation): void => {
		if (operation !== held) return;
		operation = undefined;
		try { held.lease.release(); } catch { /* idempotent lease contract */ }
	};

	const stop = (held: MainOperation, ctx: ExtensionContext, message: string): void => {
		report(ctx, message);
		finish(held);
	};

	const isCurrent = (held: MainOperation): boolean =>
		operation === held && held.runtime.ownership.isCurrentLifecycle() &&
		held.sessionEpoch === getSessionEpoch() && getRuntime() === held.runtime;

	const advance = async (ctx: ExtensionContext): Promise<void> => {
		const current = operation;
		if (!current) return;
		while (current.next < current.candidates.length) {
			const candidate = current.candidates[current.next++]!;
			if (!current.visited.enter(candidate)) continue;
			const validation = await current.runtime.validateRoute(ctx, candidate);
			if (!isCurrent(current)) {
				stop(current, ctx, "slate: main recovery stopped because its session was replaced during route validation. Retry in the current session.");
				return;
			}
			if (!validation.ok && validation.kind === "unavailable") continue;
			if (!validation.ok) {
				stop(current, ctx, `slate: main recovery stopped — ${sanitizeForNotify(validation.reason)} Choose an allowed model.`);
				return;
			}
			const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
			if (!model) continue;
			const from = currentModelSpec(ctx);
			const to = `${candidate.provider}/${candidate.model}`;
			let calledSetter = false;
			try {
				const switched = await withGlobalModelDefaultRestored(
					pi, ctx, getConfig(), { provider: candidate.provider, id: candidate.model },
					async () => {
						calledSetter = true;
						const ok = await getBaseModel().ownSwitch(from, to, () => pi.setModel(model));
						if (!ok) return false;
						pi.setThinkingLevel(candidate.effort);
						return true;
					},
					(ok) => ok || calledSetter,
				);
				if (!switched) continue;
			} catch (error) {
				stop(current, ctx, `slate: main recovery switch to ${sanitizeForNotify(to)} failed — ${sanitizeForNotify(error instanceof Error ? error.message : String(error))}.`);
				return;
			}
			if (!isCurrent(current)) {
				stop(current, ctx, "slate: main recovery stopped because its session was replaced during model switching. The replacement session kept no stale logical identity.");
				return;
			}
			const actual = readLiveEffort(pi);
			if (actual !== candidate.effort) {
				stop(current, ctx, `slate: main recovery stopped after ${sanitizeForNotify(to)} clamped effort to ${sanitizeForNotify(String(actual))}; policy requires ${candidate.effort}. Choose an allowed model.`);
				return;
			}
			current.active = candidate;
			evidence.reset();
			try {
				pi.sendMessage({ customType: "slate-failover", content: CONTINUATION, display: true }, { deliverAs: "steer", triggerTurn: true });
				notice(ctx, `slate: main recovery switched to ${to} at ${actual}.`);
			} catch (error) {
				stop(current, ctx, `slate: main recovery could not continue after switching to ${sanitizeForNotify(to)} — ${sanitizeForNotify(error instanceof Error ? error.message : String(error))}.`);
			}
			return;
		}
		stop(current, ctx, "slate: main recovery exhausted every permitted route. Choose an allowed model to continue.");
	};

	const transition = async (current: MainOperation, ctx: ExtensionContext): Promise<void> => {
		if (operation !== current || current.transitioning) return;
		current.transitioning = true;
		try {
			await advance(ctx);
		} catch (error) {
			stop(current, ctx, `slate: main recovery failed — ${sanitizeForNotify(error instanceof Error ? error.message : String(error))}.`);
		} finally {
			current.transitioning = false;
		}
	};

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
		if (message?.role !== "assistant") return;
		const route = routeOf(ctx);
		evidence.observe(message, route ? `${route.provider}/${route.model}` : undefined, readLiveEffort(pi));
	});

	pi.on("input", async () => {
		// A new request cannot reuse stale evidence. It does not release an owner
		// whose continuation is still in flight.
		evidence.reset();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const existing = operation;
		// Pi may overlap awaited extension callbacks. The operation that owns an
		// asynchronous transition is the only callback allowed to consume evidence,
		// advance, terminate, or release its lease.
		if (existing?.transitioning) return;
		if (existing && !isCurrent(existing)) {
			stop(existing, ctx, "slate: main recovery stopped because its session was replaced. Retry in the current session.");
			return;
		}
		const route = routeOf(ctx);
		const effort = readLiveEffort(pi);
		const outcome = evidence.settle({
			route: route ? `${route.provider}/${route.model}` : undefined,
			effort,
			policy: getRetryPolicy(),
			isRetryable: (message) => isRetryableAssistantError(message as AssistantMessage),
			isContextOverflow: (message) => isContextOverflow(message as AssistantMessage, ctx.model?.contextWindow),
		});

		if (operation) {
			const current = operation;
			if (outcome.kind === "success") {
				const active = current.active;
				const settledRoute = route ? `${route.provider}/${route.model}` : undefined;
				const activeRoute = active ? `${active.provider}/${active.model}` : undefined;
				if (!active || !isCurrent(current) || settledRoute !== activeRoute || effort !== active.effort) {
					stop(current, ctx, "slate: main recovery stopped because the settled route or effort changed before success publication. The external choice was preserved.");
					return;
				}
				current.runtime.publishProvider(current.admission, active.logicalModel, active.provider);
				getBaseModel().adoptLogicalIdentity(active.logicalModel);
				finish(current);
				return;
			}
			if (outcome.kind === "retry-exhausted") { await transition(current, ctx); return; }
			const reason = outcome.kind === "cancelled" ? "cancelled" : outcome.kind === "terminal-fault" ? outcome.reason : outcome.reason;
			stop(current, ctx, `slate: main recovery stopped — ${sanitizeForNotify(reason)} Choose an allowed model or retry later.`);
			return;
		}

		if (outcome.kind !== "retry-exhausted") {
			if (outcome.kind === "cancelled") report(ctx, "slate: main recovery did not start because the run was cancelled.");
			else if (outcome.kind === "terminal-fault") report(ctx, `slate: main recovery did not start — ${sanitizeForNotify(outcome.reason)}`);
			else if (outcome.kind === "unknown" && route) report(ctx, `slate: main recovery did not start — ${sanitizeForNotify(outcome.reason)}`);
			return;
		}
		if (!route) { report(ctx, "slate: main recovery stopped because the active physical route is unavailable. Choose a model."); return; }
		const runtime = getRuntime();
		const admission = runtime?.admit();
		if (!runtime || !admission) { report(ctx, "slate: main recovery is blocked by the logical model policy."); return; }
		const mapping = runtime.reverseMap(route, getBaseModel().currentLogicalIdentity());
		if (mapping.kind !== "one") {
			const detail = mapping.kind === "none" ? "does not map to an allowed logical model" : "maps to several logical models without a trusted identity";
			report(ctx, `slate: main recovery stopped because ${route.provider}/${route.model} ${detail}. Choose a logical model.`);
			return;
		}
		const acquired = runtime.ownership.acquire(MAIN_RECOVERY_SESSION_KEY, SAVED_DEFAULT_RESOURCE_KEY);
		if (acquired.kind === "busy") {
			report(ctx, `slate: main recovery is busy on ${acquired.resource}. No second model switch was started. Retry as a new operation later.`);
			return;
		}
		operation = {
			runtime, sessionEpoch: getSessionEpoch(), admission, lease: acquired.lease,
			candidates: runtime.planOrdinary(mapping.logicalModel, admission.snapshot, route),
			visited: new RecoveryOperation(), next: 0, transitioning: false,
		};
		await transition(operation, ctx);
	});
}
