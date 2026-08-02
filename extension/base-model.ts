/**
 * Orchestrator BASE MODEL tracker: the model the orchestrator would be running
 * if slate had never failed over.
 *
 * WHY IT EXISTS. A worker session's default model is the HOST session's CURRENT
 * model. After slate's own orchestrator failover (failover.ts) switches the host
 * to a fallback, that fallback silently becomes the default of every worker
 * opened afterwards — the opposite of the intent, since the fallback exists to
 * keep ONE failing turn alive, not to re-decide the model of every later
 * dispatch. This module records the orchestrator's model EXCLUDING
 * slate-initiated failover fallbacks; the dispatch side reads it instead of the
 * live model.
 *
 * ATTRIBUTION, and why it is done by DECLARATION. pi's model_select event carries
 * (model, previousModel, source) and nothing about who asked: a /model command,
 * the model selector and an extension's pi.setModel all arrive as source "set"
 * (agent-session's setModel emits "set" unconditionally; only the cycle
 * keybinding emits "cycle", and "restore" is declared in the SDK but emitted by
 * no shipped code). So a switch slate is about to make is DECLARED first, and the
 * event matching that declaration is the one switch that does not move the base.
 *
 * DECLARATION LIFETIME — THE SETTER'S OWN DURATION, NEVER A CLOCK (BG10).
 * A declaration is IN FLIGHT from the moment it is declared until the SETTER
 * SETTLES, and is then retired. `ownSwitch(from, to, perform)` is the only
 * sanctioned form: it declares, runs the setter, and retires the declaration in a
 * `finally`, so the lifetime is exactly the switch's own — however long that
 * takes. It takes as long as it takes: pi's setModel awaits a LIVE credential
 * check (network I/O for some providers) before it emits anything, so a
 * wall-clock bound is unusable. The previous shape used one — a 10 s TTL — and a
 * switch slower than the bound had its declaration pruned mid-flight, after which
 * slate's own fallback became the base with no warning at all. There is now NO
 * clock in this module.
 *
 * Retiring AT SETTLE is exact, not approximate: pi's setModel awaits
 * `_emitModelSelect`, which awaits `_extensionRunner.emit`, which awaits every
 * handler in turn — so by the time the extension-facing `pi.setModel()` promise
 * settles, any event that switch produces has ALREADY been delivered to this
 * module and handled. A settled switch can produce no further event.
 *
 * MATCHED WITHOUT BEING CONSUMED WHILE IN FLIGHT (CN1). While a declaration is in
 * flight, EVERY event landing on its target is attributed to slate, and the
 * declaration stays. Consuming on the first match was a defect: a user switch to
 * the same model, landing between the declaration and the setter, consumed the
 * declaration, and slate's own event then read as a user switch and moved the
 * base to the fallback — the non-conservative direction. An event landing on a
 * DIFFERENT model is an ordinary user switch and moves the base as usual, without
 * touching the declaration.
 *
 * MATCHING PREFERS the exact (previous, next) pair, then the target alone
 * (reported once per session), and an in-flight declaration over a settled one.
 * The pair can legitimately differ while the target cannot: a user switch landing
 * mid-flight changes previousModel under slate's feet (declared A⇒B, emitted
 * U⇒B), and two slate switches in flight chain (A⇒B then B⇒C). An event landing
 * on a model slate never named is NOT recognised — the base moves, which is the
 * honest reading, because that shape is indistinguishable from a user switch made
 * at the same instant.
 *
 * ONE-EVENT GRACE AFTER SETTLE. A declaration that settled WITHOUT ever being
 * matched (the setter threw before pi emitted; handoff's equality guard skipped
 * the setter; pi suppressed the emission because the pair was already equal) is
 * kept for exactly ONE further observed event, then dropped. That grace exists for
 * a future pi that emits model_select outside the setter — the event is still
 * attributed correctly and REPORTED once, instead of silently re-basing the
 * orchestrator onto a fallback. Every grace entry is dropped at the end of any
 * event that reached the matching stage, whether it matched or not; a "restore"
 * event and an unreadable payload are non-events and drop nothing.
 *
 * RESIDUALS, stated precisely and completely:
 *   · While a slate switch is IN FLIGHT, a user switch that lands on exactly
 *     slate's target does not move the base. The window is the true duration of
 *     the setter, not a clock, and the direction is conservative — workers keep
 *     the previous base rather than inheriting slate's fallback.
 *   · A settled-but-never-matched declaration can absorb at most the NEXT event,
 *     and only one landing on that same target.
 *   · There is NO converse residual any more: an interleaved user switch cannot
 *     consume a declaration, so slate's own event can no longer be mis-read as a
 *     user switch (the CN1 defect).
 *   · A declaration whose settle callback is never invoked stays in flight and
 *     keeps absorbing events for its target. `ownSwitch` makes that unreachable
 *     at the shipped sites (its `finally` always runs); a direct
 *     expectOwnSwitch() caller that ignores the returned callback is a defect,
 *     bounded only by MAX_PENDING, which evicts settled entries first and reports
 *     once when it has to evict a live one.
 *
 * PER-SOURCE RULES:
 *   · "set"     — the shared source of user commands, the selector and extension
 *                 calls: matched against declarations; moves the base when
 *                 nothing matches.
 *   · "cycle"   — the cycle keybinding. Slate never calls cycleModel, so a cycle
 *                 event ALWAYS moves the base and is never attributed to a
 *                 declaration (it does end the one-event grace, being a real
 *                 event).
 *   · "restore" — never moves the base (defensive) and drops nothing, and is
 *                 reported once: pi emits it nowhere today, so its appearance
 *                 means the semantics this module was written against changed.
 *   · anything else — treated as "set", reported once.
 *
 * DELIBERATELY UNLIKE model-default.ts. That module's first invariant is "NO
 * STATE OUTLIVES A SINGLE SWITCH", because a deferred settings repair can clobber
 * a later third-party write. This tracker is the opposite by necessity: a base
 * model is a session-long fact, read long after the switch that did not move it.
 * The two are not in tension — nothing here writes anything outside the process;
 * it only remembers, and every remembered declaration is bounded above.
 *
 * NOT PERSISTED, an ACCEPTED LIMITATION — and the full list of cases:
 * the tracker is in-session, in-memory state, so it is re-seeded from whatever
 * model the session is running at (a) a restart, (b) a resume, (c) a fork, and
 * (d) an in-session `/reload` — which tears down and rebuilds the extension
 * runtime (session_shutdown then session_start with reason "reload"), so the
 * factory runs again with fresh state while the live model stays whatever it was.
 * In every one of those cases, if slate had failed over shortly before, the
 * fallback becomes the base. Persisting the base would keep a "real" model alive
 * across sessions that the user can no longer see or change in pi's own UI, which
 * is worse; the recovery is one deliberate model switch, which re-bases the
 * tracker immediately.
 *
 * EFFORT IS OBSERVED, NOT TRACKED, AND HAS NO CONSUMER TODAY. currentEffort()
 * reports the thinking level seen alongside the base model at the last base move,
 * and undefined when it was unreadable. It is part of the cross-stream tracker
 * contract, and it stays for that reason and because it costs exactly one field:
 * this module runs NO mechanism of its own for it (no thinking_level_select
 * handler — attributing those would need a second declaration mechanism, since
 * slate's own switch re-clamps the level as a side effect and would poison the
 * record). A later effort change with no model switch is therefore NOT reflected.
 * The dispatch planner deliberately declines this value (route.ts: a worker's
 * effort is seeded from measured capability ladders, "never from the user's
 * global default"), so a consumer that wants the LIVE level must read
 * pi.getThinkingLevel() itself.
 *
 * OUTPUT INVARIANT: current() returns a CANONICAL "provider/id" or undefined —
 * never an unvalidated string. Every ingest validates with the shared spec
 * predicate before it can reach the base, so a consumer needs no re-validation
 * (threads.ts and route.ts re-validate anyway, at the module boundary they cross;
 * that is belt-and-braces, not a gap here). The INPUT side is deliberately
 * defensive in the same way for the opposite reason: the specs handed in come
 * from pi's registry, from a config map and — in handoff adoption — from a
 * pending-handoff FILE on disk, so none of them is trusted on its declared type.
 *
 * PURE, AND CLOCK-FREE. The tracker touches nothing: no pi, no filesystem, no
 * timers, no clock. It is a reducer over its ingest points (seed, observe,
 * expectOwnSwitch + its settle callback, adopt) plus a warn sink, so a harness can
 * drive every rule above with plain fabricated objects and no session — entry
 * point createBaseModelTracker({ warn }). The two pi-touching helpers
 * (readLiveEffort, currentModelSpec) sit OUTSIDE that reducer — the call sites
 * pass their results in — and each takes only the one member it reads, so they too
 * can be driven with fabricated objects.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./model-profiles.ts";
import { sanitizeForNotify } from "./notify.ts";
import { isModelSpec } from "./state.ts";

// ONE definition of the effort vocabulary (the CQ2 rule the model-spec helpers
// follow): the ladder union already exists in model-profiles.ts and the router
// consumes it from there, so this module re-exports it rather than adding a
// fourth copy. `import type` is erased, so no table is loaded at runtime.
export type { ThinkingLevel };

/**
 * How many declarations may be outstanding at once. Two is already pathological
 * (a failover firing during a handoff adoption); four leaves room for that plus a
 * settled one waiting out its one-event grace. It is the ONLY bound on a
 * declaration that is never settled — see the header's residual list.
 */
