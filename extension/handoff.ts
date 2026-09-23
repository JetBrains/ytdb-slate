/**
 * Auto-pause + handoff: context-budget discipline for the orchestrator.
 *
 * Monitoring: after every turn, when orchestrator mode is on and context
 * usage crosses the absolute token budget (contextBudget; built-in defaults
 * 256k tokens, 400k for anthropic/* models, clamped so the pause always
 * lands with brief-writing room below pi's own compaction point), the store
 * is paused — orchestrator worker dispatches remain available, while new user
 * prompts are refused by the input hook — and the orchestrator is steered to
 * prepare a handoff brief for the user. Threshold auto-compactions are intercepted the same way
 * (session_before_compact → pause + cancel); once paused they pass through
 * as the escape valve. The DEPRECATED pauseThresholdPercent keeps its exact
 * legacy percent behavior (compaction untouched) when set WITHOUT
 * contextBudget.
 *
 * /slate handoff [focus] → startHandoff(): captures the orchestrator's last
 * assistant message as the brief, appends a hidden `slate-handoff` custom
 * entry to the successor during newSession setup, and opens that session.
 *
 * Adoption: session replacement tears down this extension instance. The new
 * instance reads the successor-bound entry only when no `slate-state` entry
 * exists on its current branch. A fork or clone has a different session ID.
 * Then it restores the captured model/thinking level — the fresh session does
 * not inherit them: startup CLI flags (-m/--thinking) are re-applied to the
 * replacement runtime, enabledModels scoping picks its first entry, and a
 * parent resumed with a non-default session-file model falls back to the
 * settings default. A model restore that SUCCEEDS also re-seeds slate's
 * base-model tracker (base-model.ts): a handoff adoption is a deliberate move of
 * the orchestrator's base model, unlike a failover fallback.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { currentModelSpec, readLiveEffort, type BaseModelTracker } from "./base-model.ts";
import { SAVED_DEFAULT_RESOURCE_KEY } from "./failover.ts";
import type { LogicalRuntime } from "./logical-model-runtime.ts";
import { withGlobalModelDefaultRestored } from "./model-default.ts";
import { sanitizeForNotify } from "./notify.ts";
import {
	orchestratorCostUsd,
	SLATE_STATE_FORMAT,
	type ContextBudgetObject,
	type ContextBudgetOverride,
	type SlateConfig,
	type SlateSnapshot,
	type SlateStore,
} from "./state.ts";

/** Legacy percent mode only (DEPRECATED pauseThresholdPercent without contextBudget). */
const DEFAULT_PAUSE_THRESHOLD_PERCENT = 40;
/** Budget-mode default for models without a configured or built-in override. */
const DEFAULT_CONTEXT_BUDGET_TOKENS = 256_000;
/** Built-in override: anthropic/* models get a larger default budget. */
const ANTHROPIC_DEFAULT_BUDGET_TOKENS = 400_000;
const ANTHROPIC_MODEL_RE = /^anthropic\/.*/;
/**
 * Head-room subtracted (together with pi's compaction reserveTokens) from the
 * context window when clamping the budget: the pause must land with enough
 * room left for the orchestrator to WRITE the handoff brief before pi's own
 * compaction point (contextWindow − reserveTokens).
 */
const BRIEF_HEADROOM_TOKENS = 32_768;
/** Used when the merged settings cannot be read (mirrors pi's own default). */
const FALLBACK_RESERVE_TOKENS = 16_384;
const BRIEF_MAX_CHARS = 6000;

// pi-coding-agent does not re-export ThinkingLevel (it lives in the transitive
// pi-agent-core package, which is not one of our peer deps) — derive it.
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** Stable custom session entry: `slate-handoff`. Copied entries retain this successor ID. */
interface SessionHandoff {
	sessionId: string;
	// No model fields when the parent session had no model.
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	logicalModel?: string;
	snapshot: SlateSnapshot;
}

