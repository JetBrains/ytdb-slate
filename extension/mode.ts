/**
 * Orchestrator mode (ExecPlan M2, D4).
 *
 * `/slate` toggles orchestrator mode:
 *   - active tools restricted to read-only + slate tools (no bash/edit/write):
 *     delegation becomes the natural behavior;
 *   - the thread-weaving doctrine is appended to the system prompt each turn;
 *   - a widget above the editor shows live thread status;
 *   - the mode persists in slate state and is re-applied on session restore;
 *   - with config `orchestratorModeDefault` (slate.json), genuinely fresh
 *     interactive sessions are seeded with the mode ON (unsaved until the
 *     first real state mutation).
 *
 * `/slate handoff [focus]` / `/slate resume` interact with the auto-pause
 * machinery in handoff.ts (context budget → paused → fresh-session handoff).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SlateHandoffHooks } from "./handoff.ts";
import {
	DESIGN_PRINCIPLES_DOC,
	PR_PUBLISHING_DOC,
	REVIEW_RULES_DOC,
	TRACK_WORKFLOW_DOC,
} from "./paths.ts";
import { loadPromptDocs } from "./prompt-docs.ts";
import { orchestratorCostUsd, type SlateConfig, type SlateStore } from "./state.ts";
import type { WorkerExtensionSet, WorkerExtensionUnit } from "./worker-extensions.ts";

const ORCHESTRATOR_TOOLS = ["read", "grep", "find", "ls", "thread", "threads", "episode"];

/**
 * Build the orchestrator doctrine. Rules 8–10 reference the package-shipped
 * workflow/review/design docs by ABSOLUTE path (paths.ts) so they resolve
 * wherever the package is installed. Rules 8 and 9 carry config-dependent
 * tails (workflow.draftPRs, reviewPerspectivesPath), so the doctrine is
 * assembled per prompt rather than kept as a constant. Project-derived
 * additions (rule 9's perspectives pointer) apply only when `trusted` and
 * the file exists (cwd-resolved) — missing files are skipped silently like
 * every other project doc.
 */
// A source spec that names WHICH extension (e.g. "npm:foo") is worth showing;
// the generic scope-ish sources are not, so rule 11 falls back to the unit path.
const UNINFORMATIVE_SOURCES = new Set(["", "auto", "local", "cli", "project", "user", "temporary", "builtin", "sdk"]);

function unitLabel(unit: WorkerExtensionUnit): string {
	return UNINFORMATIVE_SOURCES.has(unit.source) ? unit.path : unit.source;
}

// One-line descriptions for the doctrine: collapse all whitespace and truncate
// to ~140 chars so a verbose tool description cannot bloat the system prompt.
function oneLineDescription(description: string, max = 140): string {
	const collapsed = description.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}\u2026` : collapsed;
}

/**
 * Rule 11 (worker-extension awareness): appended ONLY when workers load extra
 * pi extensions. With no units it returns "" so the doctrine is byte-identical
 * to the pre-feature output. Rendered in the doctrine's imperative voice; the
 * orchestrator is told these tools live in the WORKERS, not in itself.
 */
function buildWorkerExtensionsRule(extensions: WorkerExtensionSet): string {
	if (extensions.units.length === 0) return "";
	const lines = [
		"11. Worker threads additionally load these pi extensions — you do NOT have",
		"   their tools yourself; delegate work that needs them to a thread:",
	];
	for (const unit of extensions.units) {
		lines.push(`   - ${unitLabel(unit)}`);
		for (const tool of unit.tools) {
			lines.push(`     ${tool.name}: ${oneLineDescription(tool.description)}`);
		}
	}
	lines.push(
		"   These tools are active in EVERY worker thread, on top of whatever `tools`",
		"   allowlist you pass to the thread tool.",
	);
	return `\n${lines.join("\n")}`;
}

function buildDoctrine(cwd: string, config: SlateConfig, trusted: boolean, extensions: WorkerExtensionSet): string {
	// Rule 8 tail: with draft-PR publishing enabled, the umbrella draft PR is
	// one of the gates; otherwise durable records live in the workflow log.
	const rule8Tail =
		config.workflow?.draftPRs === true
			? `An umbrella draft PR is part of the pre-implementation gates; PR
   publishing mechanics are in ${PR_PUBLISHING_DOC}.`
			: `Durable workflow records anchor in the retained repo-root workflow
   log per the workflow doc.`;
	const perspectives = config.reviewPerspectivesPath;
	const rule9Tail =
		trusted && typeof perspectives === "string" && perspectives && existsSync(resolve(cwd, perspectives))
			? `
   Project-specific review perspectives are defined in ${perspectives} —
   load them alongside the review rules when composing reviewers.`
			: "";
	return `

# Slate orchestrator mode

You are the orchestrator of a thread-weaving system. You strategize; worker
threads execute. Rules:

