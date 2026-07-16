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
 *   handoff.ts  — context-budget auto-pause + fresh-session handoff
 *
 * Optional config at <config dir>/slate.json (config dir = CONFIG_DIR_NAME,
 * ".pi" by default), honored ONLY when the project is trusted — untrusted
 * projects run on built-in defaults with no project file injection:
 *   { "episodeModel": "provider/id", "workerTools": [...], "maxConcurrent": 4,
 *     "pauseThresholdPercent": 40, "orchestratorModeDefault": true,
 *     "orchestratorPromptDocs": ["docs/orchestrator-guidelines.md"],
 *     "workerPromptDocs": ["docs/thread-guidelines.md"],
 *     "workflow": { "draftPRs": false },
 *     "doctrineExtraPath": "docs/project-doctrine.md",
 *     "reviewPerspectivesPath": "docs/review-perspectives.md" }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSlateHandoff } from "./handoff.ts";
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
		manager = new ThreadManager(store, ctx.isProjectTrusted() ? loadConfig(ctx.cwd) : {});
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

	registerSlateMode(pi, store, handoff, () => manager.getConfig());
}