export interface SlateHandoffHooks {
	startHandoff(ctx: ExtensionCommandContext, focus?: string): Promise<void>;
	effectiveContextBudget(contextWindow: number, ctx: ExtensionContext): number | undefined;
}

// Console-first reporting for the model-adoption block below, and for FAILURES
// ONLY: the console line is unconditional, so the failure surfaces in headless
// runs and at teardown too — the has-UI branch is exactly the one that vanishes
// there — and the UI notification is the extra. Informational notices (the
// "handoff state restored" line, the pause notices) keep their plain has-UI
// gate, since an unconditional stderr write scribbles pi-tui's differentially
// rendered frame. ctx.hasUI is a getter that THROWS on a stale context, so it
// is guarded: an unguarded check would be a crash, not a test.
function reportFailure(ctx: ExtensionContext, message: string): void {
	console.warn(message);
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
	} catch {
		/* stale ctx — the console line above stands */
	}
}

/**
 * Validate the raw `contextBudget` config value — eagerly, at session_start,
 * for the same reason modelFailover is (failover.ts): a malformed budget
 * would otherwise fail silently exactly when the auto-pause was supposed to
 * save the orchestrator's context. Normalizes a bare number to { tokens }.
 * Returns undefined for anything unusable — an INVALID contextBudget never
 * disables a configured pauseThresholdPercent. `{}` is valid: an explicit
 * opt-in to the built-in budget defaults.
 */
export function sanitizeContextBudget(raw: unknown, warn: (msg: string) => void): ContextBudgetObject | undefined {
	if (raw === undefined) return undefined;
	const isBudgetTokens = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
	if (typeof raw === "number") {
		if (isBudgetTokens(raw)) return { tokens: raw };
		warn(`slate: ignoring contextBudget — expected a positive integer token count, got ${raw}`);
		return undefined;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warn('slate: ignoring contextBudget — expected a token count or { "tokens": N, "overrides": [...] }');
		return undefined;
	}
	const obj = raw as { tokens?: unknown; overrides?: unknown };
	const result: ContextBudgetObject = {};
	// CQ1: a typo like {"token": 50000} would otherwise silently fall back to
	// the built-in defaults — surface unknown keys (they are user-edited
	// slate.json content headed for ctx.ui.notify, so sanitize for display).
	const unknownKeys = Object.keys(obj).filter((k) => k !== "tokens" && k !== "overrides");
	if (unknownKeys.length > 0) {
		warn(
			`slate: ignoring unknown contextBudget key(s): ${sanitizeForNotify(unknownKeys.join(", "))} (known: "tokens", "overrides")`,
		);
	}
	if (obj.tokens !== undefined) {
		if (isBudgetTokens(obj.tokens)) result.tokens = obj.tokens;
		// Dropping just the scalar keeps the object valid — the user still opted
		// into budget mode, so built-in defaults apply rather than legacy percent.
		// BG1: the value reaches ctx.ui.notify — sanitize like the sibling
		// overrides path (a crafted string could inject ANSI/CSI codes).
		else {
			warn(
				`slate: dropping contextBudget.tokens — expected a positive integer, got ${sanitizeForNotify(
					JSON.stringify(obj.tokens),
				)}`,
			);
		}
	}
	if (obj.overrides !== undefined) {
		if (!Array.isArray(obj.overrides)) {
			warn("slate: dropping contextBudget.overrides — expected an array");
		} else {
			const kept: ContextBudgetOverride[] = [];
			const dropped: string[] = [];
			for (const entry of obj.overrides as unknown[]) {
				const o = entry as { match?: unknown; tokens?: unknown } | null;
				let ok = typeof o?.match === "string" && o.match !== "" && isBudgetTokens(o.tokens);
				if (ok) {
					// Compile the exact ANCHORED form resolution uses at match time —
					// validating the bare pattern would not prove the wrapped one compiles.
					try {
						new RegExp(`^(?:${o?.match as string})$`);
					} catch {
						ok = false;
					}
				}
				if (ok) kept.push({ match: o?.match as string, tokens: o?.tokens as number });
				// Entries come from user-edited slate.json and reach ctx.ui.notify —
				// strip control/ANSI codes before display (same rationale as
				// failover.ts's CQ1 comment; this round's BG1 fixed the sibling
				// tokens path above to match).
				else dropped.push(sanitizeForNotify(JSON.stringify(entry)));
			}
			if (dropped.length > 0) {
				warn(
					`slate: dropped invalid contextBudget.overrides entries (need a regex string "match" + positive integer "tokens"):\n` +
						dropped.join("\n"),
				);
			}
			if (kept.length > 0) result.overrides = kept;
		}
	}
	return result;
}