const MAX_PENDING = 4;

/**
 * The slice of pi's ModelSelectEvent this module reads, typed LOOSELY on purpose
 * (the state.ts pattern for values that cross a boundary slate does not own):
 * a harness fabricates these, and a future pi could add a source string or hand
 * back a model shape that is not the one declared today.
 */
export interface ModelSelectObservation {
	model?: unknown;
	previousModel?: unknown;
	source?: unknown;
}

/** One declared slate-initiated switch. */
interface Declaration {
	from: string | undefined;
	to: string;
	/** The setter has returned or thrown ⇒ no further event can belong to it (header). */
	settled: boolean;
	/** An event has already been attributed to it. */
	matched: boolean;
}

export interface BaseModelTracker {
	/**
	 * The orchestrator's base model as canonical "provider/id", excluding
	 * slate-initiated failover fallbacks; undefined when unresolvable. Never an
	 * unvalidated string (header, OUTPUT INVARIANT).
	 */
	current(): string | undefined;
	/** The thinking level observed alongside the base model; undefined when unknown. */
	currentEffort(): ThinkingLevel | undefined;
	/**
	 * Declare a slate-initiated switch, immediately BEFORE the setter, so the event
	 * it emits does not move the base.
	 *
	 * The returned callback MUST be invoked when the setter settles — it retires the
	 * declaration, which is what keeps a switch that emitted nothing from absorbing
	 * later user switches. It is idempotent and never throws. Prefer `ownSwitch`,
	 * which invokes it in a `finally` for you; this primitive is for a caller that
	 * cannot wrap its setter in a callback.
	 */
	expectOwnSwitch(from: string | undefined, to: string): () => void;
	/**
	 * Run ONE slate-initiated model switch under a declaration: declares (from, to),
	 * awaits `performSwitch`, and retires the declaration when it settles — on
	 * success, on `false`, and on a throw alike. Returns exactly what
	 * `performSwitch` returns and re-throws its error unchanged; the tracker itself
	 * never throws. This is the sanctioned form at every slate switch site.
	 */
	ownSwitch<T>(from: string | undefined, to: string, performSwitch: () => Promise<T>): Promise<T>;
	/** Called after a handoff adoption SUCCEEDS, to deliberately re-seed the base. */
	adopt(model: string, effort?: ThinkingLevel): void;
	/**
	 * Session-start seed. Takes the session's model as pi hands it over — a Model
	 * object, or a canonical "provider/id" string — so ABSENCE ("no model, or none
	 * this session has auth for", which is silent) stays distinguishable from an
	 * UNUSABLE value (reported once). Called once per session, before any observe().
	 */
	seed(model: unknown, effort?: ThinkingLevel): void;
	/**
	 * Ingest ONE pi model_select event, with the thinking level read alongside it
	 * (undefined = unreadable). This is the whole decision rule; everything else on
	 * this interface only declares or seeds.
	 */
	observe(event: ModelSelectObservation, effort?: ThinkingLevel): void;
}

