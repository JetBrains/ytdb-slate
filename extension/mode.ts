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
import { ROUTER_OFF, type ModelRouterResolution, type RouterCandidate } from "./model-router.ts";
import {
	DESIGN_PRINCIPLES_DOC,
	PR_PUBLISHING_DOC,
	REVIEW_RULES_DOC,
	TRACK_WORKFLOW_DOC,
} from "./paths.ts";
import { loadPromptDocs } from "./prompt-docs.ts";
import { THINKING_LEVELS } from "./route.ts";
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

// Per-field caps for the doctrine interpolations (WB21): a tool name is an
// identifier, a unit label is a package spec or path, a description is a
// sentence. Caps keep a pathological 2000-char value from bloating every turn.
const DOCTRINE_NAME_MAX = 64;
const DOCTRINE_LABEL_MAX = 128;
const DOCTRINE_DESC_MAX = 140;

// ONE sanitizer for every extension-supplied string interpolated into the
// orchestrator doctrine — tool names, unit labels and descriptions (WB20/WB21/
// WB22). The doctrine is a numbered, indented plain-text block inside the
// system prompt, so a raw value must not be able to: (WB20) inject a newline
// that forges a new numbered directive; (WB21) run on for thousands of
// characters; or (WB22) carry backticks/markdown that break the block's
// structure or read as an instruction. Control characters and newlines collapse
// to spaces, backticks and markdown structural markers are dropped, remaining
// whitespace is collapsed, and the result is capped with an ellipsis.
function sanitizeForDoctrine(value: string, max: number): string {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f\u009b]/g, " ") // control chars + newlines → space (WB20)
		.replace(/[`*_~#>|]/g, " ") // code fences / markdown structure → space (WB22)
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}\u2026` : cleaned;
}

/**
 * Rules 1–10 are unconditional and carry literal numbers. Everything after them
 * is a CONDITIONAL tail rule whose number comes from its POSITION among the
 * tail rules that actually rendered (numberedTail below), so adding one cannot
 * silently renumber another. Worker extensions stay first in that order, which
 * keeps them at 11 whenever they render.
 */
const FIXED_DOCTRINE_RULES = 10;

/**
 * Number the conditional tail rules by position. Each builder is handed the
 * number it would take and returns "" when its feature is off; only a rendered
 * rule consumes a number, so a doctrine with no tail rules is byte-identical to
 * the pre-feature output and one with a single tail rule numbers it 11.
 */
function numberedTail(builders: readonly ((n: number) => string)[]): string {
	let last = FIXED_DOCTRINE_RULES;
	let out = "";
	for (const build of builders) {
		const rule = build(last + 1);
		if (rule === "") continue;
		last += 1;
		out += rule;
	}
	return out;
}

/**
 * Rule 11 (worker-extension awareness): appended ONLY when workers load extra
 * pi extensions. With no units it returns "" so the doctrine is byte-identical
 * to the pre-feature output (feature-off is unchanged). Phrased to match the
 * imperative register of rules 1–10 (WS20/WS21/WS22): it LEADS with the action
 * (delegate to a thread), states the constraint in the doctrine's own "cannot"
 * voice, and CLOSES with an instruction. The extension/tool listing in the
 * middle is data and renders verbatim.
 */
function buildWorkerExtensionsRule(extensions: WorkerExtensionSet, n: number): string {
	if (extensions.units.length === 0) return "";
	const lines = [
		`${n}. Delegate any action that needs one of these worker-loaded pi extensions to a`,
		"   thread; you cannot call their tools yourself:",
	];
	for (const unit of extensions.units) {
		lines.push(`   - ${sanitizeForDoctrine(unitLabel(unit), DOCTRINE_LABEL_MAX)}`);
		for (const tool of unit.tools) {
			lines.push(`     ${sanitizeForDoctrine(tool.name, DOCTRINE_NAME_MAX)}: ${sanitizeForDoctrine(tool.description, DOCTRINE_DESC_MAX)}`);
		}
	}
	lines.push(
		"   Assume every worker already has them — you need not pass them in a thread's",
		"   `tools` allowlist.",
	);
	return `\n${lines.join("\n")}`;
}

// ----------------------------------------------- the action-routing rule --

/**
 * ONE table cell. The routing rule below is a TABLE, and a table has exactly
 * two structural characters: the newline that ends a row and the "|" that ends
 * a cell. Those two are the only ones removed from a cell's text (with the rest
 * of the C0/C1 controls, which cannot render anyway) — everything else,
 * including the "≥" and "/" the profile table's own guidance strings use, is
 * carried verbatim. This is NOT sanitizeForDoctrine: see buildRoutingRule.
 */
function cell(value: unknown): string {
	return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\u009b|]+/g, " ").trim() : "";
}