1. Do tactical work ONLY by dispatching bounded actions via the \`thread\` tool
   (one action = one clear, completable task). You cannot edit files or run
   commands yourself.
2. Dispatch independent actions in PARALLEL by emitting several \`thread\`
   calls in one turn. Never serialize what can run concurrently.
3. Reuse a thread for follow-up actions in the same work stream — it
   remembers its prior episodes. Create a new thread for a new work stream.
4. Compose context by reference: pass prior episode ids in \`context\` instead
   of restating their content.
5. Your read-only tools (read/grep/find/ls) are for cheap orientation only;
   anything substantial goes to a thread.
6. After every episode, update your strategy. Episodes marked STATUS: FAILED
   require adaptation, not blind retry.
7. Keep your own messages strategic: goals, task routing, synthesis.
8. Repository changes follow the slate track-based workflow — read
   ${TRACK_WORKFLOW_DOC}
   (skip the read if it is already in your context). Before the FIRST
   dispatch that modifies files, confirm the pre-implementation gates ran
   (user design review, adversarial review, user-approved scope).
   ${rule8Tail}
9. Every non-trivial change gets reviewed before it is declared done.
   Before dispatching review threads, read
   ${REVIEW_RULES_DOC}
   (skip the read if it is already in your context) and follow it.${rule9Tail}
10. The design principles behind this architecture are documented in
   ${DESIGN_PRINCIPLES_DOC}.
   Read that file only when you must reason about slate itself (explaining
   it, changing the extension, or an unusual routing/compaction decision) —
   never for routine dispatching. Skip the read if it is already in your
   context.${buildWorkerExtensionsRule(extensions)}`;
}

/**
 * Project doctrine extension (config doctrineExtraPath): read at prompt-
 * assembly time so edits are picked up live, appended AFTER the numbered
 * rules under a labeled section, headed by the configured (cwd-relative)
 * path as given in config. Missing/unreadable/empty file or a non-string
 * path → no block, silently (matches the malformed-config behavior of
 * prompt-docs.ts). Never injected for untrusted projects. Blocks carry NO
 * separators — the call site prefixes them, like the prompt-doc blocks.
 */
function loadDoctrineExtra(cwd: string, config: SlateConfig, trusted: boolean): string[] {
	const path = config.doctrineExtraPath;
	if (!trusted || typeof path !== "string" || !path) return [];
	try {
		const content = readFileSync(resolve(cwd, path), "utf8").trim();
		if (!content) return [];
		return [`# Project doctrine (injected from ${path})\n\n${content}`];
	} catch {
		return [];
	}
}

const PAUSED_ADDENDUM = `

# PAUSED — context budget exceeded

Slate is paused for handoff: thread dispatches are REJECTED. Do not start new
work. Reply with a concise handoff brief (overall goal, per-thread state with
episode ids, immediate next actions) and direct the user to run
/slate handoff [optional focus].`;