/**
 * Canonical "provider/id" for a pi Model-like value, or undefined when it is not
 * one. Validated with the shared spec predicate (state.ts), so a provider or id
 * carrying whitespace or invisible characters is rejected here rather than
 * recorded as a model name that renders like a real one. This is the module's
 * canonicalisation vocabulary: currentModelSpec below, the session seed and the
 * event ingest all decide "usable model or not" here and nowhere else.
 */
export function modelSpecOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const model = value as { provider?: unknown; id?: unknown };
	if (typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
	const spec = `${model.provider}/${model.id}`;
	return isModelSpec(spec) ? spec : undefined;
}

/**
 * Canonical spec of the session's CURRENT model, read FRESH and guarded: ctx.model
 * is a getter that THROWS on a stale extension context. Both switch sites declare
 * their `from` through this, so the declared previous model is the live one at the
 * setter rather than one captured several awaits earlier.
 */
export function currentModelSpec(ctx: Pick<ExtensionContext, "model">): string | undefined {
	try {
		return modelSpecOf(ctx.model);
	} catch {
		return undefined;
	}
}

/**
 * The session's LIVE thinking level, guarded: the accessor is a getter that
 * THROWS on a stale extension context (model-default.ts documents the same
 * hazard). undefined = unknown, which currentEffort() then reports honestly
 * instead of guessing a level. Takes only the one method it calls, so a harness
 * can pass a fabricated object.
 */
