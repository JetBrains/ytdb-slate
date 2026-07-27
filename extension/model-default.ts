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
 * THE RULE IS PER KEY, NEVER PER SWITCH. For each of the three keys k:
 * restore k iff post(k) !== pre(k) AND post(k) === expected(k) — "slate's own
 * switch actually changed this key" AND "changed it to exactly what that
 * switch should have produced", judged from two fresh disk reads taken
 * immediately before and after the switch. A key that did not change is never
 * touched (which also makes this a zero-write no-op in EVERY state on a future
 * pi that stops persisting switches — upstream #5263); a key holding anything
 * else belongs to somebody else and is left alone. Per key matters concretely:
 * the model setter's thinking cascade can write defaultThinkingLevel even when
 * provider and model already name the target, and handoff adoption can write
 * that key ALONE when its equality guard skips the model setter — a
 * whole-switch comparison reads both as "nothing to undo".
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
 *  - ATOMIC PAIR WRITE. pi only ever writes defaultProvider + defaultModel
 *    together, so two separate setters produce an on-disk state pi itself
 *    cannot produce, and a failed second write makes that incoherent pair
 *    permanent — strictly worse than the leak.
 *  - CONSOLE-FIRST REPORTING, past the call sites' catch-alls, with every
 *    extension-context accessor guarded (hasUI, cwd and the live thinking level
 *    are all getters that THROW on a stale context).
 *
 * Residue, stated honestly: a restore that exhausts its wall-clock budget is
 * ABANDONED with a loud console warning and never repaired — the switched
 * value then persists globally exactly as it does today.
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
 * Retries are bounded by ELAPSED WALL-CLOCK TIME, not by attempt count: pi's
 * settings lock busy-waits SYNCHRONOUSLY, so an attempt's cost is set by
 * contention (~180 ms per contended acquisition × 5 acquisitions per attempt),
 * not by slate — a count-based bound would leave the stall unbounded. The
 * budget gates whether a NEW attempt starts; it cannot preempt an in-flight
 * spin, so the honest ceiling is the budget plus one attempt.
 */
const RESTORE_BUDGET_MS = 500;

/** The three global keys pi's model setter can write. */
interface GlobalDefaults {
	provider: string | undefined;
	model: string | undefined;
	thinkingLevel: ThinkingLevel | undefined;
}

/** What this switch SHOULD have produced (the second clause of the per-key rule). */
interface ExpectedValues {
	provider: string;
	model: string;
	/** The session's LIVE level after the switch; undefined = unreadable ⇒ that key is skipped. */
	thinkingLevel: ThinkingLevel | undefined;
}

/**
 * Decided per key, WRITTEN as pi writes: the pair together, the thinking level
 * on its own. A wrapper object (rather than a bare value) distinguishes "do not
 * write this key" from "write absence".
 */
interface RestorePlan {
	pair?: { provider: string | undefined; model: string | undefined };
	thinkingLevel?: { value: ThinkingLevel | undefined };
	/** Key names, for the failure report only. */
	keys: string[];
}

type ReadResult = { ok: true; values: GlobalDefaults } | { ok: false; reason: string };
type WriteResult = { ok: true } | { ok: false; reason: string };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// pi does not re-export SettingsError — derive the drained-channel shape.
function settingsErrorText(errors: ReturnType<SettingsManager["drainErrors"]>): string {
	return errors.map((e) => errorText(e.error)).join("; ");
}

/**
 * A MACROTASK yield, specified as such: `setTimeout` and never
 * queueMicrotask/Promise.resolve, which drain only as far as pi's write queue
 * has already progressed and miss the write entirely at queue depth ≥ 4. A
 * single macrotask yield is depth-independent.
 */
function macrotaskYield(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The same path pi's FileSettingsStorage computes for the global scope. */
function globalSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/**
 * Console-first and unconditional: the console line is the base channel — the
 * has-UI branch is exactly the branch that vanishes in headless runs and at
 * teardown, where a restore failure most needs to surface — and the UI
 * notification is the extra. Called directly rather than thrown, so the
 * catch-all in the surrounding handler (both call sites have one) cannot
 * swallow the report.
 */
function report(ctx: ExtensionContext, message: string): void {
	console.warn(message);
	try {
		// ctx.hasUI is a getter that THROWS on a stale context — an unguarded
		// check is a crash, not a test.
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
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
			return { ok: false, reason: `${path} is empty` };
		}
	} catch (error) {
		return { ok: false, reason: `${path} is unreadable — ${errorText(error)}` };
	}
	let manager: SettingsManager;
	try {
		// Throwaway reader, global scope only with project trust disabled (see
		// the module header): never reused, never reloaded, discarded below.
		manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
	} catch (error) {
		return { ok: false, reason: `cannot read ${path} — ${errorText(error)}` };
	}
	// Construction IS the read: a held lock, an unreadable file or a parse error
	// is RECORDED here rather than thrown, so the channel must be drained before
	// the values are trusted.
	const errors = manager.drainErrors();
	if (errors.length > 0) return { ok: false, reason: `cannot read ${path} — ${settingsErrorText(errors)}` };
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
 * The per-key rule. Returns undefined when no key diverges — the common case,
 * in which nothing at all is written.
 */
function planRestore(pre: GlobalDefaults, post: GlobalDefaults, expected: ExpectedValues): RestorePlan | undefined {
	const restoreProvider = post.provider !== pre.provider && post.provider === expected.provider;
	const restoreModel = post.model !== pre.model && post.model === expected.model;
	const restoreThinking =
		// undefined = the live level could not be read (stale ctx) ⇒ skip this
		// key; the pair's expectation does not depend on it.
		expected.thinkingLevel !== undefined &&
		post.thinkingLevel !== pre.thinkingLevel &&
		post.thinkingLevel === expected.thinkingLevel;
	if (!restoreProvider && !restoreModel && !restoreThinking) return undefined;
	const plan: RestorePlan = { keys: [] };
	if (restoreProvider || restoreModel) {
		// The DECISION is per key; the WRITE is not, for the pair: pi writes
		// defaultProvider and defaultModel only atomically, so restoring them
		// through two setters would produce an on-disk state pi itself cannot
		// produce, and a failed second write would make that incoherent pair
		// permanent. When only one half is being restored, the other half is
		// re-stated at its CURRENT on-disk value, so the pair stays coherent and
		// the untouched key keeps whatever someone else put there.
		plan.pair = {
			provider: restoreProvider ? pre.provider : post.provider,
			model: restoreModel ? pre.model : post.model,
		};
		if (restoreProvider) plan.keys.push("defaultProvider");
		if (restoreModel) plan.keys.push("defaultModel");
	}
	if (restoreThinking) {
		plan.thinkingLevel = { value: pre.thinkingLevel };
		plan.keys.push("defaultThinkingLevel");
	}
	return plan;
}

/** One write attempt: write, flush, drain, verify. */
async function applyRestore(cwd: string, plan: RestorePlan): Promise<WriteResult> {
	const path = globalSettingsPath();
	let manager: SettingsManager;
	try {
		manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
	} catch (error) {
		return { ok: false, reason: `cannot open ${path} for writing — ${errorText(error)}` };
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
		return { ok: false, reason: `cannot open ${path} for writing — ${settingsErrorText(loadErrors)}` };
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
	try {
		await manager.flush();
	} catch (error) {
		return { ok: false, reason: `writing ${path} failed — ${errorText(error)}` };
	}
	// Drained AFTER the flush, never before: pi RECORDS write failures here
	// instead of throwing or returning a status, and draining first would report
	// success on a write that has not been attempted yet.
	const writeErrors = manager.drainErrors();
	if (writeErrors.length > 0) return { ok: false, reason: `writing ${path} failed — ${settingsErrorText(writeErrors)}` };
	// Verify against a FRESH read: this manager's own accessor would serve the
	// object its setters just mutated, so a read-back through it is vacuous.
	const check = readGlobalDefaults(cwd);
	if (!check.ok) return { ok: false, reason: `cannot verify the restore — ${check.reason}` };
	if (plan.pair && (check.values.provider !== plan.pair.provider || check.values.model !== plan.pair.model)) {
		return { ok: false, reason: `${path} does not hold the restored defaultProvider/defaultModel` };
	}
	if (plan.thinkingLevel && check.values.thinkingLevel !== plan.thinkingLevel.value) {
		return { ok: false, reason: `${path} does not hold the restored defaultThinkingLevel` };
	}
	return { ok: true };
}

/** Steps after the switch: yield, expectation, per-key decision, write, verify, bounded retry. */
async function restoreAfterSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
	pre: GlobalDefaults,
	target: { provider: string; id: string },
): Promise<void> {
	// One macrotask yield: pi's write is queued, and the thinking-level setter
	// does not drain it (see the module header).
	await macrotaskYield();
	const live = readLiveThinkingLevel(pi);
	if (!live.ok) {
		// The accessor throws on a stale context: skip that ONE key and carry on —
		// provider and model are still evaluated and restored.
		report(
			ctx,
			`slate: not restoring the global defaultThinkingLevel — the session's live thinking level is unreadable (${live.reason}).`,
		);
	}
	const expected: ExpectedValues = {
		provider: target.provider,
		model: target.id,
		thinkingLevel: live.ok ? live.level : undefined,
	};
	const deadline = Date.now() + RESTORE_BUDGET_MS;
	let failure = "";
	for (;;) {
		// FIXED PRE, FRESH POST. The pre-switch reference above is captured once
		// and never re-read: a retry that re-read it would adopt a failed
		// attempt's partial write as "the pre-switch state" and faithfully
		// preserve the very leak it was invoked to remove. The post-switch state
		// is re-read on EVERY attempt: a cached one would revert a third-party
		// write that landed between attempts.
		const post = readGlobalDefaults(cwd);
		if (post.ok) {
			const plan = planRestore(pre, post.values, expected);
			if (!plan) return; // no key diverged ⇒ write nothing at all
			const outcome = await applyRestore(cwd, plan);
			if (outcome.ok) return;
			failure = `${outcome.reason} (keys: ${plan.keys.join(", ")})`;
		} else {
			// Unlike the pre-switch read, an inconclusive post-switch read is
			// RETRYABLE while the budget lasts — lock contention is exactly the
			// transient condition a retry exists for.
			failure = post.reason;
		}
		if (Date.now() >= deadline) break;
		await macrotaskYield();
	}
	report(
		ctx,
		`slate: could not restore the global model defaults within ${RESTORE_BUDGET_MS} ms — ${failure}. ` +
			`pi's model switch stays in ${globalSettingsPath()} and will apply to later sessions; slate will not retry.`,
	);
}

/**
 * Wrap ONE slate-initiated model switch so the user's global model defaults are
 * left as slate found them. `performSwitch` must contain every setter call of
 * that switch — the post-switch read has to follow the LAST write, since
 * adoption can persist the thinking-level key alone.
 *
 * Never throws and never alters what `performSwitch` returns: a restore failure
 * is reported, not propagated.
 */
export async function withGlobalModelDefaultRestored<T>(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: SlateConfig,
	target: { provider: string; id: string },
	performSwitch: () => Promise<T>,
): Promise<T> {
	// Lax, like slate's other boolean knobs: anything but an explicit false
	// leaves the restore on.
	if (config.preserveGlobalModelDefault === false) return performSwitch();
	const cwd = readCwd(ctx);
	if (cwd === undefined) {
		const result = await performSwitch();
		report(
			ctx,
			`slate: not restoring the global model defaults — the extension context is stale, so ${globalSettingsPath()} cannot be read.`,
		);
		return result;
	}
	const pre = readGlobalDefaults(cwd);
	if (!pre.ok) {
		// Stand down: switch, restore NOTHING, warn. A pre-switch read failure is
		// terminal rather than retryable — there is no trustworthy reference to
		// retry against — and acting on it could delete real settings.
		const result = await performSwitch();
		report(ctx, `slate: not restoring the global model defaults — ${pre.reason}.`);
		return result;
	}
	const result = await performSwitch();
	try {
		await restoreAfterSwitch(pi, ctx, cwd, pre.values, target);
	} catch (error) {
		// This mechanism must never unwind the switch handler that called it.
		report(ctx, `slate: restoring the global model defaults failed — ${errorText(error)}.`);
	}
	return result;
}
