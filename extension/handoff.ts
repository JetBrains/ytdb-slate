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
 * /slate handoff [focus] → startHandoff(): captures the orchestrator's last
 * assistant message as the brief, writes <config dir>/slate/pending-handoff.json
 * (state snapshot + brief + parent session + live model/thinking level), and
 * opens a fresh session.
 *
 * Adoption: session replacement tears down this extension instance, so
 * in-memory state cannot cross over; and the fresh session's own file has no
 * slate-state entries for restore() to find (they live in the parent's file).
 * The pending file bridges the gap: the NEW instance's session_start handler
 * adopts the snapshot when the fresh session's parentSession header matches
 * (trusted projects only; stale files are reaped regardless of trust), and
 * then restores the captured model/thinking level — the fresh session does
 * not inherit them: startup CLI flags (-m/--thinking) are re-applied to the
 * replacement runtime, enabledModels scoping picks its first entry, and a
 * parent resumed with a non-default session-file model falls back to the
 * settings default.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	orchestratorCostUsd,
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
/** A pending-handoff file older than this cannot belong to an in-flight handoff. */
const PENDING_MAX_AGE_MS = 15 * 60 * 1000;
const BRIEF_MAX_CHARS = 6000;

// pi-coding-agent does not re-export ThinkingLevel (it lives in the transitive
// pi-agent-core package, which is not one of our peer deps) — derive it.
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface PendingHandoff {
	parentSession: string | undefined; // undefined = in-memory session; adoption then never matches
	createdAt: number;
	brief: string;
	// Live model + thinking level at handoff time. Absent in old pending files
	// and when the parent session had no model.
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	snapshot: SlateSnapshot;
}

export interface SlateHandoffHooks {
	startHandoff(ctx: ExtensionCommandContext, focus?: string): Promise<void>;
}

function pendingFile(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "slate", "pending-handoff.json");
}