export function readLiveEffort(pi: Pick<ExtensionAPI, "getThinkingLevel">): ThinkingLevel | undefined {
	try {
		return pi.getThinkingLevel();
	} catch {
		return undefined;
	}
}

/** Display form for a value of any type (JSON.stringify returns the VALUE undefined for undefined). */
function describeValue(value: unknown): string {
	if (typeof value === "string") return sanitizeForNotify(JSON.stringify(value));
	try {
		return sanitizeForNotify(JSON.stringify(value) ?? String(value));
	} catch {
		return `a ${typeof value}`;
	}
}

/** Display form for a possibly absent model spec. */
function describeSpec(spec: string | undefined): string {
	return spec === undefined ? "none" : sanitizeForNotify(spec);
}

/**
 * Build a tracker. `warn` is the host warn channel of the session_start site
 * (ctx.ui.notify when there is a UI, console.warn otherwise). There is no clock
 * dependency: no rule in here depends on time (header, BG10).
 */
export function createBaseModelTracker(deps: { warn: (msg: string) => void }): BaseModelTracker {
	let base: string | undefined;
	let baseEffort: ThinkingLevel | undefined;
	/** Declarations, oldest first: in flight (settled === false) or in their one-event grace. */
	const pending: Declaration[] = [];
	const reported = new Set<string>();

	/**
	 * At most ONE report per genuinely surprising condition per session, and never
	 * a throw: the host channel reaches ctx.hasUI/ctx.ui, which throw on a stale
	 * context, and every ingest below is called from inside a switch handler whose
	 * catch would misread the throw as a failed switch.
	 */
	const warnOnce = (key: string, message: string): void => {
		if (reported.has(key)) return;
		reported.add(key);
		try {
			deps.warn(message);
		} catch {
			/* stale host channel — no diagnostic here is worth unwinding a model switch */
		}
	};

	/**
	 * Make room for one more declaration. A SETTLED entry goes first and silently:
	 * it was already living on borrowed time (one event) and no switch is waiting on
	 * it. Only evicting a LIVE, in-flight declaration is worth a report — that one
	 * means a slate switch will be read as a user switch when its event arrives.
	 */
	const evictIfFull = (): void => {
		if (pending.length < MAX_PENDING) return;
		const settledIndex = pending.findIndex((d) => d.settled);
		if (settledIndex >= 0) {
			pending.splice(settledIndex, 1);
			return;
		}
		pending.shift();
		warnOnce(
			"overflow",
			`slate: more than ${MAX_PENDING} slate-initiated model switches are outstanding at once — dropping the oldest, ` +
				"still in flight; a fallback model may be recorded as the orchestrator's base model for new worker threads",
		);
	};

	/**
	 * The declaration an event belongs to, or undefined. Ranking, highest first:
	 * exact pair + in flight, exact pair + settled, target only + in flight, target
	 * only + settled; ties go to the OLDEST. The target is the load-bearing half
	 * (header): `previousModel` can legitimately differ from what was declared.
	 */
	const findMatch = (previous: string | undefined, next: string): Declaration | undefined => {
		let best: Declaration | undefined;
		let bestRank = -1;
		for (const declaration of pending) {
			if (declaration.to !== next) continue;
			const rank = (declaration.from === previous ? 2 : 0) + (declaration.settled ? 0 : 1);
			if (rank > bestRank) {
				best = declaration;
				bestRank = rank;
			}
		}
		return best;
	};

	/** Drop every settled declaration — the one-event grace bound (header). */
	const dropSettled = (): void => {
		// `!`: the index comes from this loop's own bound, so it is in range. Erased at
		// run time, unlike a guard for a case that cannot occur.
		for (let i = pending.length - 1; i >= 0; i--) {
			if (pending[i]!.settled) pending.splice(i, 1);
		}
	};

	const seed = (model: unknown, effort?: ThinkingLevel): void => {
		// ABSENCE is legitimate and SILENT: a session with no model, or none it has
		// auth for, resolves nothing — dispatch then falls back to whatever it did
		// before this tracker existed. It reaches here as undefined/null, which is why
		// the caller hands over pi's own value rather than a pre-canonicalised one: a
		// canonicalising caller would collapse "no model" and "unusable model" into
		// the same undefined and this module's diagnostic could never fire (BG13).
		if (model === undefined || model === null) {
			base = undefined;
			baseEffort = undefined;
			return;
		}
		const spec = typeof model === "string" ? (isModelSpec(model) ? model : undefined) : modelSpecOf(model);
		if (spec === undefined) {
			warnOnce(
				"seed",
				`slate: ignoring an unusable session model ${describeValue(model)} — new worker threads will use pi's own default model`,
			);
			base = undefined;
			baseEffort = undefined;
			return;
		}
		base = spec;
		baseEffort = effort;
	};

	const expectOwnSwitch = (from: string | undefined, to: string): (() => void) => {
		if (!isModelSpec(to)) {
			// Without a usable target the declaration cannot match anything, and slate's
			// own switch would then move the base — say so once, and hand back a no-op so
			// the caller's `finally` stays uniform.
			warnOnce(
				"declaration",
				`slate: ignoring an unusable declared model-switch target ${describeValue(to)} — slate's own switch to it ` +
					"would be recorded as the orchestrator's base model for new worker threads",
			);
			return () => {};
		}
		evictIfFull();
		// A non-canonical `from` is stored as absent rather than as a value no event
		// can ever equal: the target-only rule then still recognises the switch, with
		// its one report.
		const declaration: Declaration = { from: isModelSpec(from) ? from : undefined, to, settled: false, matched: false };
		pending.push(declaration);
		let done = false;
		return () => {
			if (done) return; // idempotent: a caller may settle in both a branch and a finally
			done = true;
			const index = pending.indexOf(declaration);
			if (index < 0) return; // already evicted, or cleared by adopt()
			// Its event arrived ⇒ retire it now. It never arrived ⇒ one-event grace, for
			// a future pi that emits outside the setter (header).
			if (declaration.matched) pending.splice(index, 1);
			else declaration.settled = true;
		};
	};

	// A generic FUNCTION, not an arrow in the object literal below: the type
	// parameter belongs to this member, so it has to be declared where the member is
	// implemented in order to pass the setter's own return type through unchanged.
	async function ownSwitch<T>(from: string | undefined, to: string, performSwitch: () => Promise<T>): Promise<T> {
		const settle = expectOwnSwitch(from, to);
		try {
			return await performSwitch();
		} finally {
			// A `finally` — so a throwing or false-returning setter cannot leave the
			// declaration in flight — and never a `return` inside it, which would swallow
			// the caller's result or error.
			settle();
		}
	}

	return {
		current: () => base,
		currentEffort: () => baseEffort,
		seed,
		expectOwnSwitch,

		ownSwitch,

		adopt: (model, effort) => {
			if (!isModelSpec(model)) {
				warnOnce(
					"adopt",
					`slate: ignoring an unusable adopted model ${describeValue(model)} — the orchestrator's base model for new ` +
						"worker threads is unchanged",
				);
				return;
			}
			// The adoption's OWN declaration is moot now, so drop every declaration for
			// THIS target, in flight or settled: handoff's equality guard can skip the
			// setter entirely, and that declaration would otherwise absorb a later user
			// switch to the same model. Declarations for other targets are left alone —
			// a failover switch in flight must still be recognised when its event
			// arrives. Their settle callbacks become no-ops.
			// `!` as in dropSettled: the index is this loop's own bound.
			for (let i = pending.length - 1; i >= 0; i--) {
				if (pending[i]!.to === model) pending.splice(i, 1);
			}
			base = model;
			baseEffort = effort;
		},

		observe: (event, effort) => {
			const next = modelSpecOf(event?.model);
			if (next === undefined) {
				// No usable target ⇒ nothing can be decided: it moves no base, ends no
				// grace, and consumes no declaration.
				warnOnce(
					"unusable-event",
					"slate: ignoring a model switch pi reported without a usable provider/id — the orchestrator's base model for " +
						"new worker threads may now be out of date",
				);
				return;
			}
			const previous = modelSpecOf(event?.previousModel);
			const source = typeof event?.source === "string" ? event.source : "";
			if (source === "restore") {
				// Declared in pi's SDK, emitted by nothing shipped: treat it as no event at
				// all, and say so once — its appearance means pi's semantics moved.
				warnOnce(
					"restore",
					`slate: ignoring a "restore"-sourced model switch to ${sanitizeForNotify(next)} — pi emits that source nowhere ` +
						"today, so slate is not treating it as a change of the orchestrator's base model",
				);
				return;
			}
			let ownSwitchEvent = false;
			if (source !== "cycle") {
				if (source !== "set") {
					warnOnce(
						"source",
						`slate: unrecognised model_select source ${describeValue(event?.source)} — treating the switch to ` +
							`${sanitizeForNotify(next)} as a user switch of the orchestrator's base model`,
					);
				}
				// "set" (and anything unknown) is the only source slate itself can produce,
				// so it is the only one matched against declarations.
				const match = findMatch(previous, next);
				if (match) {
					ownSwitchEvent = true;
					// Marked, NOT consumed: while the switch is in flight every event on its
					// target is slate's (CN1). The mark is what tells settle() to retire it
					// rather than grant it the one-event grace.
					match.matched = true;
					if (match.from !== previous) {
						warnOnce(
							"unexpected-previous",
							`slate: a slate-initiated model switch to ${sanitizeForNotify(next)} arrived with an unexpected previous ` +
								`model (declared ${describeSpec(match.from)}, reported ${describeSpec(previous)}) — treating it as ` +
								"slate's own, so the orchestrator's base model for new worker threads is unchanged",
						);
					}
					if (match.settled) {
						warnOnce(
							"late-emission",
							`slate: pi reported a model switch to ${sanitizeForNotify(next)} AFTER slate's own setter had already ` +
								"returned — slate still recognised it as its own, but this module was written against an event emitted " +
								"inside the setter, so pi's model-switch semantics appear to have changed",
						);
					}
				}
			}
			// The one-event grace bound (header): every settled declaration is dropped at
			// the end of any event that reached the matching stage — including the one
			// just matched, and including a "cycle" event, which is a real user action.
			dropSettled();
			if (ownSwitchEvent) return;
			base = next;
			baseEffort = effort;
		},
	};
}