/** A price, or "?" when the profile has no usable figure (the router warns about that separately). */
function money(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : "?";
}

/** A token count, compactly: 1050000 → "1.05M", 272000 → "272K". "?" when the registry reports none. */
function tokens(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "?";
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return String(Math.round(value));
}

/**
 * The tier cell: the tier, plus the two markers a reader must not be denied.
 * An UNSOURCED tier renders as "t?" rather than its number — the profile table
 * records such a tier as a cost class, never a ranking, so printing the ordinal
 * would present it as evidence it is not. "!" marks a non-preferred model; its
 * REASON is deliberately not rendered (see buildRoutingRule).
 */
function tierCell(candidate: RouterCandidate): string {
	const tier = candidate.tier;
	const sourced = candidate.tierUnsourced !== true && typeof tier === "number" && Number.isFinite(tier);
	return `${sourced ? `t${tier}` : "t?"}${candidate.nonPreferred ? "!" : ""}`;
}

/**
 * The levels this model can actually be dispatched to WITH evidence — exactly
 * the levels model-router's checkEffort answers "ok" for: on the model's ladder,
 * carrying a traced capability measurement, and not rejected outright by the
 * provider. Derived from the same fields as that predicate so the doctrine can
 * never advertise a level the dispatch guards would refuse, and ordered by pi's
 * own ascending vocabulary so the FIRST entry is the level an omitted `effort`
 * resolves to (route.ts's lowestMeasuredEffort).
 */
function measuredLevels(candidate: RouterCandidate): readonly string[] {
	const profile = (candidate.profile ?? {}) as { capabilityMeasuredAt?: unknown; apiRejectedLevels?: unknown };
	const has = (list: unknown, level: string) => Array.isArray(list) && list.includes(level);
	return THINKING_LEVELS.filter(
		(level) =>
			has(candidate.ladder, level) && has(profile.capabilityMeasuredAt, level) && !has(profile.apiRejectedLevels, level),
	);
}

/** That list as a cell: "none" when nothing is measured, "~" when the ladder itself is an assumed one. */
function measuredCell(candidate: RouterCandidate): string {
	const levels = measuredLevels(candidate);
	const assumed = (candidate.profile as { ladderAssumed?: unknown })?.ladderAssumed === true;
	return `${levels.length > 0 ? levels.join(",") : "none"}${assumed ? "~" : ""}`;
}

/**
 * The action-level routing rule — the SECOND tail rule, so 12 when worker
 * extensions render above it and 11 when they do not. Appended ONLY when the
 * session's router resolved a candidate list. Router off — `router.models`
 * empty, every entry dropped, or a resolution that failed — returns "" and the
 * doctrine is byte-identical to the pre-router output, the same feature-off
 * guarantee the worker-extension rule makes (invariant I2).
 *
 * RENDERED LIVE from the session's FROZEN resolution (model-router.ts), never
 * from a pasted table. The routable set is an intersection of `router.models`,
 * slate's profiles, pi's model registry and the credentials pi actually has, so
 * it differs per environment and per session; a static table would describe a
 * fiction, and the CONTEXT WINDOW column in particular is the registry's figure
 * (the authority for routing), not the profile's documentation-only one.
 *
 * NOT PASSED THROUGH sanitizeForDoctrine, and that is deliberate: that
 * sanitizer strips "|" (among other markdown structure), which would destroy
 * the table. It is safe to skip here because nothing interpolated below is
 * third-party text the way an extension's tool description is — every value is
 * either frozen repo data (model-profiles.ts, deep-frozen, reviewed at each
 * research refresh) or a model spec that already passed `isModelSpec`, which
 * rejects whitespace, control and bidi characters. What still IS enforced is
 * the table's own grammar: `cell()` above removes the newline and the "|" that
 * carry structure, so no data value can forge a row, a column or a numbered
 * directive. Do not "fix" this by wrapping the rule in sanitizeForDoctrine.
 *
 * TWO things are never rendered. A profile's `nonPreferred` REASON string and
 * anything else carrying a research trace tag ("[O2]", "[G1a]", …) point at a
 * `research/` directory this package does not publish, so a non-preferred model
 * is marked "!" and explained by its own guidance columns instead. `routeFor`
 * and `avoidFor` were audited clean and are the source of those columns.
 */