export function registerSlateMode(
	pi: ExtensionAPI,
	store: SlateStore,
	hooks: SlateHandoffHooks,
	getConfig: () => SlateConfig,
	getExtensions: () => WorkerExtensionSet,
): void {
	let savedTools: string[] | undefined;
	let uiCtx: ExtensionContext | undefined;

	const updateWidget = () => {
		if (!uiCtx?.hasUI) return;
		if (!store.orchestratorMode) {
			uiCtx.ui.setWidget("slate", undefined);
			uiCtx.ui.setStatus("slate", undefined);
			return;
		}
		// Orchestrator's own spend: summed over ALL entries (billed reality —
		// abandoned branches still cost money), plus spend carried across handoffs.
		const orchestratorCost = orchestratorCostUsd(uiCtx);
		const total = orchestratorCost + store.workerCostUsd + store.carriedCostUsd;
		// Keep the line short in the common no-handoff case.
		const carried = store.carriedCostUsd > 0 ? ` + carried $${store.carriedCostUsd.toFixed(4)}` : "";
		const costLine = `total $${total.toFixed(4)} (me $${orchestratorCost.toFixed(4)} + workers $${store.workerCostUsd.toFixed(4)}${carried})`;
		uiCtx.ui.setStatus("slate", `slate: orchestrator ⋅ ${costLine}`);
		const threads = [...store.threads.values()];
		const lines = [
			`slate ⋅ orchestrator mode ⋅ ${threads.length} thread${threads.length === 1 ? "" : "s"}`,
			`  ${costLine}`,
			...(store.paused ? ["  ⛔ PAUSED (context budget) — run /slate handoff"] : []),
			...threads.map(
				(t) =>
					`  ${t.status === "running" ? "⏳" : "·"} ${t.id} ${t.name} [${t.status}] ${t.episodeIds.length} episode${t.episodeIds.length === 1 ? "" : "s"}`,
			),
		];
		uiCtx.ui.setWidget("slate", lines);
	};

	const setMode = (on: boolean, persist: boolean) => {
		if (on && !store.orchestratorMode) {
			savedTools = pi.getActiveTools();
			pi.setActiveTools(ORCHESTRATOR_TOOLS);
		} else if (!on && store.orchestratorMode) {
			pi.setActiveTools(savedTools ?? [...pi.getAllTools().map((t) => t.name)]);
			savedTools = undefined;
		}
		if (!on) store.paused = false; // a pause is meaningless outside orchestrator mode
		store.orchestratorMode = on;
		if (persist) store.save();
		updateWidget();
	};

	// Widget refresh whenever slate state changes (dispatch start/end, new threads).
	store.onDidChange = updateWidget;

	pi.registerCommand("slate", {
		description: "Slate orchestrator mode: on | off | handoff [focus] | resume (no arg toggles)",
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const trimmed = args?.trim() ?? "";
			const [verb, ...rest] = trimmed.split(/\s+/);
			const arg = verb?.toLowerCase();
			if (arg === "handoff") {
				if (!store.orchestratorMode) {
					if (ctx.hasUI) ctx.ui.notify("slate: orchestrator mode is not active — nothing to hand off.", "warning");
					return;
				}
				await hooks.startHandoff(ctx, rest.join(" ") || undefined);
				return;
			}
			if (arg === "resume") {
				store.paused = false;
				store.save();
				if (ctx.hasUI) ctx.ui.notify("slate: pause cleared — dispatches allowed again.", "info");
				return;
			}
			const target = arg === "on" ? true : arg === "off" ? false : !store.orchestratorMode;
			setMode(target, true);
			if (ctx.hasUI) {
				ctx.ui.notify(
					target
						? "Slate orchestrator mode ON — tactical tools removed; delegate via the thread tool."
						: "Slate orchestrator mode OFF — full toolset restored.",
					"info",
				);
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!store.orchestratorMode) return;
		const config = getConfig();
		// Trust gate: project-derived prompt content (role docs, doctrine extra,
		// review-perspectives pointer) is injected only for trusted projects.
		// Config itself is already trust-gated at load (index.ts); checking again
		// here keeps the file reads safe regardless of where config came from.
		const trusted = ctx.isProjectTrusted();
		// Doc CONTENTS are re-read from disk on every agent start, so edits are
		// picked up live; the doc PATH LIST comes from config, which reloads
		// only on session_start (index.ts).
		const docs = trusted ? loadPromptDocs(ctx.cwd, config.orchestratorPromptDocs ?? []) : [];
		// Blocks carry no separators — prefix each here. When paused, the
		// addendum goes LAST so the pause directive is the final word in the
		// prompt, undiluted by the role guidelines.
		const parts = [
			buildDoctrine(ctx.cwd, config, trusted, getExtensions()),
			...loadDoctrineExtra(ctx.cwd, config, trusted).map((d) => `\n\n${d}`),
			...docs.map((d) => `\n\n${d}`),
		];
		if (store.paused) parts.push(PAUSED_ADDENDUM);
		return { systemPrompt: event.systemPrompt + parts.join("") };
	});

	// Refresh the orchestrator's own cost after each of its settled runs.
	pi.on("agent_settled", async (_event, ctx) => {
		uiCtx = ctx;
		updateWidget();
	});

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		// store.restore() (index.ts) and pending-handoff adoption (handoff.ts)
		// ran before this handler in registration order; re-apply the persisted
		// mode to the fresh runtime.
		//
		// Config-driven default: seed orchestrator mode ON for a genuinely FRESH
		// interactive session. Running AFTER restore and handoff adoption means
		// the seed can neither clobber persisted state nor trip the adoption
		// guard. "Fresh" = no message entries and no recorded slate state on the
		// branch: metadata-only entries (e.g., session naming) don't suppress the
		// seed, while resumed/forked real sessions and explicit /slate off
		// decisions stay untouched. Deliberately NOT saved — persisting would
		// lock the default into old sessions even after the config flag is later
		// turned off; the first real mutation persists it. The mode === "tui"
		// gate limits the seed to interactive terminal sessions — hasUI would not
		// do: it is also true in RPC mode, and scripted/automated runs
		// (print/JSON/RPC) must not silently lose tactical tools.
		if (!store.orchestratorMode && ctx.mode === "tui" && getConfig().orchestratorModeDefault === true) {
			const fresh = !ctx.sessionManager.getBranch().some((entry) => {
				// Loose cast like state.ts restore(): tolerate malformed/legacy entries.
				const e = entry as { type: string; customType?: string };
				return e.type === "message" || (e.type === "custom" && e.customType === "slate-state");
			});
			if (fresh) store.orchestratorMode = true;
		}
		if (store.orchestratorMode) {
			const active = pi.getActiveTools();
			const alreadyRestricted =
				active.length === ORCHESTRATOR_TOOLS.length && ORCHESTRATOR_TOOLS.every((t) => active.includes(t));
			// Never capture the restricted set as the thing to restore later —
			// that would make /slate off a no-op forever.
			if (!alreadyRestricted) savedTools = active;
			pi.setActiveTools(ORCHESTRATOR_TOOLS);
		}
		updateWidget();
	});
}
