/**
 * Global model-default restore: put the user's GLOBAL pi defaults back after a
 * slate-initiated model switch.
 *
 * pi persists every in-session model switch into the user's global settings
 * file (<agent dir>/settings.json): setModel writes defaultProvider and
 * defaultModel, and its internal thinking cascade can write
 * defaultThinkingLevel too. Both slate switch sites — orchestrator failover
 * (failover.ts) and handoff adoption (handoff.ts) — mean "make THIS session
 * run that model", so the cross-project residue is a side effect nobody asked
 * for: every later pi session, in every project, starts on slate's pick. This
 * module wraps each such switch and undoes exactly that residue.
 *
 * TWO INDEPENDENT DECISIONS, NEVER ONE PER SWITCH AND NEVER ONE PER KEY:
 *  - the defaultProvider + defaultModel PAIR, decided and written as ONE UNIT;
 *  - defaultThinkingLevel, decided and written on its own.
 * Each is judged from two fresh disk reads taken immediately before and after
 * the switch: restore only what CHANGED, and only when what it changed to is
 * exactly what slate's own switch should have produced. Anything unchanged is
 * never touched (which also makes this a zero-write no-op in EVERY state on a
 * future pi that stops persisting switches — upstream #5263); anything holding
 * a different value belongs to somebody else and is left alone.
 *
 * Why the pair is ONE unit while the thinking level is separate: pi's ONLY
 * writer of those two keys is setDefaultModelAndProvider, which writes them
 * together, so any combination other than a pair that actually existed is a
 * state pi cannot produce and no consumer expects (a provider that does not own
 * the model, or a model with no provider at all). Deciding the halves
 * separately would manufacture exactly that: pre-switch provider + a third
 * party's model. So the pair is restored only when EVERY half that changed
 * matches the switch's expectation, and then the pre-switch pair is written
 * back EXACTLY, both halves, absence included — a state that demonstrably
 * existed a moment ago. The thinking level is not part of that pair and stays
 * independent, because the model setter's cascade can write it even when
 * provider and model already name the target, and handoff adoption can write it
 * ALONE when its equality guard skips the model setter.
 *
 * Invariants baked in here, each one a defect this shape had to reverse:
 *  - NO STATE OUTLIVES A SINGLE SWITCH. Everything consulted is read during the
 *    switch being handled; nothing is deferred, remembered, or re-applied later
 *    (no shutdown backstop: a pending repair can clobber a later change, and a
 *    pending ABSENCE re-applied at quit can delete real settings).
 *  - THROWAWAY READERS, one per read. A reused SettingsManager serves a clone
 *    taken at construction and never re-reads disk, so a comparison built on
 *    one reads stale state and its read-back is self-confirming.
 *  - GLOBAL SCOPE ONLY, PROJECT TRUST DISABLED. Reads go through
 *    getGlobalSettings, never the getDefault* convenience getters, which read
 *    the MERGED global+project view — sourcing a reference from them in a
 *    project that pins a default would copy that pinned value into the user's
 *    global file. Disabling project trust also skips the project lock and file
 *    entirely, so a corrupt PROJECT file cannot register an error in the
 *    channel this module uses as its write-success signal.
 *  - STAND DOWN ON AN UNTRUSTWORTHY READ. Held lock, unreadable, corrupt,
 *    EMPTY/zero-byte file, construction-time load failure: warn, write nothing,
 *    delete nothing. Absence is decided on the VALUE, never on key presence.
 *    Acting on a read slate cannot trust is the one way this code could destroy
 *    a user's settings rather than merely fail to tidy up.
 *  - MACROTASK YIELD before the post-switch read. The thinking-level setter is
 *    synchronous with no trailing await, so a straight-line read sees the
 *    pre-switch file; and a MICROtask yield is write-queue-depth dependent,
 *    missing the write entirely at depth four or more — the same defect, but
 *    only under load.
 *  - CONSOLE-FIRST REPORTING of FAILURES, past the call sites' catch-alls, with
 *    every extension-context accessor guarded (hasUI, cwd and the live thinking
 *    level are all getters that THROW on a stale context) and every displayed
 *    string sanitized (a corrupt settings file puts raw file bytes — escape
 *    sequences included — inside pi's JSON parse error, and pi-tui renders
 *    control codes verbatim).
 *
 * Residue, stated honestly: a restore that exhausts its retry budget is
 * ABANDONED with a loud console warning and never repaired — the switched value
 * then persists globally exactly as it does today.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SlateConfig } from "./state.ts";

// pi-coding-agent does not re-export ThinkingLevel (it lives in the transitive
// pi-agent-core package, which is not one of our peer deps) — derive it, as
// handoff.ts does.
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/**
 * Retries are bounded by ELAPSED TIME, not by attempt count: pi's settings lock
 * busy-waits SYNCHRONOUSLY, so an attempt's cost is set by contention, not by
 * slate — a count-based bound would leave the stall unbounded.
 *
 * WORST-CASE STALL, derived from this file as written (pi 0.82.1: a contended
 * acquisition spins 10 × 20 ms ≈ 180 ms before it succeeds or throws):
 * five lock acquisitions per attempt — post-switch read (construction IS a
 * read), write-manager construction, the pair write, the separate
 * thinking-level write, and the verifying read — so a fully contended attempt
 * is ≈ 900 ms. The budget only gates whether a NEW attempt STARTS and cannot
 * preempt a spin already in flight, and the pre-switch read sits OUTSIDE the
 * budget entirely, so the honest ceiling per switch is
 * 180 ms (pre-read) + 500 ms (budget) + 900 ms (one final attempt) ≈ 1.58 s.
 */