/**
 * BUDGET mode is active unless the config is percent-only: LEGACY iff
 * pauseThresholdPercent is set AND no valid contextBudget survived
 * sanitization (both fields pass through session_start's eager sanitize
 * before any config reaches this module via getConfig()).
 */
function budgetModeActive(config: SlateConfig): boolean {
	return config.contextBudget !== undefined || config.pauseThresholdPercent === undefined;
}

/**
 * Resolve the budget for one "provider/id" spec. Lattice: first matching
 * user override → user scalar → built-in anthropic rule → global default.
 * Runs against the LIVE model on EVERY check — failover, /model, and handoff
 * restore can all swap models mid-session, so the result is never cached.
 */
function resolveBudgetTokens(budget: ContextBudgetObject | undefined, modelSpec: string): number {
	for (const o of budget?.overrides ?? []) {
		// The sanitizer verified this exact anchored form compiles.
		if (new RegExp(`^(?:${o.match})$`).test(modelSpec)) return o.tokens;
	}
	if (budget?.tokens !== undefined) return budget.tokens;
	if (ANTHROPIC_MODEL_RE.test(modelSpec)) return ANTHROPIC_DEFAULT_BUDGET_TOKENS;
	return DEFAULT_CONTEXT_BUDGET_TOKENS;
}

/** Apply Slate's context-window clamp to one configured budget. */
export function effectiveContextBudgetTokens(configured: number, contextWindow: number, reserveTokens: number): number {
	return Math.min(
		configured,
		Math.max(contextWindow - reserveTokens - BRIEF_HEADROOM_TOKENS, Math.ceil(contextWindow / 2)),
	);
}

/** Resolve one model's configured budget and apply the shared window clamp. */
export function effectiveContextBudgetForModel(
	budget: ContextBudgetObject | undefined,
	modelSpec: string,
	contextWindow: number,
	reserveTokens: number,
): number {
	return effectiveContextBudgetTokens(resolveBudgetTokens(budget, modelSpec), contextWindow, reserveTokens);
}

/** Last assistant message text on the current branch (the handoff brief). */
function lastAssistantText(ctx: ExtensionCommandContext): string {
	let text = "";
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type: string;
			message?: { role?: string; content?: string | Array<{ type: string; text?: string }> };
		};
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const content = e.message.content;
		// Entries come from JSON on disk; content may not match the declared
		// shape. Skip anything that is neither string nor block array.
		if (typeof content !== "string" && !Array.isArray(content)) continue;
		const t = (typeof content === "string"
			? content
			: content
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n")
		).trim();
		if (t) text = t;
	}
	return text.length > BRIEF_MAX_CHARS ? `${text.slice(0, BRIEF_MAX_CHARS)}\n[... brief truncated]` : text;
}

