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
 *   model-profiles.ts / model-router.ts — the static routing data and the
 *                 resolver that turns `router.models` into routable candidates
 *   route.ts    — PURE per-action route planning + the seven dispatch guards
 *
 * Optional config at <config dir>/slate.json (config dir = CONFIG_DIR_NAME,
 * ".pi" by default), honored ONLY when the project is trusted — untrusted
 * projects run on built-in defaults with no project file injection:
 *   { "episodeModel": "provider/id", "workerTools": [...],
 *     "workerExtensions": ["regex", ...], "maxConcurrent": 4,
 *     "contextBudget": 256000, "orchestratorModeDefault": true,
 *     "orchestratorPromptDocs": ["docs/orchestrator-guidelines.md"],
 *     "workerPromptDocs": ["docs/thread-guidelines.md"],
 *     "workflow": { "draftPRs": false },
 *     "modelFailover": { "provider/id": "provider/id" },
 *     "preserveGlobalModelDefault": true,
 *     "doctrineExtraPath": "docs/project-doctrine.md",
 *     "reviewPerspectivesPath": "docs/review-perspectives.md",
 *     "router": { "models": ["provider/id", ...], "allowUnmeasuredEffort": true } }
 * router.models is the closed list of models an action may be routed to (empty
 * or absent = router off, the default); allowUnmeasuredEffort (default true)
 * governs effort levels with no capability evidence — see model-router.ts.
 * contextBudget also takes { "tokens": N, "overrides": [{ "match": "regex",
 * "tokens": N }] } (match is anchored against "provider/id"); absent, the
 * built-in defaults apply (256k tokens; 400k for anthropic/*). The DEPRECATED
 * pauseThresholdPercent keeps its legacy percent behavior only when it is set
 * AND contextBudget is absent or entirely invalid (invalid sanitizes to
 * absent — a partially invalid object stays budget mode).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBaseModelTracker, readLiveEffort, type BaseModelTracker } from "./base-model.ts";
import { registerOrchestratorFailover, sanitizeModelFailover } from "./failover.ts";
import { registerSlateHandoff, sanitizeContextBudget } from "./handoff.ts";
import { registerSlateMode } from "./mode.ts";
import { createModelRouterResolver, ROUTER_OFF, sanitizeRouterConfig, type ModelRouterResolution } from "./model-router.ts";
import { sanitizeEpisodeModel, SlateStore, type SlateConfig } from "./state.ts";
import { ThreadManager } from "./threads.ts";
import { registerSlateTools } from "./tools.ts";
import {
	createWorkerExtensionResolver,
	EMPTY_WORKER_EXTENSION_SET,
	sanitizeWorkerExtensions,
	type WorkerExtensionSet,
} from "./worker-extensions.ts";

function loadConfig(cwd: string): SlateConfig {
	const file = join(cwd, CONFIG_DIR_NAME, "slate.json");
	try {
		if (existsSync(file)) {
			// JSON.parse accepts any JSON value; only a non-null plain object is a
			// usable config — a literal `null`, array, or scalar would crash
			// consumers, so anything else falls through to defaults, silently,
			// like any other malformed config.
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				return parsed as SlateConfig;
			}
		}
	} catch {
		/* invalid config → defaults */
	}
	return {};
}

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
	// One MEMOIZED model-router resolution per session (model-router.ts), reassigned
	// every session_start below for the same reason as the resolver above: the
	// candidate list is frozen at first use, and a dispatch guard built from a
	// different resolution than the doctrine describes would be a bug. Starts as the
	// off resolution — dispatch then behaves exactly as it did before the router
	// existed — until session_start has sanitized `router.models`.
	let resolveModelRouterResolution: () => ModelRouterResolution = () => ROUTER_OFF;

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

	let manager = new ThreadManager(store, {}, resolveWorkerExtensionSet, resolveModelRouterResolution, baseModel);

	registerSlateTools(pi, store, () => manager);

	// The base-model tracker's only event ingest. Registered once, reads the LIVE
	// tracker, and pairs each event with the thinking level pi has already clamped
	// by emission time (setModel emits AFTER its thinking cascade).
	pi.on("model_select", async (event) => {
		baseModel.observe(event, readLiveEffort(pi));
	});

	pi.on("session_start", async (_event, ctx) => {
		manager.disposeAll();
		// Trust gate: project config steers prompts, models, and tool lists, so
		// it is honored only for trusted projects; untrusted → built-in defaults.
		const config = ctx.isProjectTrusted() ? loadConfig(ctx.cwd) : {};
		const warn = (msg: string) => (ctx.hasUI ? ctx.ui.notify(msg, "warning") : console.warn(msg));
		// modelFailover, contextBudget and workerExtensions are validated eagerly:
		// a malformed value would otherwise fail silently mid-dispatch / exactly
		// when the auto-pause was supposed to save the orchestrator's context.
		config.modelFailover = sanitizeModelFailover(config.modelFailover, warn);
		config.contextBudget = sanitizeContextBudget(config.contextBudget, warn);
		config.workerExtensions = sanitizeWorkerExtensions(config.workerExtensions, warn);
		// router likewise: a malformed model list must surface at session start, not
		// when a dispatch is refused for naming a model the list silently dropped.
		config.router = sanitizeRouterConfig(config.router, warn);
		// episodeModel too (RG20): an unusable value falls back to the built-in
		// compressor, and until this ran it did so without saying anything at all.
		config.episodeModel = sanitizeEpisodeModel(config.episodeModel, warn);
		if (config.contextBudget !== undefined && config.pauseThresholdPercent !== undefined) {
			warn("slate: contextBudget is set — the deprecated pauseThresholdPercent is ignored");
		}
		// Fresh resolver AFTER sanitization (reads the cleaned patterns) and per
		// session_start (a restart re-resolves). Same warn as the sanitizers so a
		// withheld colliding unit surfaces the same way. First use is later, in a
		// worker open or a doctrine build — after session_start finishes, so tools
		// registered during session_start are captured (AD41).
		resolveWorkerExtensionSet = createWorkerExtensionResolver(pi, () => config.workerExtensions ?? [], warn);
		// Fresh router resolver per session, AFTER sanitization (it reads the cleaned
		// model list) and with the same warn sink, so a dropped model — unprofiled,
		// unknown to the registry, unauthenticated — surfaces the way every other
		// config problem does. Resolution is LAZY and memoized: the registry and auth
		// reads happen at first consultation (a dispatch or the doctrine), after
		// session_start, so a provider another extension registers during startup is
		// visible — and every later consultation gets that same frozen answer (CQ7).
		// `failover` is passed so the resolver can report candidates with no failover
		// coverage; both keys are read through the closure, not captured by value.
		resolveModelRouterResolution = createModelRouterResolver(
			() => ({
				registry: ctx.modelRegistry,
				models: config.router?.models ?? [],
				failover: config.modelFailover ?? {},
			}),
			warn,
		);
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
		// Bound BY VALUE (CN20): this manager keeps THIS session's resolvers and
		// tracker even if a later session_start replaces the module variables above — a
		// manager orphaned by a session swap must not start answering with a newer
		// session's frozen candidate list or a newer base model.
		manager = new ThreadManager(store, config, resolveWorkerExtensionSet, resolveModelRouterResolution, baseModel);
		store.restore(ctx);
	});

	pi.on("session_shutdown", async () => {
		manager.disposeAll();
	});

	// session_start ordering (registration order): restore → adopt pending
	// handoff → re-apply mode tools. registerSlateHandoff must therefore sit
	// between the restore handler above and registerSlateMode below.
	// getConfig reads the CURRENT `manager` (reassigned on session_start).
	const handoff = registerSlateHandoff(pi, store, () => manager.getConfig(), () => baseModel);

	// Orchestrator model failover (turn_end/agent_settled/input) — not
	// order-critical relative to the handlers above (different trigger events).
	registerOrchestratorFailover(pi, () => manager.getConfig(), () => baseModel);

	registerSlateMode(pi, store, handoff, () => manager.getConfig(), () => resolveWorkerExtensionSet());
}