const RESTORE_BUDGET_MS = 500;

/**
 * Minimum gap between attempts. Without it a persistent-but-FAST failure (an
 * unwritable file, or a write that lands while the verifying read keeps
 * disagreeing) issues hundreds of real settings writes inside the budget —
 * measured at 358 in 502 ms; with it the loop starts at most
 * ⌈budget / pacing⌉ + 1 = 21 attempts (measured: 21 in 515 ms). It also
 * guarantees every pass yields to the event loop.
 */
const RETRY_PACING_MS = 25;

/**
 * Cap for a whole composed report line (the per-fragment cap is
 * sanitizeForNotify's). The report is the ONLY trace an abandoned restore
 * leaves, so it is bounded but never cut mid-word: report lines are built
 * diagnostics-first (what failed, which keys, which file) with the advisory
 * tail last, so the cap eats boilerplate rather than evidence, and the cut is
 * marked so a truncated line cannot be mistaken for a crash mid-sentence.
 */
const REPORT_MAX_CHARS = 500;
/** Explicit end-marker for a truncated report line. */
const REPORT_TRUNCATION_MARK = " […truncated]";

/** The three global keys pi's model setter can write. */
interface GlobalDefaults {
	provider: string | undefined;
	model: string | undefined;
	thinkingLevel: ThinkingLevel | undefined;
}

/** What this switch SHOULD have produced (the "and only to that value" clause). */
interface ExpectedValues {
	provider: string;
	model: string;
	/** The session's LIVE level after the switch; undefined = unreadable ⇒ that key is skipped. */
	thinkingLevel: ThinkingLevel | undefined;
}

/**
 * What to write. The pair is one field, not two, so the unit decision cannot be
 * re-split by accident; the wrapper objects distinguish "do not write this" from
 * "write absence".
 */
interface RestorePlan {
	pair?: { provider: string | undefined; model: string | undefined };
	thinkingLevel?: { value: ThinkingLevel | undefined };
	/** Key names, for the failure report only. */
	keys: string[];
}

type ReadResult = { ok: true; values: GlobalDefaults } | { ok: false; reason: string };
type WriteResult = { ok: true } | { ok: false; reason: string };

// Everything this module displays can carry attacker-influenced bytes: pi's
// JSON parse error embeds a raw snippet of the settings file, and pi-tui
// renders control/ANSI codes verbatim.
function stripControlChars(s: string): string {
	return s.replace(/[\u0000-\u001f\u007f\u009b]/g, "");
}