// Trust gate: the project-supplied kickoff template is a project-derived
// read injected into the fresh session's first prompt, so it is honored
// only for trusted projects; untrusted → built-in kickoff text.
function buildKickoff(cwd: string, trusted: boolean, brief: string, focus?: string): string {
	const template = join(cwd, CONFIG_DIR_NAME, "slate-handoff.md");
	let base: string | undefined;
	if (trusted) {
		// existsSync alone is not enough: the path may be a directory or
		// unreadable. Fall back to the default kickoff text.
		try {
			if (existsSync(template)) base = readFileSync(template, "utf8").trim();
		} catch {
			/* unreadable template → default kickoff */
		}
	}
	// Only the project-supplied template is trust-gated. The session entry
	// follows the same validation as saved state, including in untrusted projects.
	if (!base) {
		base = [
			"Slate orchestrator handoff (context hygiene; the previous orchestrator exceeded its context budget).",
			"Orchestrator mode and all worker threads/episodes from the previous session are restored:",
			"use `threads` to list them and `episode` to fetch details. Continue the work.",
		].join("\n");
	}
	const parts = [base];
	if (brief) parts.push("", "## Handoff brief from the previous orchestrator", "", brief);
	if (focus) parts.push("", `Immediate focus: ${focus}`);
	return parts.join("\n");
}

