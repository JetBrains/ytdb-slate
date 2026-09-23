/**
 * Slate — thread-weaving agent architecture for pi.
 *
 * Implements the Slate architecture — design rationale and principles in
 * ../docs/design-principles.md — module headers cite ids from records that are
 * NOT in-repo: the original ExecPlan's D3–D9/M1–M3, later design rounds'
 * higher-numbered D and W ids, and review findings prefixed by the review that
 * raised them (AD, AF, BG, CN, CQ, DF, N, RG, RI, SE, WB, WS); that doc carries
 * the full key. An orchestrator (the main pi
 * session) dispatches bounded actions to persistent worker threads via the
 * `thread` tool; each completed action returns an episode — a compressed,
 * structured record that the orchestrator composes into further dispatches.
 *
 * Modules:
 *   state.ts    — thread/episode records, session-scoped persistence
 *   worker.ts   — in-process worker AgentSessions (recursion-guarded)
 *   episodes.ts — episode compression (Sonnet-default, D5)
 *   threads.ts  — ThreadManager: queueing, dispatch lifecycle
 *   tools.ts    — thread / threads / episode tools
 *   handoff.ts  — absolute-token context-budget auto-pause (with threshold-
 *                 compaction intercept) + fresh-session handoff
 *   base-model.ts — the orchestrator's base model/effort, excluding slate's own
 *                 failover fallbacks (what a new worker thread defaults to)
 *   logical-model-runtime.ts — frozen parent-session policy and recovery state
 *
 * Optional home configuration lives at `<agent dir>/slate.json`. Trusted project
 * configuration at `<config dir>/slate.json` overrides it recursively.
 * `router.models` uses include, add, replace, and exclude lists of provider-free
 * logical names. `router.compressor.models` is an
 * independent ordered list. Legacy physical router, episodeModel, and
 * modelFailover keys are reported and ignored without migration. Context-budget,
 * worker-extension, workflow, prompt, cache, request-throttle, and writing
 * settings remain independent.
 */

import { join } from "node:path";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, permitsSlateConfig } from "./config.ts";
import type { CompressorRetryPolicy } from "./logical-model-adapters.ts";
import { RecoveryOwnership } from "./logical-model-recovery.ts";
import { createBaseModelTracker, readLiveEffort, type BaseModelTracker } from "./base-model.ts";
import { registerOrchestratorFailover } from "./failover.ts";
import { registerSlateHandoff, sanitizeContextBudget } from "./handoff.ts";
import { createLogicalRuntime, type LogicalRuntime } from "./logical-model-runtime.ts";
import { registerSlateMode } from "./mode.ts";
import {
	sanitizeCacheKeyEnabled,
	sanitizeWorkflowConfig,
	SlateStore,
	warnRemovedCacheKeyShards,
} from "./state.ts";
import { createRequestThrottle, sanitizeRequestThrottle } from "./request-throttle.ts";
import { createSessionPromptCacheKey, ThreadManager, type ThreadSessionScope } from "./threads.ts";
import { registerSlateTools } from "./tools.ts";
import {
	createWorkerExtensionResolver,
	EMPTY_WORKER_EXTENSION_SET,
	sanitizeWorkerExtensions,
	type WorkerExtensionSet,
} from "./worker-extensions.ts";
import { sanitizeWritingConfig } from "./writing.ts";