// Per-FRAGMENT sanitizer for text spliced into a message: the same logic as the
// shared helper in notify.ts (control-char strip + 120-char cap), kept LOCAL on
// purpose. This module also needs the bare stripControlChars primitive above for
// truncateForReport's word-boundary report cap, which notify.ts does not
// provide; keeping the fragment cap here lets both caps share that one strip
// primitive rather than importing one function and re-deriving its dependency.
function sanitizeForNotify(s: string, max = 120): string {
	const clean = stripControlChars(s);
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Bound a whole composed report line. Unlike the per-fragment cap this cuts at
 * a WORD boundary and marks the cut explicitly, so a truncated report reads as
 * deliberately shortened rather than as a message that died mid-sentence. A
 * single unbroken token longer than the tail allowance is cut mid-token rather
 * than discarded wholesale — the marker still says so.
 */
function truncateForReport(message: string): string {
	const clean = stripControlChars(message);
	if (clean.length <= REPORT_MAX_CHARS) return clean;
	const room = REPORT_MAX_CHARS - REPORT_TRUNCATION_MARK.length;
	const cut = clean.slice(0, room);
	const lastSpace = cut.lastIndexOf(" ");
	const kept = lastSpace >= room - 40 ? cut.slice(0, lastSpace) : cut;
	// Drop trailing separators so the marker does not read as ", […truncated]".
	return `${kept.replace(/[\s,;:—-]+$/u, "")}${REPORT_TRUNCATION_MARK}`;
}

/** Display text for a caught value — sanitized HERE, since every reason string below is built from it. */
function errorText(error: unknown): string {
	return sanitizeForNotify(error instanceof Error ? error.message : String(error));
}

// pi does not re-export SettingsError — derive the drained-channel shape.
function settingsErrorText(errors: ReturnType<SettingsManager["drainErrors"]>): string {
	return errors.map((e) => errorText(e.error)).join("; ");
}

/** MONOTONIC elapsed-time source: unlike Date.now() it cannot jump (NTP step, DST, manual clock set). */
function nowMs(): number {
	return performance.now();
}

/**
 * A MACROTASK yield, specified as such: `setTimeout` and never
 * queueMicrotask/Promise.resolve, which drain only as far as pi's write queue
 * has already progressed and miss the write entirely at queue depth ≥ 4. A
 * single macrotask yield is depth-independent.
 */
function macrotaskDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The same path pi's FileSettingsStorage computes for the global scope. */
function globalSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/**
 * FAILURE reporting: console-first and unconditional — the has-UI branch is
 * exactly the branch that vanishes in headless runs and at teardown, where a
 * restore failure most needs to surface — with the UI notification as the
 * extra. Called directly rather than thrown, so the catch-all in the
 * surrounding handler (both call sites have one) cannot swallow the report.
 * Nothing else in this module writes to the console: a successful restore is
 * silent.
 */
function report(ctx: ExtensionContext, message: string): void {
	// Belt and braces: every fragment is sanitized where it is built, and the
	// composed line is stripped again — and bounded — before it can reach a
	// terminal.
	const text = truncateForReport(message);
	console.warn(text);
	try {
		// ctx.hasUI is a getter that THROWS on a stale context — an unguarded
		// check is a crash, not a test.
		if (ctx.hasUI) ctx.ui.notify(text, "warning");
	} catch {
		/* stale ctx after session replacement — the console line above stands */
	}
}

/** ctx.cwd throws on a stale context; without it no reader can be built. */
function readCwd(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.cwd;
	} catch {
		return undefined;
	}
}

/**
 * The session's LIVE thinking level — the level it is ACTUALLY running, which
 * is what this switch "should have produced" for that key. Never derived by
 * replicating pi's clamping: the clamp composes across the model setter's
 * hidden cascade and the explicit setter, and when the outgoing model lacks
 * reasoning support pi seeds it from the MERGED global+project view — so a
 * replica reading global scope alone would disagree with pi wherever a project
 * pins a level, and could write that pinned value into the user's global file.
 * Guarded: the accessor throws on a stale context.
 */
function readLiveThinkingLevel(pi: ExtensionAPI): { ok: true; level: ThinkingLevel } | { ok: false; reason: string } {
	try {
		return { ok: true, level: pi.getThinkingLevel() };
	} catch (error) {
		return { ok: false, reason: errorText(error) };
	}
}

/**
 * One fresh read of the GLOBAL scope through a throwaway reader. Any doubt
 * about the result is reported as a failure — the caller then writes nothing.
 */
