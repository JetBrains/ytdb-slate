/**
 * Auto-pause + handoff: context-budget discipline for the orchestrator.
 *
 * Monitoring: after every turn, when orchestrator mode is on and context
 * usage crosses the absolute token budget (contextBudget; built-in defaults
 * 256k tokens, 400k for anthropic/* models, clamped so the pause always
 * lands with brief-writing room below pi's own compaction point), the store
 * is paused — the thread tool then rejects NEW dispatches (in-flight ones
 * finish) — and the orchestrator is steered to produce a handoff brief for
 * the user. Threshold auto-compactions are intercepted the same way
 * (session_before_compact → pause + cancel); once paused they pass through
 * as the escape valve. The DEPRECATED pauseThresholdPercent keeps its exact
 * legacy percent behavior (compaction untouched) when set WITHOUT
 * contextBudget.
 *
 * /slate handoff [focus] → startHandoff(): saves the records, captures the
 * orchestrator's last assistant message as the brief, and atomically writes the
 * author-addressed corpus handoff record. Adoption is explicit. Session startup
 * never reads, claims, consumes, or adopts a handoff record.
 *
 * /slate adopt <name> → adoptHandoff(): the receiving Pi session CONTINUES the
 * same Slate session. The handoff record names the external namespace, and the
 * records come from the receiving session's own validating read of that
 * namespace. No record set travels with the record, and adoption creates no
 * second copy. A finished adoption leaves exactly one locator note in the
 * receiving conversation, and the receiving store saves into the adopted
 * namespace from then on. Adoption grants no exclusive access: the storage layer
 * performs no ownership check, so a later save from the sending Pi session
 * remains possible and Slate reports no conflict.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
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
import { currentBranchLabel } from "./corpus.ts";
import {
	listCorpusHandoffCandidates,
	readCorpusHandoffRecord,
	writeCorpusHandoffRecord,
	type CorpusHandoffRecord,
} from "./handoff-record.ts";
import { withGlobalModelDefaultRestored } from "./model-default.ts";
import { sanitizeForNotify } from "./notify.ts";
import {
	orchestratorCostUsd,
	type ContextBudgetObject,
	type ContextBudgetOverride,
	type RuntimeAuthorityBinding,
	type SlateConfig,
	type SlateStore,
} from "./state.ts";
import { DURABLE_SESSION_POLICY } from "./session-record.ts";

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
const CANDIDATE_OUTPUT_MAX_CHARS = 16_384;

export interface SlateHandoffHooks {
	startHandoff(ctx: ExtensionCommandContext, focus?: string): Promise<void>;
	adoptHandoff(ctx: ExtensionCommandContext, name: string | undefined, enterOrchestratorMode: () => () => void): Promise<boolean>;
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
/** One save refusal, as a sentence for a user-facing report. */
function saveRefusalDetail(error: unknown): string {
	return sanitizeForNotify(error instanceof Error ? error.message : String(error), 240);
}