export default function (pi: ExtensionAPI) {
	const store = new SlateStore(pi);
	// One worker-extension resolver per session (AD41), reassigned every
	// session_start below. The DOCTRINE consumer (registerSlateMode) reads it
	// through the live `() => resolveWorkerExtensionSet()` indirection because it
	// always belongs to the CURRENT session. ThreadManager instead binds the
	// resolver instance BY VALUE at construction (CN20): a manager orphaned by a
	// session swap must keep resolving against ITS OWN session's frozen set, not a
	// later session's — the live indirection would leak the newer set into the
	// stale manager. Starts as the empty set (feature off) until session_start.
	let resolveWorkerExtensionSet: () => WorkerExtensionSet = () => EMPTY_WORKER_EXTENSION_SET;

	// One base-model tracker per session (base-model.ts), reassigned every
	// session_start below so its seed and its one-report-per-condition budget are
	// per session. TWO consumption modes, deliberately different (CQ12): the SWITCH
	// SITES (failover.ts, handoff.ts) take the live `() => baseModel` indirection,
	// because a switch always belongs to the CURRENT session; ThreadManager instead
	// binds the instance BY VALUE at construction (CN20), so a manager orphaned by a
	// session swap keeps answering with its own session's base model rather than a
	// newer one's. Constructed eagerly here — before any session_start — so a
	// model_select arriving during startup has somewhere to land, and so even the
	// pre-session manager below can be given one; that pre-session instance reports
	// through the console, since no extension context exists yet.
	let baseModel: BaseModelTracker = createBaseModelTracker({ warn: (msg) => console.warn(msg) });
	let logicalRuntime: Readonly<LogicalRuntime> | undefined;
	let logicalSessionEpoch = 0;
	let compressorRetryPolicy: CompressorRetryPolicy | undefined;
	// Factory-local execution state uses one owner. Active saved-default leases
	// share the exact global settings resource across replacement factories.
	const lifecycleRecoveryOwnership = new RecoveryOwnership(join(getAgentDir(), "settings.json"));

	// One prompt-cache key and one request throttle belong to this main session.
	let sessionScope: ThreadSessionScope = {
		promptCacheKey: createSessionPromptCacheKey(),
		requestThrottle: createRequestThrottle(),
	};

	let manager = new ThreadManager(store, {}, resolveWorkerExtensionSet, logicalRuntime, compressorRetryPolicy, sessionScope);

	registerSlateTools(pi, store, () => manager);

	// The base-model tracker's only event ingest. Registered once, reads the LIVE
	// tracker, and pairs each event with the thinking level pi has already clamped
	// by emission time (setModel emits AFTER its thinking cascade).
	pi.on("model_select", async (event) => {
		baseModel.observe(event, readLiveEffort(pi));
	});

	pi.on("session_start", async (_event, ctx) => {
		// Invalidate asynchronous recovery before replacing session-owned state.
		logicalSessionEpoch += 1;
		await manager.disposeAll();
		store.startRuntime();
		logicalRuntime?.resetPreferences();
		// Select permitted Slate sources without changing pi project trust.
		const trusted = ctx.isProjectTrusted();
		const warn = (msg: string) => (ctx.hasUI ? ctx.ui.notify(msg, "warning") : console.warn(msg));
		const config = loadConfig(ctx.cwd, trusted, warn);
		try {
			compressorRetryPolicy = Object.freeze(SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: trusted,
			}).getRetrySettings());
		} catch {
			compressorRetryPolicy = undefined;
			warn("slate: Pi retry settings could not be read. Episode compression will retain completed output instead of advancing between models.");
		}
		// Context budget and worker extensions are validated eagerly.
		config.contextBudget = sanitizeContextBudget(config.contextBudget, warn);
		config.workerExtensions = sanitizeWorkerExtensions(config.workerExtensions, warn);
		config.cacheKeyEnabled = sanitizeCacheKeyEnabled(config.cacheKeyEnabled, warn);
		// Cache-key partitioning is removed. Keep request pacing independent of key injection.
		warnRemovedCacheKeyShards(config.cacheKeyShards, warn);
		const requestThrottleSettings = sanitizeRequestThrottle(config.requestThrottle, warn);
		config.requestThrottle = requestThrottleSettings;
		config.writing = sanitizeWritingConfig(config.writing, warn);
		config.workflow = sanitizeWorkflowConfig(config.workflow, warn);
		if (config.contextBudget !== undefined && config.pauseThresholdPercent !== undefined) {
			warn("slate: contextBudget is set — the deprecated pauseThresholdPercent is ignored");
		}
		// Fresh resolver AFTER sanitization (reads the cleaned patterns) and per
		// session_start (a restart re-resolves). Same warn as the sanitizers so a
		// withheld colliding unit surfaces the same way. First use is later, in a
		// worker open or a doctrine build — after session_start finishes, so tools
		// registered during session_start are captured (AD41).
		resolveWorkerExtensionSet = createWorkerExtensionResolver(pi, () => config.workerExtensions ?? [], warn);
		// Fresh tracker per session, seeded from the session's OWN resolved model —
		// undefined is legitimate (no model, or no auth for one) and stays silent.
		// Same warn channel as the sanitizers above. A handoff adoption re-seeds it
		// later, from registerSlateHandoff's session_start handler (registered below,
		// so it runs after this one). Created BEFORE the ThreadManager below on
		// purpose: a consumer that binds it BY VALUE at construction (the CN20 rule the
		// worker-extension resolver follows) must capture THIS session's tracker, not
		// the previous session's.
		// pi's OWN model value is handed over raw, never pre-canonicalised (BG13):
		// canonicalising here would collapse "this session has no model" (legitimate and
		// silent) and "this session's model is not a usable provider/id" (a reportable
		// surprise) into the same absent value, leaving the tracker's diagnostic
		// unreachable. An effort level is meaningless without a model, so it is read only
		// when there is one.
		baseModel = createBaseModelTracker({ warn });
		baseModel.seed(ctx.model, ctx.model ? readLiveEffort(pi) : undefined);
		// One policy and preference owner for this parent session. Later Track 9
		// consumers must receive this same object rather than resolving again.
		logicalRuntime = createLogicalRuntime({ trusted: permitsSlateConfig(config, trusted), projectConfig: config, warn, ownership: lifecycleRecoveryOwnership });
		for (const error of logicalRuntime.criticalErrors) warn(`slate: logical model policy blocked — ${error}`);
		const selected = ctx.model
			? logicalRuntime.reverseMap({ provider: ctx.model.provider, model: ctx.model.id })
			: { kind: "none" as const };
		baseModel.adoptLogicalIdentity(selected.kind === "one" ? selected.logicalModel : undefined);
		// Bound BY VALUE (CN20): this manager keeps THIS session's resolvers and
		// tracker even if a later session_start replaces the module variables above — a
		// manager orphaned by a session swap must not start answering with a newer
		// session's frozen candidate list or a newer base model.
		// Fresh cache key and request budget for this parent session.
		sessionScope = {
			promptCacheKey: createSessionPromptCacheKey(),
			requestThrottle: createRequestThrottle(requestThrottleSettings),
		};
		manager = new ThreadManager(store, config, resolveWorkerExtensionSet, logicalRuntime, compressorRetryPolicy, sessionScope);
		store.restore(ctx);
	});

	pi.on("session_shutdown", async () => {
		// Pi creates a new extension factory for replacement sessions. Mark every
		// callback from this factory obsolete, but keep each active lease until the
		// operation that acquired it reaches its own completion path.
		lifecycleRecoveryOwnership.retireLifecycle();
		await manager.disposeAll();
	});

	// session_start ordering (registration order): restore → adopt pending
	// handoff → re-apply mode tools. registerSlateHandoff must therefore sit
	// between the restore handler above and registerSlateMode below.
	// getConfig reads the CURRENT `manager` (reassigned on session_start).
	const handoff = registerSlateHandoff(pi, store, () => manager.getConfig(), () => baseModel, () => logicalRuntime);

	// Orchestrator model failover (turn_end/agent_settled/input) — not
	// order-critical relative to the handlers above (different trigger events).
	registerOrchestratorFailover(
		pi,
		() => manager.getConfig(),
		() => baseModel,
		() => logicalRuntime,
		() => compressorRetryPolicy,
		() => logicalSessionEpoch,
	);

	registerSlateMode(
		pi,
		store,
		handoff,
		() => manager.getConfig(),
		() => resolveWorkerExtensionSet(),
		() => logicalRuntime,
	);
}