function readGlobalDefaults(cwd: string): ReadResult {
	const path = globalSettingsPath();
	// An EMPTY / zero-byte file parses to "no settings" with NO recorded error,
	// so every key would read as absent and the absence branch below would
	// DELETE keys on the strength of a file that was never really read. A
	// MISSING file is genuine absence (fresh install, or a user who never set a
	// default); a zero-byte one is inconclusive.
	try {
		if (existsSync(path) && statSync(path).size === 0) {
			return { ok: false, reason: "the settings file is empty" };
		}
	} catch (error) {
		return { ok: false, reason: `the settings file is unreadable — ${errorText(error)}` };
	}
	let manager: SettingsManager;
	try {
		// Throwaway reader, global scope only with project trust disabled (see
		// the module header): never reused, never reloaded, discarded below.
		manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
	} catch (error) {
		return { ok: false, reason: `cannot read the settings file — ${errorText(error)}` };
	}
	// Construction IS the read: a held lock, an unreadable file or a parse error
	// is RECORDED here rather than thrown, so the channel must be drained before
	// the values are trusted.
	const errors = manager.drainErrors();
	if (errors.length > 0) return { ok: false, reason: `cannot read the settings file — ${settingsErrorText(errors)}` };
	// getGlobalSettings, never getDefaultProvider/Model/ThinkingLevel: those read
	// the MERGED view (module header). Absence is decided on the VALUE — the
	// accessor returns a structured clone and cloning RETAINS keys whose value is
	// undefined, so a key-presence test would report the opposite of the truth.
	const settings = manager.getGlobalSettings();
	return {
		ok: true,
		values: {
			provider: settings.defaultProvider,
			model: settings.defaultModel,
			thinkingLevel: settings.defaultThinkingLevel,
		},
	};
}

/**
 * The defaultProvider + defaultModel decision, taken as ONE UNIT (see the
 * module header for why a per-half decision is unsafe). Returns the exact
 * pre-switch pair to write back, or undefined to leave BOTH keys alone.
 *
 * Do not re-split this into two decisions: pi's only writer of these keys
 * writes them together, so a pair mixing a pre-switch half with a post-switch
 * half is a state pi can never produce.
 */
function planPairRestore(
	pre: GlobalDefaults,
	post: GlobalDefaults,
	expected: ExpectedValues,
): { provider: string | undefined; model: string | undefined } | undefined {
	const providerChanged = post.provider !== pre.provider;
	const modelChanged = post.model !== pre.model;
	// Nothing changed ⇒ this switch wrote no pair; there is nothing to undo.
	if (!providerChanged && !modelChanged) return undefined;
	// Any half that changed must hold exactly what slate's own switch should
	// have produced. If even one does not, the pair as it stands is somebody
	// else's and the WHOLE pair is left untouched.
	if (providerChanged && post.provider !== expected.provider) return undefined;
	if (modelChanged && post.model !== expected.model) return undefined;
	// Restore the pre-switch pair EXACTLY — both halves, per-half absence
	// included. That state genuinely existed a moment ago, so it is coherent by
	// construction.
	return { provider: pre.provider, model: pre.model };
}

/**
 * The full plan: the pair decision above plus the independent thinking-level
 * decision. Returns undefined when nothing diverged — the common case, in which
 * nothing at all is written.
 */
function planRestore(pre: GlobalDefaults, post: GlobalDefaults, expected: ExpectedValues): RestorePlan | undefined {
	const pair = planPairRestore(pre, post, expected);
	const restoreThinking =
		// undefined = the live level could not be read (stale ctx) ⇒ skip this
		// key; the pair's expectation does not depend on it.
		expected.thinkingLevel !== undefined &&
		post.thinkingLevel !== pre.thinkingLevel &&
		post.thinkingLevel === expected.thinkingLevel;
	if (!pair && !restoreThinking) return undefined;
	const plan: RestorePlan = { keys: [] };
	if (pair) {
		plan.pair = pair;
		plan.keys.push("defaultProvider+defaultModel");
	}
	if (restoreThinking) {
		plan.thinkingLevel = { value: pre.thinkingLevel };
		plan.keys.push("defaultThinkingLevel");
	}
	return plan;
}