// Strings from the pending file (and error messages derived from them) reach
// ctx.ui.notify, and pi-tui renders control/ANSI codes verbatim — a seeded
// pending file could inject terminal escapes. Strip control characters and
// cap the length before display.
function sanitizeForNotify(s: string, max = 120): string {
	const clean = s.replace(/[\u0000-\u001f\u007f\u009b]/g, "");
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
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
		// unreadable, and a throw escaping here would strand the pending-handoff
		// file startHandoff just wrote — fall back to the default kickoff text.
		try {
			if (existsSync(template)) base = readFileSync(template, "utf8").trim();
		} catch {
			/* unreadable template → default kickoff */
		}
	}
	// The "already restored" claim is only valid when the successor session
	// will actually adopt the pending state — adoption is trust-gated, and the
	// successor (same process, same cwd) shares this session's trust state, so
	// `trusted` decides which default text is honest here.
	if (!base) {
		base = trusted
			? [
					"Slate orchestrator handoff (context hygiene; the previous orchestrator exceeded its context budget).",
					"Orchestrator mode and all worker threads/episodes from the previous session are already restored:",
					"use `threads` to list them and `episode` to fetch details. Continue the work.",
				].join("\n")
			: [
					"Slate orchestrator handoff (context hygiene; the previous orchestrator exceeded its context budget).",
					"NOTE: this project is untrusted, so slate did NOT auto-restore the previous session's threads/episodes.",
					`Run /slate on if needed, then reconstruct context from the episode files under ${CONFIG_DIR_NAME}/slate/episodes/ and continue the work.`,
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
): SlateHandoffHooks {
	// pi's compaction reserve — read ONCE, lazily, then cached: it feeds a
	// per-turn check and SettingsManager.create is a lock-protected disk read.
	// A mid-session settings edit is not picked up (acceptable: the clamp is a
	// safety margin, not an exact contract).
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

	/** Handoff instructions shared by both pause sites (turn check + compaction intercept). */
	const pauseInstructions = (headline: string) =>
		[
			headline,
			"Finish nothing new. Reply to the user with:",
			"(1) a concise HANDOFF BRIEF — overall goal, per-thread state with episode ids, immediate next actions;",
			"(2) instructions: run /slate handoff [optional focus] to continue in a fresh session where all threads and episodes are restored automatically;",
			`alternatively, start a new pi session manually, run /slate on, and have the new orchestrator read the episode files under ${CONFIG_DIR_NAME}/slate/episodes/.`,
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
			// Clamp to the window: the pause must fire BEFORE pi's compaction point
			// (contextWindow − reserveTokens) with room to write the brief — but
			// never below half the window, so a small-window model still gets a
			// usable orchestrator instead of a near-zero effective budget.
			// (usage.contextWindow > 0 is guaranteed: getContextUsage returns
			// undefined when no window is known.)
			const effective = Math.min(
				configured,
				Math.max(usage.contextWindow - reserveTokens(ctx) - BRIEF_HEADROOM_TOKENS, Math.ceil(usage.contextWindow / 2)),
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
			headline = `[slate] Context is at ${used} tokens — over the ${cap}-token budget${clampNote}. Slate auto-paused: the thread tool now REJECTS new dispatches.`;
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
					"[slate] pi hit its auto-compaction threshold; slate cancelled the compaction and auto-paused instead: the thread tool now REJECTS new dispatches. (While paused, a repeat compaction passes through as the escape valve.)",
				)}\n(If slate has since been resumed or unpaused, disregard this message.)`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
		return { cancel: true };
	});

	// Adopt a pending handoff into a fresh session. Registered AFTER index.ts's
	// restore handler (so a branch that already carries slate state wins) and
	// BEFORE mode.ts's (so its tool restriction sees the adopted mode).
	pi.on("session_start", async (_event, ctx) => {
		if (store.threads.size > 0 || store.orchestratorMode) return; // state already restored on this branch
		const file = pendingFile(ctx.cwd);
		try {
			if (!existsSync(file)) return;
			const pending = JSON.parse(readFileSync(file, "utf8")) as PendingHandoff;
			const age = Date.now() - (pending.createdAt ?? 0);
			// STALE reap runs regardless of trust: it deletes an abandoned runtime
			// file without injecting any content into prompts or state, and keeps
			// the file from lingering forever in a never-trusted project.
			// Out-of-range timestamps are stale too: a future createdAt (negative
			// age) or a non-numeric one (NaN age) would otherwise dodge the reap
			// forever — a real in-flight handoff is at most minutes old.
			if (!(age >= 0 && age < PENDING_MAX_AGE_MS)) {
				rmSync(file, { force: true });
				return;
			}
			// Trust gate (ADOPTION only): the pending file is project-local state a
			// cloned repo could ship pre-seeded. Never adopt its content in an
			// untrusted project — but leave a FRESH file untouched: the user may
			// grant trust shortly after, within the handoff window.
			if (!ctx.isProjectTrusted()) return;
			// Never adopt into an unrelated session.
			const matches = !!pending.parentSession && pending.parentSession === ctx.sessionManager.getHeader()?.parentSession;
			if (!matches) return;
			store.adoptSnapshot(pending.snapshot, ctx);
			store.paused = false;
			store.save();
			rmSync(file, { force: true });
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
			// The pending file is disk JSON: honor the captured model only as an
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
				try {
					// Equality guard: setModel persists the model as the user's GLOBAL
					// default as a side effect, so only call it when the fresh session
					// actually resolved to something else.
					let restored = ctx.model?.provider === provider && ctx.model?.id === id;
					if (!restored) {
						const model = ctx.modelRegistry.find(provider, id);
						restored = !!model && (await pi.setModel(model));
					}
					if (restored) {
						// Thinking level rides only on a matching/restored model, and only
						// AFTER setModel (which re-derives thinking internally). Like
						// setModel, setThinkingLevel persists to the user's ONE GLOBAL
						// default thinking level (not a per-model value), so clamping the
						// old level against an unrelated fallback model would persist
						// garbage there. Non-strings are never passed on; pi clamps
						// unknown string levels itself.
						if (typeof pending.thinkingLevel === "string") pi.setThinkingLevel(pending.thinkingLevel);
					} else if (ctx.hasUI) {
						ctx.ui.notify(
							`slate: could not restore model ${label} (unknown or no auth) — keeping the session default.`,
							"warning",
						);
					}
				} catch (error) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`slate: could not restore model ${label} — ${sanitizeForNotify(
								error instanceof Error ? error.message : String(error),
							)}. Keeping the session default.`,
							"warning",
						);
					}
				}
			}
		} catch {
			/* a broken pending file must never break session start */
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
		const pending: PendingHandoff = {
			parentSession,
			createdAt: Date.now(),
			brief,
			model,
			thinkingLevel: model ? pi.getThinkingLevel() : undefined,
			// The successor starts unpaused and in orchestrator mode regardless of
			// the current (paused) state.
			snapshot: {
				...store.snapshot(),
				paused: false,
				orchestratorMode: true,
				// The successor's own branch sum starts at zero, so bank the parent's
				// billed orchestrator spend (plus anything already carried) — the
				// displayed total must survive repeated handoffs.
				carriedCostUsd: store.carriedCostUsd + orchestratorCostUsd(ctx),
			},
		};
		const file = pendingFile(ctx.cwd);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(pending, null, 2)}\n`, "utf8");

		const kickoff = buildKickoff(ctx.cwd, ctx.isProjectTrusted(), brief, focus);
		// catch, NOT finally: on success the NEW session's adoption handler has
		// already consumed and deleted the pending file (session_start fires
		// inside newSession) — cleaning up there would be wrong.
		try {
			const { cancelled } = await ctx.newSession({
				parentSession,
				withSession: async (fresh) => {
					await fresh.sendUserMessage(kickoff);
				},
			});
			if (cancelled) {
				// Left behind, the pending file could be adopted by an unintended fork
				// or session sharing this parent within the 15-min window.
				rmSync(file, { force: true });
				store.paused = false;
				store.save();
				if (ctx.hasUI) ctx.ui.notify("slate: handoff cancelled — pause cleared, pending state removed.", "warning");
			}
		} catch (error) {
			try {
				rmSync(file, { force: true });
			} catch {
				/* ignore */
			}
			// Best-effort: if the replacement partially happened, the old pi/ctx
			// are stale and these calls themselves throw.
			try {
				store.paused = false;
				store.save();
				if (ctx.hasUI) {
					ctx.ui.notify(
						`slate: handoff failed — ${error instanceof Error ? error.message : String(error)}. Pause cleared; pending state removed.`,
						"error",
					);
				}
			} catch {
				/* stale pi/ctx after partial replacement */
			}
			throw error;
		}
	};

	return { startHandoff };
}