export function registerSlateHandoff(
	pi: ExtensionAPI,
	store: SlateStore,
	getConfig: () => SlateConfig,
	getBaseModel: () => BaseModelTracker,
	getRuntime: () => Readonly<LogicalRuntime> | undefined = () => undefined,
): SlateHandoffHooks {
	// Snapshot settings once: creation takes a disk lock on this per-turn path.
	// Resolve the reserve against the LIVE model on every calculation instead
	// of caching one model's value. Mid-session file edits remain unobserved.
	// READ-ONLY: never call a setter on this file-backed settings reader.
	let cachedSettings: SettingsManager | null | undefined;
	const reserveTokens = (ctx: ExtensionContext): number => {
		if (cachedSettings === undefined) {
			try {
				cachedSettings = SettingsManager.create(ctx.cwd, getAgentDir(), {
					projectTrusted: ctx.isProjectTrusted(),
				});
			} catch {
				cachedSettings = null;
			}
		}
		try {
			return cachedSettings?.getCompactionReserveTokens(ctx.model) ?? FALLBACK_RESERVE_TOKENS;
		} catch {
			return FALLBACK_RESERVE_TOKENS;
		}
	};

	const effectiveContextBudget = (contextWindow: number, ctx: ExtensionContext): number | undefined => {
		if (!ctx.model) return undefined;
		const budget = getConfig().contextBudget;
		return effectiveContextBudgetForModel(
			typeof budget === "number" ? { tokens: budget } : budget,
			`${ctx.model.provider}/${ctx.model.id}`,
			contextWindow,
			reserveTokens(ctx),
		);
	};

	/** Handoff instructions shared by both pause sites (turn check + compaction intercept). */
	const pauseInstructions = (headline: string) =>
		[
			headline,
			"Do not start other user work. Save the project state in the research log through exactly one worker at a time.",
			"Wait for that worker result and verify that it reports success before writing the final HANDOFF BRIEF.",
			"If preparation fails or is incomplete, report that fact instead of claiming that the state was saved.",
			"Reply with a concise HANDOFF BRIEF — overall goal, per-thread state with episode ids, immediate next actions.",
			"Then instruct the user to run /slate handoff [optional focus] to continue in a fresh session where all threads and episodes are restored automatically.",
			`Alternatively, start a new pi session manually, run /slate on, and have the new orchestrator read the episode files under ${CONFIG_DIR_NAME}/slate/<runtime folder>/episodes/ (or the legacy ${CONFIG_DIR_NAME}/slate/episodes/).`,
		].join("\n");

	const checkBudget = (ctx: ExtensionContext) => {
		if (!store.orchestratorMode || store.paused) return;
		const config = getConfig();
		let notifyText: string;
		let headline: string;
		if (!budgetModeActive(config)) {
			// LEGACY percent mode (DEPRECATED pauseThresholdPercent, no contextBudget).
			const percent = ctx.getContextUsage()?.percent;
			if (percent == null) return;
			// slate.json is user-edited: accept only finite (0, 100] thresholds.
			const configured = config.pauseThresholdPercent;
			const threshold =
				typeof configured === "number" && Number.isFinite(configured) && configured > 0 && configured <= 100
					? configured
					: DEFAULT_PAUSE_THRESHOLD_PERCENT;
			if (percent < threshold) return;
			const pct = Math.round(percent);
			notifyText = `slate: context at ${pct}% (budget ${threshold}%) — paused. Run /slate handoff [focus] to continue in a fresh session.`;
			headline = `[slate] Context is at ${pct}% — over the ${threshold}% budget. Slate auto-paused: user prompts are refused, and state-save workers remain available.`;
		} else {
			// BUDGET mode: absolute token budget resolved against the LIVE model.
			const usage = ctx.getContextUsage();
			// tokens is null right after compaction, before the next LLM response.
			if (usage?.tokens == null) return;
			if (!ctx.model) return;
			// sanitizeContextBudget (session_start) normalized any bare number to
			// { tokens }; the inline conversion is belt-and-braces for the type.
			const budget = config.contextBudget;
			const configured = resolveBudgetTokens(
				typeof budget === "number" ? { tokens: budget } : budget,
				`${ctx.model.provider}/${ctx.model.id}`,
			);
			// Use the same effective budget exposed to context-cadenced features.
			const effective = effectiveContextBudgetForModel(
				typeof budget === "number" ? { tokens: budget } : budget,
				`${ctx.model.provider}/${ctx.model.id}`,
				usage.contextWindow,
				reserveTokens(ctx),
			);
			if (usage.tokens < effective) return;
			const used = usage.tokens.toLocaleString("en-US");
			const cap = effective.toLocaleString("en-US");
			// CQ2: when the clamp engaged, the effective number alone is
			// untraceable to the configured budget — name both, so "budget
			// 150,848" against a configured 500,000 explains itself. Phrasing is
			// unchanged when no clamping occurred.
			const clampNote =
				effective < configured
					? ` (configured ${configured.toLocaleString("en-US")}, clamped for this model's context window)`
					: "";
			notifyText = `slate: context at ${used} tokens (budget ${cap}${clampNote}) — paused. Run /slate handoff [focus] to continue in a fresh session.`;
			headline = `[slate] Context is at ${used} tokens — over the ${cap}-token budget${clampNote}. Slate auto-paused: user prompts are refused, and state-save workers remain available.`;
		}

		store.paused = true;
		store.save();
		if (ctx.hasUI) ctx.ui.notify(notifyText, "warning");
		pi.sendMessage(
			{ customType: "slate-pause", content: pauseInstructions(headline), display: true },
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	pi.on("turn_end", async (_event, ctx) => checkBudget(ctx));
	pi.on("agent_end", async (_event, ctx) => checkBudget(ctx));

	// Threshold auto-compaction intercept: compaction pressure on an unpaused
	// orchestrator means the budget failed to fire first (mis-sized override,
	// low compaction threshold, …) — the right response is still pause +
	// handoff, not a silent compaction that would shred the weave the episodes
	// encode. BUDGET mode only: percent-only configs keep today's behavior
	// end-to-end, compaction included. Manual /compact and overflow recovery
	// always pass through (the user asked / pi is un-wedging a stuck turn).
	pi.on("session_before_compact", async (event, ctx) => {
		// !paused is the escape valve: once paused, later threshold compactions
		// run normally — context that keeps growing must not wedge the session.
		if (!store.orchestratorMode || store.paused) return;
		if (!budgetModeActive(getConfig())) return;
		if (event.reason !== "threshold") return;
		store.paused = true;
		store.save();
		if (ctx.hasUI) {
			ctx.ui.notify(
				"slate: auto-compaction intercepted — paused instead. Run /slate handoff [focus] to continue in a fresh session.",
				"warning",
			);
		}
		// deliverAs "steer" WITHOUT triggerTurn (CN1/CN2/CN3) — traced against
		// BOTH pi call sites of session_before_compact (agent-session.js):
		//  - post-run site (_handlePostAgentRun → _checkCompaction), streaming:
		//    the steer queues on the agent; _handlePostAgentRun then sees
		//    hasQueuedMessages() and continues the run, so the model writes the
		//    handoff brief THIS settle — before the escape-valve compaction can
		//    fire (CN2) and before a user steer slips in uninstructed (CN3).
		//  - idle pre-prompt site (prompt() preflight), not streaming: the
		//    message is appended directly to state/session and rides into the
		//    imminent turn — no turn starts. triggerTurn stays OFF: a
		//    triggering send at this site is what would start a nested agent
		//    run (the original hazard was triggerTurn specifically).
		// Unlike "nextTurn" (an unretractable _pendingNextTurnMessages queue
		// that survives /slate resume — CN1), a steer lands in the transcript
		// at pause time; the disregard clause below is defense in depth.
		pi.sendMessage(
			{
				customType: "slate-pause",
				content: `${pauseInstructions(
					"[slate] pi hit its auto-compaction threshold; slate cancelled the compaction and auto-paused instead: user prompts are refused, and state-save workers remain available. (While paused, a repeat compaction passes through as the escape valve.)",
				)}\n(If slate has since been resumed or unpaused, disregard this message.)`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
		return { cancel: true };
	});

	// Registered AFTER restore and BEFORE mode. Any saved state, even a malformed
	// entry, wins over the handoff on every later restore.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const branch = ctx.sessionManager.getBranch();
			if (branch.some((entry) => entry.type === "custom" && entry.customType === "slate-state")) return;
			const sessionId = ctx.sessionManager.getSessionId();
			const entry = [...branch].reverse().find((item) =>
				item.type === "custom" && item.customType === "slate-handoff" &&
				(item.data as { sessionId?: unknown } | null)?.sessionId === sessionId,
			);
			if (!entry || entry.type !== "custom") return;
			const pending = entry.data as SessionHandoff;
			if (!pending.snapshot || typeof pending.snapshot !== "object" || pending.snapshot.format !== SLATE_STATE_FORMAT) {
				reportFailure(ctx, "slate: invalid successor handoff state — no state adopted. Reload can retry after repair.");
				return;
			}
			store.adoptSnapshot(pending.snapshot, ctx);
			store.writingReminder.forceNext = true;
			store.writingReminder.adoptedThisSessionStart = true;
			// State is durable before model adoption. Keep the replacement paused
			// until an exact allowed logical identity and fixed effort are live.
			store.paused = true;
			try {
				store.save();
			} catch (error) {
				reportFailure(
					ctx,
					`slate: could not persist restored handoff state — ${sanitizeForNotify(
						error instanceof Error ? error.message : String(error),
					)}. Handoff remains paused. Reload can retry the session entry.`,
				);
				return;
			}
			getRuntime()?.resetPreferences();
			if (ctx.hasUI) {
				const t = store.threads.size;
				const e = store.episodes.size;
				ctx.ui.notify(
					`slate: handoff state restored (${t} thread${t === 1 ? "" : "s"}, ${e} episode${e === 1 ? "" : "s"}).`,
					"info",
				);
			}
			// Restore the parent's live model + thinking level. The fresh session
			// does not inherit them: startup CLI flags (-m/--thinking) are
			// re-applied to the replacement runtime, enabledModels scoping picks
			// its first entry, and a parent resumed with a non-default
			// session-file model falls back to the settings default. This sits
			// AFTER the adoption commit above, in its own try/catch, because
			// pi.setModel can THROW on a failed live auth check despite its
			// Promise<boolean> contract — a restore failure must never unwind a
			// committed adoption.
			// The session entry can contain edited JSON: honor the captured model only as an
			// object with non-empty string provider/id — a malformed {"model":{}}
			// must not count as "already live" via undefined === undefined.
			const spec = pending.model;
			if (
				typeof spec === "object" &&
				spec !== null &&
				typeof spec.provider === "string" &&
				spec.provider !== "" &&
				typeof spec.id === "string" &&
				spec.id !== ""
			) {
				const { provider, id } = spec;
				const label = sanitizeForNotify(`${provider}/${id}`);
				const runtime = getRuntime();
				const mapping = runtime?.reverseMap({ provider, model: id }, pending.logicalModel);
				if (!runtime || !mapping || mapping.kind !== "one") {
					reportFailure(ctx, `slate: handoff state is restored but model ${label} is not one unambiguous allowed logical choice. Handoff remains paused; choose a logical model.`);
					return;
				}
				const requiredEffort = runtime.effortFor(mapping.logicalModel);
				if (!requiredEffort) {
					reportFailure(ctx, `slate: handoff state is restored but ${label} has no allowed fixed effort. Handoff remains paused; choose a logical model.`);
					return;
				}
				const owner = runtime.ownership.acquire(`slate:handoff:${sessionId}`, SAVED_DEFAULT_RESOURCE_KEY);
				if (owner.kind === "busy") {
					reportFailure(ctx, `slate: handoff model adoption is busy on ${owner.resource}. No second model switch was started. Handoff remains paused; retry later.`);
					return;
				}
				let adopted = false;
				try {
				// Keep the whole adoption block inside the compatibility restore guard.
				// Pi 0.85.1 extension setters are session-only, so this is normally a
				// zero-write no-op. The guard still covers older or explicitly persistent
				// host behavior, including a thinking-level-only write.
				await withGlobalModelDefaultRestored(
					pi,
					ctx,
					getConfig(),
					{ provider, id },
					async () => {
						// True once a Pi setter has been called. Pi 0.85.1 does not persist
						// this call, but the compatibility guard must conservatively cover hosts
						// where the same call can write a default.
						let calledSetter = false;
						try {
							// Equality guard: avoid a recorded session switch when the fresh
							// session already resolved to the captured physical model.
							let restored = ctx.model?.provider === provider && ctx.model?.id === id;
							if (!restored) {
								const model = ctx.modelRegistry.find(provider, id);
								if (model) {
									calledSetter = true;
									// Run the switch THROUGH the tracker: ownSwitch declares the (from, to)
									// pair immediately before the setter and retires the declaration when
									// the setter SETTLES, so the model_select event pi emits from inside it
									// is recognised as slate's own for exactly the switch's own duration and
									// no longer (base-model.ts). It returns the setter's value and re-throws
									// its error unchanged. The deliberate move of the base is the adopt()
									// below, which happens only once the restore is confirmed.
									restored = await getBaseModel().ownSwitch(currentModelSpec(ctx), `${provider}/${id}`, () =>
										pi.setModel(model),
									);
								}
							}
							if (restored) {
								try {
									// Keep the no-op path exact. When both the physical route and
									// its fixed effort are already live, no Pi setter can persist a
									// default, so the compatibility guard must skip its post-read.
									let actualEffort = readLiveEffort(pi);
									if (actualEffort !== requiredEffort) {
										calledSetter = true;
										pi.setThinkingLevel(requiredEffort);
										actualEffort = readLiveEffort(pi);
									}
									if (actualEffort !== requiredEffort) {
										reportFailure(ctx, `slate: restored model ${label}, but Pi clamped effort to ${sanitizeForNotify(String(actualEffort))}; policy requires ${requiredEffort}. Handoff remains paused.`);
									} else if (runtime.ownership.isCurrentLifecycle()) {
										getBaseModel().adopt(`${provider}/${id}`, actualEffort);
										getBaseModel().adoptLogicalIdentity(mapping.logicalModel);
										adopted = true;
									}
								} catch (error) {
									reportFailure(ctx, `slate: restored model ${label}, but could not apply fixed effort ${requiredEffort} — ${sanitizeForNotify(error instanceof Error ? error.message : String(error))}. Handoff remains paused.`);
								}
							} else {
								reportFailure(
									ctx,
									`slate: could not restore model ${label} (unknown or no auth) — keeping the session default.`,
								);
							}
						} catch (error) {
							// A compatibility host can throw after a persistent write. Treat the
							// attempted setter as potentially written in the safe direction.
							calledSetter = true;
							reportFailure(
								ctx,
								`slate: could not restore model ${label} — ${sanitizeForNotify(
									error instanceof Error ? error.message : String(error),
								)}. Keeping the session default.`,
							);
						}
						return calledSetter;
					},
					// No setter was called ⇒ pi cannot have written anything ⇒ skip the
					// wrapper's post-switch reads, retries and reporting entirely.
					(calledSetter) => calledSetter,
				);
				} finally {
					owner.lease.release();
				}
				if (adopted && runtime.ownership.isCurrentLifecycle()) {
					store.paused = false;
					try {
						store.save();
					} catch (error) {
						store.paused = true;
						reportFailure(
							ctx,
							`slate: could not persist the unpaused handoff state — ${sanitizeForNotify(
								error instanceof Error ? error.message : String(error),
							)}. Handoff remains paused.`,
						);
					}
				}
			} else {
				reportFailure(ctx, "slate: handoff state is restored without a usable model identity. Handoff remains paused; choose a logical model.");
			}
		} catch (error) {
			reportFailure(ctx, `slate: could not adopt successor handoff — ${sanitizeForNotify(error instanceof Error ? error.message : String(error))}`);
		}
	});

	const startHandoff = async (ctx: ExtensionCommandContext, focus?: string): Promise<void> => {
		await ctx.waitForIdle();

		const brief = lastAssistantText(ctx);
		const parentSession = ctx.sessionManager.getSessionFile();
		// ctx.model can be undefined (no-model session): capture neither field
		// then — a thinking level is meaningless without a model to clamp it
		// against, and adoption skips the whole restore when model is absent.
		const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		const handoff = {
			model,
			thinkingLevel: model ? pi.getThinkingLevel() : undefined,
			logicalModel: model ? getBaseModel().currentLogicalIdentity() : undefined,
			// The successor starts paused until model adoption confirms an allowed
			// logical identity and its fixed effort.
			snapshot: {
				...store.snapshot(),
				paused: true,
				orchestratorMode: true,
				// The successor's own branch sum starts at zero, so bank the parent's
				// billed orchestrator spend (plus anything already carried) — the
				// displayed total must survive repeated handoffs.
				carriedCostUsd: store.carriedCostUsd + orchestratorCostUsd(ctx),
			},
		};
		const kickoff = buildKickoff(ctx.cwd, ctx.isProjectTrusted(), brief, focus);
		try {
			const { cancelled } = await ctx.newSession({
				...(parentSession ? { parentSession } : {}),
				setup: async (successor) => {
					const entry: SessionHandoff = { ...handoff, sessionId: successor.getSessionId() };
					successor.appendCustomEntry("slate-handoff", entry as unknown as Record<string, unknown>);
				},
				withSession: async (fresh) => {
					await fresh.sendUserMessage(kickoff);
				},
			});
			if (cancelled) {
				store.paused = false;
				store.save();
				if (ctx.hasUI) ctx.ui.notify("slate: handoff cancelled — pause cleared.", "warning");
			}
		} catch (error) {
			// Best-effort: if the replacement partially happened, the old pi/ctx
			// are stale and these calls themselves throw.
			try {
				store.paused = false;
				store.save();
				if (ctx.hasUI) {
					ctx.ui.notify(
						`slate: handoff failed — ${error instanceof Error ? error.message : String(error)}. Pause cleared.`,
						"error",
					);
				}
			} catch {
				/* stale pi/ctx after partial replacement */
			}
			throw error;
		}
	};

	return { startHandoff, effectiveContextBudget };
}