/** One write attempt: write, flush, drain, verify. */
async function applyRestore(cwd: string, plan: RestorePlan): Promise<WriteResult> {
	let manager: SettingsManager;
	try {
		manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
	} catch (error) {
		return { ok: false, reason: `cannot open the settings file for writing — ${errorText(error)}` };
	}
	// A CONSTRUCTION-TIME load error is itself an untrustworthy read, and it is
	// checked BEFORE any write because the channel cannot reveal it afterwards:
	// in that state pi's save() silently NO-OPS, so nothing is enqueued and no
	// write error is ever recorded — and the channel is destructive and
	// single-consumer, so a post-flush drain would report success for a write
	// that never happened. A write issued after a read error is a failure
	// regardless.
	const loadErrors = manager.drainErrors();
	if (loadErrors.length > 0) {
		return { ok: false, reason: `cannot open the settings file for writing — ${settingsErrorText(loadErrors)}` };
	}
	if (plan.pair) {
		// TYPE-UNSOUND ON PURPOSE, and nothing in this repo typechecks it (pi
		// loads raw TypeScript via jiti): restoring ABSENCE means writing
		// `undefined`, which this setter's `string` parameters do not admit. It
		// relies on pi serialising the merged object with JSON.stringify, which
		// OMITS undefined values and so drops the key from the file. The
		// verifying re-read below turns a wrong assumption into a warning rather
		// than silent corruption.
		manager.setDefaultModelAndProvider(plan.pair.provider as string, plan.pair.model as string);
	}
	if (plan.thinkingLevel) {
		// Same deliberate type-unsound absence write as the pair above.
		manager.setDefaultThinkingLevel(plan.thinkingLevel.value as ThinkingLevel);
	}
	// flush() only awaits pi's write queue, which terminates in its own .catch —
	// it neither rejects nor reports. Write failures surface ONLY through the
	// error channel, drained below AFTER the flush, never before: draining first
	// would report success on a write that has not been attempted yet. (An
	// unexpected rejection from a future pi is caught by the wrapper's guard.)
	await manager.flush();
	const writeErrors = manager.drainErrors();
	if (writeErrors.length > 0) return { ok: false, reason: `the write failed — ${settingsErrorText(writeErrors)}` };
	// Verify against a FRESH read: this manager's own accessor would serve the
	// object its setters just mutated, so a read-back through it is vacuous.
	const check = readGlobalDefaults(cwd);
	if (!check.ok) return { ok: false, reason: `cannot verify the restore — ${check.reason}` };
	if (plan.pair && (check.values.provider !== plan.pair.provider || check.values.model !== plan.pair.model)) {
		return { ok: false, reason: "the file does not hold the restored defaultProvider/defaultModel" };
	}
	if (plan.thinkingLevel && check.values.thinkingLevel !== plan.thinkingLevel.value) {
		return { ok: false, reason: "the file does not hold the restored defaultThinkingLevel" };
	}
	return { ok: true };
}

/** Steps after the switch: yield, expectation, decisions, write, verify, bounded retry. */
async function restoreAfterSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
	pre: GlobalDefaults,
	target: { provider: string; id: string },
): Promise<void> {
	// One macrotask yield: pi's write is queued, and the thinking-level setter
	// does not drain it (see the module header).
	await macrotaskDelay(0);
	const live = readLiveThinkingLevel(pi);
	const expected: ExpectedValues = {
		provider: target.provider,
		model: target.id,
		thinkingLevel: live.ok ? live.level : undefined,
	};
	const deadline = nowMs() + RESTORE_BUDGET_MS;
	let failure = "";
	/** Keys of the LAST attempt that got as far as deciding — "" when none did. */
	let failureKeys = "";
	/** True once a post-switch read succeeded — i.e. once divergence is KNOWN, either way. */
	let sawPost = false;
	let warnedThinking = false;
	for (;;) {
		// FIXED PRE, FRESH POST. The pre-switch reference above is captured once
		// and never re-read: a retry that re-read it would adopt a failed
		// attempt's partial write as "the pre-switch state" and faithfully
		// preserve the very leak it was invoked to remove. The post-switch state
		// is re-read on EVERY attempt: a cached one would revert a third-party
		// write that landed between attempts.
		const post = readGlobalDefaults(cwd);
		if (post.ok) {
			sawPost = true;
			if (!live.ok && !warnedThinking && post.values.thinkingLevel !== pre.thinkingLevel) {
				// Warn only once divergence is KNOWN: the accessor throwing is
				// irrelevant while the key still holds its pre-switch value. Provider
				// and model are evaluated and restored either way.
				warnedThinking = true;
				report(
					ctx,
					`slate: not restoring the global defaultThinkingLevel — it changed during this model switch, but the ` +
						`session's live thinking level is unreadable (${live.reason}), so slate cannot tell whose change it is.`,
				);
			}
			const plan = planRestore(pre, post.values, expected);
			if (!plan) return; // nothing diverged ⇒ write nothing at all, say nothing
			const outcome = await applyRestore(cwd, plan);
			if (outcome.ok) return;
			failure = outcome.reason;
			failureKeys = plan.keys.join(", ");
		} else {
			// Unlike the pre-switch read, an inconclusive post-switch read is
			// RETRYABLE while the budget lasts — lock contention is exactly the
			// transient condition a retry exists for.
			failure = post.reason;
			failureKeys = "";
		}
		// The budget gates whether a NEW attempt starts; it cannot preempt a lock
		// spin already in flight (see RESTORE_BUDGET_MS for the real ceiling).
		if (nowMs() >= deadline) break;
		await macrotaskDelay(RETRY_PACING_MS);
	}
	// Diagnostics FIRST (what failed, which keys, which file), advisory tail LAST:
	// REPORT_MAX_CHARS then eats boilerplate rather than evidence.
	const path = globalSettingsPath();
	const keysClause = failureKeys === "" ? "" : ` (keys: ${failureKeys})`;
	report(
		ctx,
		sawPost
			? `slate: could not restore the global model defaults${keysClause} in ${path} — ${failure}. ` +
					`Retried for ${RESTORE_BUDGET_MS} ms; this switch's values stay there and will apply to later pi ` +
					"sessions; slate will not retry."
			: // Divergence was never established: claiming a leak here would be a
				// guess, and when the switch wrote nothing it would be a false one.
				`slate: could not check the global model defaults in ${path} — ${failure}. ` +
					`Retried for ${RESTORE_BUDGET_MS} ms; if this switch changed them, the change stays there; ` +
					"slate will not retry.",
	);
}

