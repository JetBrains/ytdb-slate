/**
 * Slate — thread-weaving agent architecture for pi.
 *
 * Implements the Slate architecture — design rationale and principles in
 * ../docs/design-principles.md (module headers cite decision ids D3–D9/M1–M3 from
 * the original ExecPlan, which is not in-repo). An orchestrator (the main pi
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
 *
 * Optional config at <config dir>/slate.json (config dir = CONFIG_DIR_NAME,
 * ".pi" by default), honored ONLY when the project is trusted — untrusted
 * projects run on built-in defaults with no project file injection:
 *   { "episodeModel": "provider/id", "workerTools": [...], "maxConcurrent": 4,
 *     "contextBudget": 256000, "orchestratorModeDefault": true,
 *     "orchestratorPromptDocs": ["docs/orchestrator-guidelines.md"],
 *     "workerPromptDocs": ["docs/thread-guidelines.md"],
 *     "workflow": { "draftPRs": false },
 *     "modelFailover": { "provider/id": "provider/id" },
 *     "doctrineExtraPath": "docs/project-doctrine.md",
 *     "reviewPerspectivesPath": "docs/review-perspectives.md" }
 * contextBudget also takes { "tokens": N, "overrides": [{ "match": "regex",
 * "tokens": N }] } (match is anchored against "provider/id"); absent, the
 * built-in defaults apply (256k tokens; 400k for anthropic/*). The DEPRECATED
 * pauseThresholdPercent keeps its legacy percent behavior only when
 * contextBudget is absent.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOrchestratorFailover, sanitizeModelFailover } from "./failover.ts";
import { registerSlateHandoff, sanitizeContextBudget } from "./handoff.ts";
import { registerSlateMode } from "./mode.ts";
import { SlateStore, type SlateConfig } from "./state.ts";
import { ThreadManager } from "./threads.ts";
import { registerSlateTools } from "./tools.ts";

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
	let manager = new ThreadManager(store, {});

	registerSlateTools(pi, store, () => manager);

	pi.on("session_start", async (_event, ctx) => {
		manager.disposeAll();
		// Trust gate: project config steers prompts, models, and tool lists, so
		// it is honored only for trusted projects; untrusted → built-in defaults.
		const config = ctx.isProjectTrusted() ? loadConfig(ctx.cwd) : {};
		const warn = (msg: string) => (ctx.hasUI ? ctx.ui.notify(msg, "warning") : console.warn(msg));
		// modelFailover and contextBudget are validated eagerly: a malformed
		// value would otherwise fail silently mid-dispatch / exactly when the
		// auto-pause was supposed to save the orchestrator's context.
		config.modelFailover = sanitizeModelFailover(config.modelFailover, warn);
		config.contextBudget = sanitizeContextBudget(config.contextBudget, warn);
		if (config.contextBudget !== undefined && config.pauseThresholdPercent !== undefined) {
			warn("slate: contextBudget is set — the deprecated pauseThresholdPercent is ignored");
		}
		manager = new ThreadManager(store, config);
		store.restore(ctx);
	});

	pi.on("session_shutdown", async () => {
		manager.disposeAll();
	});

	// session_start ordering (registration order): restore → adopt pending
	// handoff → re-apply mode tools. registerSlateHandoff must therefore sit
	// between the restore handler above and registerSlateMode below.
	// getConfig reads the CURRENT `manager` (reassigned on session_start).
	const handoff = registerSlateHandoff(pi, store, () => manager.getConfig());

	// Orchestrator model failover (turn_end/agent_settled/input) — not
	// order-critical relative to the handlers above (different trigger events).
	registerOrchestratorFailover(pi, () => manager.getConfig());

	registerSlateMode(pi, store, handoff, () => manager.getConfig());
}