function buildRoutingRule(router: ModelRouterResolution, allowUnmeasuredEffort: boolean, n: number): string {
	if (router?.on !== true) return "";
	const candidates = (Array.isArray(router.candidates) ? router.candidates : []).filter(
		(c): c is RouterCandidate => typeof c?.spec === "string" && c.spec !== "",
	);
	if (candidates.length === 0) return "";
	const rows = candidates.map(
		(c) =>
			`   ${c.spec}|${money(c.inUsdPerMTok)}/${money(c.outUsdPerMTok)}|${tokens(c.contextWindow)}|${tierCell(c)}|` +
			`${measuredCell(c)}|${cell(c.profile?.routeFor)}|${cell(c.profile?.avoidFor)}`,
	);
	// Only the markers that actually appear are explained — an unused legend
	// clause is pure cost in a block loaded on every turn.
	const legend = [
		candidates.some((c) => c.nonPreferred) ? "! = never a default pick" : "",
		candidates.some((c) => c.tierUnsourced === true) ? "t? = cost class, not a rank" : "",
		candidates.some((c) => (c.profile as { ladderAssumed?: unknown })?.ladderAssumed === true) ? "~ = assumed ladder" : "",
		// The one case the "omit `effort`" sentence below cannot answer from the
		// table: with no measured level there is nothing to derive, so pi's own
		// level stands (route.ts's lowestMeasuredEffort returns undefined).
		candidates.some((c) => measuredLevels(c).length === 0) ? "none = pi's own level applies" : "",
	]
		.filter((clause) => clause !== "")
		.join("; ");
	// The base a NEW thread starts on (model-router D48). `cheapest` is the
	// resolver's own answer; the first candidate is the floor for a fabricated
	// resolution that carries candidates but no `cheapest`, and the parenthetical
	// disappears entirely rather than naming an empty model.
	const base = typeof router.cheapest === "string" && router.cheapest !== "" ? router.cheapest : (candidates[0]?.spec ?? "");
	const newThreadBase = base === "" ? "" : ` (${base} for a new thread)`;
	// The evidence-gap policy is the ONE routing behaviour a project can invert,
	// so it is stated as it is configured rather than as both possibilities.
	const gap = allowUnmeasuredEffort ? "runs, marked unmeasured" : "is refused too (router.allowUnmeasuredEffort is false)";
	return `
${n}. Route every action to the cheapest model and effort that clears it. Routable
   this session (spec|$in/$out per Mtok|ctx|tier|measured|route for|avoid):
${rows.join("\n")}${legend === "" ? "" : `\n   ${legend}.`}
   \`model\` and \`effort\` route THAT action only. Omit \`model\` for the thread's
   base${newThreadBase}; omit \`effort\` for its base
   level, else the FIRST measured level of the model that runs — never a higher
   one, so name the level harder work needs. Off-ladder and provider-rejected
   levels are tool errors; an unmeasured one ${gap}.
   Prices are base rates: some models bill a long-context multiplier above a
   token threshold, and a mid-thread model switch drops the prompt cache.
   DOCTRINE ONLY, not code-enforced: keep review and gate actions on measured
   levels, and honour a REFUSE in an avoid cell.`;
}

function buildDoctrine(
	cwd: string,
	config: SlateConfig,
	trusted: boolean,
	extensions: WorkerExtensionSet,
	router: ModelRouterResolution,
): string {
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
   context.${numberedTail([
		(n) => buildWorkerExtensionsRule(extensions, n),
		(n) => buildRoutingRule(router, config.router?.allowUnmeasuredEffort !== false, n),
	])}`;
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
	// OPTIONAL, defaulted to the shared off resolution: a caller that predates
	// the router (and the resolver checks' doctrine helper) keeps working and
	// gets exactly the pre-router doctrine. Read through a live indirection like
	// getExtensions, because the resolution always belongs to the CURRENT
	// session; it is memoized on the other side, so the doctrine and the dispatch
	// guards describe one and the same frozen candidate list.
	getRouter: () => ModelRouterResolution = () => ROUTER_OFF,
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
			buildDoctrine(ctx.cwd, config, trusted, getExtensions(), getRouter()),
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