/** A predicate throwing, or absent, means "assume the switch persisted" — the safe direction. */
function switchMayHavePersisted<T>(predicate: ((result: T) => boolean) | undefined, result: T): boolean {
	if (!predicate) return true;
	try {
		return predicate(result) !== false;
	} catch {
		return true;
	}
}

/**
 * Wrap ONE slate-initiated model switch so the user's global model defaults are
 * left as slate found them. `performSwitch` must contain every setter call of
 * that switch — the post-switch read has to follow the LAST write, since
 * adoption can persist the thinking-level key alone.
 *
 * The restore runs even when `performSwitch` THROWS (pi's model setter persists
 * the pair before the cascade and the model-select emission that can throw, so
 * a throw can still leave residue); the original rejection is then re-thrown
 * unchanged. Apart from that, the wrapper never throws and never alters what
 * `performSwitch` returns: a restore failure is reported, not propagated.
 *
 * `mayHavePersisted` is an optional escape hatch for the opposite case: return
 * false to state that the callback provably called NO pi setter, so nothing can
 * have been written and the entire post-switch phase — yield, reads, retries,
 * reporting — is skipped. Omitted, true, or throwing all mean "a setter may
 * have run" and the restore proceeds.
 */
export async function withGlobalModelDefaultRestored<T>(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: SlateConfig,
	target: { provider: string; id: string },
	performSwitch: () => Promise<T>,
	mayHavePersisted?: (result: T) => boolean,
): Promise<T> {
	// Lax, like slate's other boolean knobs: anything but an explicit false
	// leaves the restore on.
	if (config.preserveGlobalModelDefault === false) return performSwitch();
	const cwd = readCwd(ctx);
	// Read fresh IMMEDIATELY before the switch: this is the reference a restore
	// writes back, and a long-lived one would be stale by construction.
	const pre = cwd === undefined ? undefined : readGlobalDefaults(cwd);
	// Conservative default: a switch that threw may already have persisted.
	let persisted = true;
	try {
		const result = await performSwitch();
		persisted = switchMayHavePersisted(mayHavePersisted, result);
		return result;
	} finally {
		// A `finally` — so a throwing switch cannot skip the restore — and never a
		// `return` inside it, which would swallow the caller's result or error.
		if (persisted) {
			if (cwd === undefined || pre === undefined) {
				report(
					ctx,
					`slate: not restoring the global model defaults — the extension context is stale, so ${globalSettingsPath()} cannot be read.`,
				);
			} else if (!pre.ok) {
				// Stand down: restore NOTHING, warn. A pre-switch read failure is
				// terminal rather than retryable — there is no trustworthy reference
				// to retry against — and acting on it could delete real settings.
				// The path is named HERE rather than inside every reason: one mention,
				// in the fixed prefix that truncation cannot reach.
				report(ctx, `slate: not restoring the global model defaults in ${globalSettingsPath()} — ${pre.reason}.`);
			} else {
				try {
					await restoreAfterSwitch(pi, ctx, cwd, pre.values, target);
				} catch (error) {
					// This mechanism must never unwind the switch handler that called it.
					report(ctx, `slate: restoring the global model defaults failed — ${errorText(error)}.`);
				}
			}
		}
	}
}