export function reportFailure(ctx: ExtensionContext, message: string): void {
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

// The project kickoff template is project-derived prompt content. The caller
// supplies the trust result, and explicit adoption never calls this while untrusted.
export function buildKickoff(cwd: string, trusted: boolean, brief: string, focus?: string): string {
	const template = join(cwd, CONFIG_DIR_NAME, "slate-handoff.md");
	let base: string | undefined;
	if (trusted) {
		// existsSync alone is not enough: the path may be a directory or
		// unreadable, and a throw escaping here would leave the adopted record
		// without kickoff text — fall back to the default kickoff text.
		try {
			if (existsSync(template)) base = readFileSync(template, "utf8").trim();
		} catch {
			/* unreadable template → default kickoff */
		}
	}
	if (!base) {
		base = [
			"Slate orchestrator handoff completed after explicit adoption.",
			"Orchestrator mode and the predecessor's worker threads and episodes are restored.",
			"Use `threads` to list them and `episode` to fetch details. Continue the work.",
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
	_getBaseModel: () => BaseModelTracker,
): SlateHandoffHooks {
	// pi's compaction reserve — read ONCE, lazily, then cached: it feeds a
	// per-turn check and SettingsManager.create is a lock-protected disk read.
	// A mid-session settings edit is not picked up (acceptable: the clamp is a
	// safety margin, not an exact contract). READ-ONLY, and it must stay that
	// way: a setter call on this throwaway instance would write straight into
	// the user's GLOBAL settings unmediated — every write goes through
	// model-default.ts instead.
	let cachedReserveTokens: number | undefined;
	const reserveTokens = (ctx: ExtensionContext): number => {
		if (cachedReserveTokens === undefined) {
			try {
				cachedReserveTokens = SettingsManager.create(ctx.cwd, getAgentDir(), {
					projectTrusted: ctx.isProjectTrusted(),
				}).getCompactionReserveTokens();
			} catch {
				cachedReserveTokens = FALLBACK_RESERVE_TOKENS;
			}
		}
		return cachedReserveTokens;
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
			"Finish nothing new. Reply to the user with:",
			"(1) a concise HANDOFF BRIEF — overall goal, per-thread state with episode ids, immediate next actions;",
			"(2) instructions: run /slate handoff [optional focus] to write a handoff record, then run /slate adopt <name> in the successor session to restore the threads and episodes;",

			"Alternatively, run /slate sessions to list the Slate sessions of this project. That listing can omit entries when it reaches a scan or output limit. Read the episode files under the exact session directory on the labelled line for this Slate session.",
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
			notifyText = `slate: context at ${pct}% (budget ${threshold}%) — paused. Run /slate handoff [focus], then run /slate adopt <name> in the successor session.`;
			headline = `[slate] Context is at ${pct}% — over the ${threshold}% budget. Slate auto-paused: the thread tool now REJECTS new dispatches.`;
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
			notifyText = `slate: context at ${used} tokens (budget ${cap}${clampNote}) — paused. Run /slate handoff [focus], then run /slate adopt <name> in the successor session.`;
			headline = `[slate] Context is at ${used} tokens — over the ${cap}-token budget${clampNote}. Slate auto-paused: the thread tool now REJECTS new dispatches.`;
		}

		store.paused = true;
		// The pause holds in memory whatever storage answers, and the steer below must
		// still reach the orchestrator. A refused save is therefore reported, not
		// swallowed and not allowed to cancel the pause (Track 14 goal 5).
		try {
			store.commit();
		} catch (error) {
			reportFailure(
				ctx,
				`slate: the automatic pause was not saved: ${saveRefusalDetail(error)}. The pause applies to this Pi session only.`,
			);
		}
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
		try {
			store.commit();
		} catch (error) {
			reportFailure(
				ctx,
				`slate: the intercepted compaction pause was not saved: ${saveRefusalDetail(error)}. The pause applies to this Pi session only.`,
			);
		}
		if (ctx.hasUI) {
			ctx.ui.notify(
				"slate: auto-compaction intercepted — paused instead. Run /slate handoff [focus], then run /slate adopt <name> in the successor session.",
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
					"[slate] pi hit its auto-compaction threshold; slate cancelled the compaction and auto-paused instead: the thread tool now REJECTS new dispatches. (While paused, a repeat compaction passes through as the escape valve.)",
				)}\n(If slate has since been resumed or unpaused, disregard this message.)`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
		return { cancel: true };
	});


	const restoreAdoptedModel = async (ctx: ExtensionCommandContext, record: CorpusHandoffRecord): Promise<void> => {
		const spec = record.model;
		if (spec === undefined) return;
		const { provider, id } = spec;
		const label = sanitizeForNotify(`${provider}/${id}`);
		await withGlobalModelDefaultRestored(
			pi,
			ctx,
			getConfig(),
			spec,
			async () => {
				let calledSetter = false;
				try {
					let restored = ctx.model?.provider === provider && ctx.model?.id === id;
					if (!restored) {
						const model = ctx.modelRegistry.find(provider, id);
						if (model !== undefined) {
							calledSetter = true;
							restored = await _getBaseModel().ownSwitch(currentModelSpec(ctx), `${provider}/${id}`, () => pi.setModel(model));
						}
					}
					if (!restored) {
						reportFailure(ctx, `slate: could not restore handoff model ${label}. The session keeps its current model.`);
						return calledSetter;
					}
					_getBaseModel().adopt(`${provider}/${id}`, readLiveEffort(pi));
					if (typeof record.thinkingLevel === "string") {
						calledSetter = true;
						try {
							pi.setThinkingLevel(record.thinkingLevel);
							_getBaseModel().adopt(`${provider}/${id}`, readLiveEffort(pi));
						} catch (error) {
							reportFailure(
								ctx,
								`slate: restored model ${label}, but could not restore thinking level ${sanitizeForNotify(record.thinkingLevel, 20)}: ${sanitizeForNotify(error instanceof Error ? error.message : String(error))}`,
							);
						}
					}
				} catch (error) {
					calledSetter = true;
					reportFailure(ctx, `slate: could not restore handoff model ${label}: ${sanitizeForNotify(error instanceof Error ? error.message : String(error))}`);
				}
				return calledSetter;
			},
			(calledSetter) => calledSetter,
		);
	};

	const describeCandidates = (ctx: ExtensionCommandContext): string[] => {
		const listed = listCorpusHandoffCandidates({ cwd: ctx.cwd, isTrusted: () => ctx.isProjectTrusted() });
		if (!listed.ok) return [sanitizeForNotify(listed.reason, 360)];
		if (listed.candidates.length === 0) return ["slate: no handoff records are available. Run /slate handoff in the source session first."];
		const lines = listed.candidates.map(({ name, result }) => {
			if (!result.ok) return `- ${name}: unavailable — ${sanitizeForNotify(result.reason, 240)}`;
			const record = result.record;
			const created = new Date(record.createdAt);
			const createdLabel = Number.isNaN(created.getTime()) ? "invalid time" : created.toISOString();
			return `- ${name}: branch ${sanitizeForNotify(record.branchLabel || "(detached)", 80)}, worktree ${sanitizeForNotify(record.worktreePath, 160)}, created ${createdLabel}`;
		});
		return [
			listed.candidates.length === 1
				? "slate: one handoff record is available. Nothing was adopted without its explicit name:"
				: "slate: several handoff records are available. Nothing was adopted because a name is required:",
			...lines,
			"Run /slate adopt <name> to select one record.",
		];
	};

	/**
	 * COMPLETE one partial adoption of the namespace this Pi session already
	 * continues (BG1502/CN1506).
	 *
	 * The records are durable and validated already, and the receiving conversation
	 * has no locator note. One save therefore revalidates the namespace and writes
	 * the missing note. It changes no record, sends no second kickoff and restores no
	 * model, because the note was the only missing part.
	 */
	const completeAdoption = (ctx: ExtensionCommandContext, name: string): boolean => {
		let result: ReturnType<SlateStore["commit"]>;
		try {
			result = store.commit();
		} catch (error) {
			reportFailure(
				ctx,
				`slate: adoption could not complete the locator note of ${sanitizeForNotify(name)}: ${saveRefusalDetail(error)}. `
					+ `Every Slate record remains in namespace ${sanitizeForNotify(name)}.`,
			);
			return false;
		}
		if (result?.kind === "partial" || result?.kind === "uncertain") {
			reportFailure(
				ctx,
				`slate: adoption of ${sanitizeForNotify(name)} is still incomplete: ${sanitizeForNotify(result.message, 240)}. `
					+ `Every Slate record remains in namespace ${sanitizeForNotify(name)}.`,
			);
			return false;
		}
		const message = `slate: handoff ${sanitizeForNotify(name)} was already adopted in this Pi session, and slate completed its locator note.`;
		console.warn(message);
		if (ctx.hasUI) ctx.ui.notify(message, "info");
		return true;
	};

	const adoptHandoff = async (
		ctx: ExtensionCommandContext,
		name: string | undefined,
		enterOrchestratorMode: () => () => void,
	): Promise<boolean> => {
		// D104: this gate precedes candidate parsing and named-record parsing.
		if (!ctx.isProjectTrusted()) {
			reportFailure(ctx, "slate: handoff adoption requires a trusted project. Trust this project, then run /slate adopt <name> again.");
			return false;
		}
		if (name === undefined) {
			const rendered = describeCandidates(ctx).join("\n");
			const message = rendered.length > CANDIDATE_OUTPUT_MAX_CHARS
				? `${rendered.slice(0, CANDIDATE_OUTPUT_MAX_CHARS - 24)}\n[listing truncated]`
				: rendered;
			console.warn(message);
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			return false;
		}
		// ADOPTION CONTINUES ONE SLATE SESSION IN THIS PI SESSION, so this session must
		// have selected no storage of its own yet. A refusing session reports its own
		// refusal, and a session that already names ANOTHER external namespace keeps it:
		// abandoning that namespace here would leave its records unreachable.
		//
		// A session that already continues the namespace of THIS handoff is the one
		// exception, and the design requires it: a partial adoption keeps every record
		// and leaves the locator note missing, and the repeated command completes that
		// note. Refusing it made the advertised recovery impossible (BG1502/CN1506). The
		// comparison happens below, where the named record supplies the namespace.
		const authority = store.authorityState();
		if (authority.kind === "unavailable") {
			reportFailure(
				ctx,
				`slate: adoption refused because this session selected no storage — ${sanitizeForNotify(authority.message, 240)}`,
			);
			return false;
		}
		const continuing = authority.kind === "durable" ? authority.binding : undefined;
		if (continuing === undefined && (store.threads.size > 0 || store.episodes.size > 0)) {
			reportFailure(ctx, "slate: adoption refused because this session already has threads or episodes. Start a fresh session and run the command again.");
			return false;
		}
		const read = readCorpusHandoffRecord({ cwd: ctx.cwd, name, isTrusted: () => ctx.isProjectTrusted() });
		if (!read.ok) {
			reportFailure(ctx, `${sanitizeForNotify(read.reason, 360)}. Run /slate adopt without a name to list candidates.`);
			return false;
		}
		let liveWorktree: string;
		let liveBranch: string;
		try {
			liveWorktree = realpathSync(ctx.cwd);
			liveBranch = currentBranchLabel(ctx.cwd);
		} catch (error) {
			reportFailure(ctx, `slate: adoption could not verify the current worktree and branch: ${sanitizeForNotify(error instanceof Error ? error.message : String(error))}`);
			return false;
		}
		if (read.record.worktreePath !== liveWorktree) {
			reportFailure(
				ctx,
				`slate: adoption refused because the handoff belongs to worktree ${sanitizeForNotify(read.record.worktreePath, 160)}, not ${sanitizeForNotify(liveWorktree, 160)}.`,
			);
			return false;
		}
		if (read.record.branchLabel !== liveBranch) {
			reportFailure(
				ctx,
				`slate: adoption refused because the handoff belongs to branch ${sanitizeForNotify(read.record.branchLabel || "(detached)", 80)}, not ${sanitizeForNotify(liveBranch || "(detached)", 80)}.`,
			);
			return false;
		}
		const now = Date.now();
		if (read.record.createdAt > now) {
			reportFailure(ctx, `slate: adoption refused because ${sanitizeForNotify(name)} has a future creation time. Correct the clock or record, then retry.`);
			return false;
		}
		const advisoryAgeMs = 15 * 60 * 1000;
		if (now - read.record.createdAt >= advisoryAgeMs) {
			const warning = `slate: handoff ${sanitizeForNotify(name)} is older than 15 minutes. Age is advisory, so adoption continues.`;
			console.warn(warning);
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
		}
		const priorReminder = {
			...store.writingReminder,
			...(store.writingReminder.pending === undefined ? {} : { pending: { ...store.writingReminder.pending } }),
		};
		// THE RECORD SET COMES FROM THE VALIDATING READ OF THE NAMED NAMESPACE, and from
		// nothing else. The handoff record supplies the namespace name, the brief, the
		// focus and the model, so no record copy travels with it and adoption cannot
		// replace durable records with a caller-supplied set (Track 14 goals 10 to 12).
		const binding: RuntimeAuthorityBinding = {
			policy: DURABLE_SESSION_POLICY,
			identity: read.record.author.identity,
			name: read.record.author.name,
		};
		if (continuing !== undefined) {
			if (continuing.identity !== binding.identity || continuing.name !== binding.name) {
				reportFailure(
					ctx,
					`slate: adoption refused because this Pi session already continues Slate session ${sanitizeForNotify(continuing.name, 80)}. `
						+ `Start a fresh Pi session, then run /slate adopt ${sanitizeForNotify(name)} there.`,
				);
				return false;
			}
			return completeAdoption(ctx, name);
		}
		try {
			store.adoptExternalAuthority(binding);
		} catch (error) {
			reportFailure(
				ctx,
				`slate: adoption refused the external namespace ${sanitizeForNotify(name)}: ${saveRefusalDetail(error)}. `
					+ "No Slate record changed, so you can correct the cause and run the command again.",
			);
			return false;
		}
		const adoptedThreads = store.threads.size;
		const adoptedEpisodes = store.episodes.size;
		let undoMode = () => {};
		let partial: string | undefined;
		try {
			store.paused = false;
			// The sending session banked its own orchestrator spend in the handoff record.
			// It is one carried number and never a record set, and it never decreases.
			store.carriedCostUsd = Math.max(store.carriedCostUsd, read.record.carriedCostUsd);
			undoMode = enterOrchestratorMode();
			store.writingReminder.forceNext = true;
			const result = store.commit();
			if (result?.kind === "partial" || result?.kind === "uncertain") partial = sanitizeForNotify(result.message, 240);
		} catch (error) {
			delete store.writingReminder.pending;
			Object.assign(store.writingReminder, priorReminder);
			let rollbackFailure: string | undefined;
			try { undoMode(); }
			catch (rollbackError) { rollbackFailure = saveRefusalDetail(rollbackError); }
			const rollbackClause = rollbackFailure === undefined ? "" : ` Restoring the previous tool set also reported: ${rollbackFailure}.`;
			reportFailure(
				ctx,
				`slate: adoption could not save the receiving session state: ${saveRefusalDetail(error)}. `
					+ `Every Slate record remains in namespace ${sanitizeForNotify(name)}. No kickoff was sent.${rollbackClause}`,
			);
			return false;
		}
		if (partial !== undefined) {
			reportFailure(
				ctx,
				`slate: adoption saved every Slate record, but ${partial}. Run /slate adopt ${sanitizeForNotify(name)} again to complete it.`,
			);
		}
		await restoreAdoptedModel(ctx, read.record);
		const kickoff = buildKickoff(ctx.cwd, true, read.record.brief, read.record.focus);
		pi.sendMessage({ customType: "slate-kickoff", content: kickoff, display: true }, { deliverAs: "steer", triggerTurn: true });
		const success = `slate: handoff ${sanitizeForNotify(name)} adopted successfully with `
			+ `${adoptedThreads} thread${adoptedThreads === 1 ? "" : "s"} and ${adoptedEpisodes} episode${adoptedEpisodes === 1 ? "" : "s"}.`;
		console.warn(success);
		if (ctx.hasUI) ctx.ui.notify(success, "info");
		return true;
	};

	const startHandoff = async (ctx: ExtensionCommandContext, focus?: string): Promise<void> => {
		await ctx.waitForIdle();

		// SAVE THE RECORDS FIRST. The receiving session reads them from the external
		// namespace, so a handoff record written over unsaved records would name a
		// namespace that is behind this session. A refused save stops the handoff.
		try {
			store.commit();
		} catch (error) {
			reportFailure(
				ctx,
				`slate: handoff stopped because slate could not save its records: ${saveRefusalDetail(error)}. No handoff record was written.`,
			);
			return;
		}

		const brief = lastAssistantText(ctx);
		const identity = store.slateSessionId;
		const name = store.slateSessionName;
		const project = store.corpusProject;
		if (identity === undefined || name === undefined || project === undefined) {
			reportFailure(ctx, "slate: handoff record was not written because this session has no persisted corpus identity.");
			return;
		}
		// ctx.model can be undefined. A thinking level has no meaning without its model.
		const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		const record: CorpusHandoffRecord = {
			version: 1,
			author: { identity, name },
			authorSessionDirectory: join(project.directory, name),
			createdAt: Date.now(),
			worktreePath: realpathSync(ctx.cwd),
			branchLabel: currentBranchLabel(ctx.cwd),
			parentChain: store.slateSessionParentChain.map((parent) => ({ ...parent })),
			brief,
			...(focus === undefined ? {} : { focus }),
			...(model === undefined ? {} : { model, thinkingLevel: pi.getThinkingLevel() }),
			carriedCostUsd: store.carriedCostUsd + orchestratorCostUsd(ctx),
		};
		try {
			writeCorpusHandoffRecord(project, record);
		} catch (error) {
			reportFailure(
				ctx,
				`slate: handoff record was not written: ${sanitizeForNotify(error instanceof Error ? error.message : String(error), 240)}`,
			);
			return;
		}
		const command = `/slate adopt ${name}`;
		const message = `slate: handoff record written for ${name}. Start a fresh session and run ${command}.`;
		console.warn(message);
		if (ctx.hasUI) ctx.ui.notify(message, "info");
	};

	return { startHandoff, adoptHandoff, effectiveContextBudget };
}
