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
 * ATTRIBUTION, and why it is done by PAIR-MATCHING. pi's model_select event
 * carries (model, previousModel, source) and nothing about who asked: a /model
 * command, the model selector and an extension's pi.setModel all arrive as
 * source "set" (agent-session's setModel emits "set" unconditionally; only the
 * cycle keybinding emits "cycle", and "restore" is declared in the SDK but
 * emitted by no shipped code). So a switch slate is about to make is DECLARED
 * first — expectOwnSwitch(from, to), immediately before the setter — and the
 * event matching that declaration is the one switch that does not move the base.
 * NEVER a bare in-progress flag: pi.setModel can THROW (its live auth check
 * does, despite the Promise<boolean> contract), and a flag armed before a
 * throwing switch stays armed for the rest of the session, swallowing every
 * later genuine user switch.
 *
 * MATCHING IS TARGET-FIRST, THEN THE PAIR. An exact (previous, next) match wins.
 * Failing that, an event whose NEXT model is a declared target still counts as
 * slate's own (reported once per session), because the PAIR can legitimately
 * differ while the target cannot: a user switch landing between the declaration
 * and the setter changes previousModel under slate's feet (declared A⇒B, emitted
 * U⇒B), and two slate switches in flight chain (A⇒B then B⇒C). An event landing
 * on a model slate never named is NOT recognised — the base then moves, which is
 * the honest reading, because that shape is indistinguishable from a user switch
 * made at the same instant.
 *
 * PER-SOURCE RULES:
 *   · "set"     — the shared source of user commands, the selector and extension
 *                 calls: matched against declarations; moves the base when
 *                 nothing matches.
 *   · "cycle"   — the cycle keybinding. Slate never calls cycleModel, so a cycle
 *                 event ALWAYS moves the base and never consumes a declaration.
 *   · "restore" — never moves the base (defensive), and reported once: pi emits
 *                 it nowhere today, so its appearance means the semantics this
 *                 module was written against changed.
 *   · anything else — treated as "set", reported once.
 *
 * BOUNDED CONSUMPTION OF A DECLARATION. pi emits model_select from INSIDE
 * setModel, awaited before the setter returns, so a legitimate declaration is
 * matched within the same event-loop turn — milliseconds. Two bounds keep an
 * UNMATCHED declaration (a setter that threw before pi emitted; handoff's
 * equality guard skipping the setter; pi suppressing the event because the pair
 * was already equal) from suppressing a later genuine user switch:
 *   · it is consumed by the FIRST event that matches it, and never matched twice;
 *   · it EXPIRES after DECLARATION_TTL_MS, judged on a monotonic clock at the
 *     next declaration or event — no timer, so nothing can fire after teardown —
 *     and at most MAX_PENDING declarations are held at once, the oldest dropped
 *     with one warning rather than growing an unbounded queue.
 * RESIDUAL, stated plainly: a USER switch requesting exactly the pair slate just
 * declared but failed to perform, inside the TTL window, is mistaken for slate's
 * own and does not move the base. It is bounded three ways (one event, one TTL
 * window, exact target identity) and fails in the conservative direction —
 * workers keep defaulting to the previous base rather than inheriting a model
 * slate itself could not switch to.
 *
 * DELIBERATELY UNLIKE model-default.ts. That module's first invariant is "NO
 * STATE OUTLIVES A SINGLE SWITCH", because a deferred settings repair can clobber
 * a later third-party write. This tracker is the opposite by necessity: a base
 * model is a session-long fact, read long after the switch that did not move it.
 * The two are not in tension — nothing here writes anything outside the process;
 * it only remembers, and every remembered declaration is bounded above.
 *
 * NOT PERSISTED, an ACCEPTED LIMITATION. The tracker is in-session state only.
 * A restart, resume or fork seeds the base from whatever model the restored
 * session runs, so if slate failed over shortly before, the fallback becomes the
 * base. Persisting it would keep a "real" model alive across sessions that the
 * user can no longer see in pi's own UI, which is worse; a user who does not want
 * the fallback switches models once and the base follows.
 *
 * EFFORT IS OBSERVED, NOT TRACKED. currentEffort() reports the thinking level
 * seen alongside the base model at the last base move, and undefined when it was
 * unreadable. A later effort change with no model switch (the thinking-level
 * keybinding) is NOT reflected: attributing thinking_level_select would need its
 * own declaration mechanism, since slate's own failover switch re-clamps the
 * level as a side effect and would poison the record. A consumer that needs the
 * LIVE level must read pi.getThinkingLevel() itself.
 *
 * PURE. The TRACKER touches nothing: no pi, no filesystem, no clock other than
 * the injected one. It is a reducer over its four ingest points (seed, observe,
 * expectOwnSwitch, adopt) plus a warn sink, so a harness can drive every rule
 * above with plain fabricated objects and no session — entry point
 * createBaseModelTracker({ warn, now }). The one pi-touching helper,
 * readLiveEffort, is deliberately OUTSIDE that reducer (the call sites pass its
 * result in), and takes only the single method it calls so it too can be driven
 * with a fabricated object.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./model-profiles.ts";
import { sanitizeForNotify } from "./notify.ts";
import { isModelSpec } from "./state.ts";

// ONE definition of the effort vocabulary (the CQ2 rule the model-spec helpers
// follow): the ladder union already exists in model-profiles.ts and the router
// consumes it from there, so this module re-exports it rather than adding a
// fourth copy. `import type` is erased, so no table is loaded at runtime.
export type { ThinkingLevel };

/**
 * How long an unmatched declaration stays live. The matching event is emitted
 * synchronously inside pi's setter, so this is three orders of magnitude more
 * than the mechanism needs — it is a leak bound, not a timeout.
 */
const DECLARATION_TTL_MS = 10_000;

/**
 * How many declarations may be outstanding at once. Two is already pathological
 * (a failover firing during a handoff adoption); four leaves room for that plus
 * a stuck one waiting out its TTL, and refuses to grow further.
 */
const MAX_PENDING = 4;

/** MONOTONIC clock: unlike Date.now() it cannot jump (NTP step, DST, manual set) — model-default.ts needs the same. */
function nowMs(): number {
	return performance.now();
}

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

/** One declared slate-initiated switch, awaiting its event. */
interface Declaration {
	from: string | undefined;
	to: string;
	at: number;
}

export interface BaseModelTracker {
	/** the orchestrator's base model as canonical "provider/id", excluding slate-initiated failover fallbacks; undefined when unresolvable */
	current(): string | undefined;
	/** the thinking level observed alongside the base model; undefined when unknown */
	currentEffort(): ThinkingLevel | undefined;
	/** called immediately BEFORE slate switches the orchestrator itself, so the resulting event does not move the base */
	expectOwnSwitch(from: string | undefined, to: string): void;
	/** called after a handoff adoption SUCCEEDS, to deliberately re-seed the base */
	adopt(model: string, effort?: ThinkingLevel): void;
	/**
	 * Session-start seed from the session's own resolved model. undefined is
	 * legitimate and silent (no model, or no auth for one). Called once per
	 * session, before any observe().
	 */
	seed(model: string | undefined, effort?: ThinkingLevel): void;
	/**
	 * Ingest ONE pi model_select event, with the thinking level read alongside it
	 * (undefined = unreadable). This is the whole decision rule; everything else
	 * on this interface only declares or seeds.
	 */
	observe(event: ModelSelectObservation, effort?: ThinkingLevel): void;
}

/**
 * Canonical "provider/id" for a pi Model-like value, or undefined when it is not
 * one. Validated with the shared spec predicate (state.ts), so a provider or id
 * carrying whitespace or invisible characters is rejected here rather than
 * recorded as a model name that renders like a real one.
 */
export function modelSpecOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const model = value as { provider?: unknown; id?: unknown };
	if (typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
	const spec = `${model.provider}/${model.id}`;
	return isModelSpec(spec) ? spec : undefined;
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

/** Display form for a source value of any type (JSON.stringify returns the VALUE undefined for undefined). */
function describeSource(source: unknown): string {
	if (typeof source === "string") return sanitizeForNotify(JSON.stringify(source));
	try {
		return sanitizeForNotify(JSON.stringify(source) ?? String(source));
	} catch {
		return `a ${typeof source}`;
	}
}

/** Display form for a possibly absent model spec. */
function describeSpec(spec: string | undefined): string {
	return spec === undefined ? "none" : sanitizeForNotify(spec);
}

/**
 * Build a tracker. `warn` is the host warn channel of the session_start site
 * (ctx.ui.notify when there is a UI, console.warn otherwise); `now` exists only
 * so a harness can drive the TTL rule without sleeping — production passes just
 * `warn`.
 */
export function createBaseModelTracker(deps: { warn: (msg: string) => void; now?: () => number }): BaseModelTracker {
	const now = deps.now ?? nowMs;
	let base: string | undefined;
	let baseEffort: ThinkingLevel | undefined;
	const pending: Declaration[] = [];
	const reported = new Set<string>();

	/**
	 * At most ONE report per genuinely surprising condition per session, and never
	 * a throw: the host channel reaches ctx.hasUI/ctx.ui, which throw on a stale
	 * context, and expectOwnSwitch/adopt are called from inside a switch handler
	 * whose catch would misread the throw as a failed switch.
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

	/** Drop declarations past their TTL. Called at every ingest; entries are in declaration order. */
	const prune = (): void => {
		const cutoff = now() - DECLARATION_TTL_MS;
		while (pending.length > 0 && pending[0].at <= cutoff) pending.shift();
	};

	/** Consume the declaration this event satisfies, if any: exact pair first, then target-only. */
	const consumeMatch = (previous: string | undefined, next: string): Declaration | undefined => {
		const exact = pending.findIndex((d) => d.to === next && d.from === previous);
		const index = exact >= 0 ? exact : pending.findIndex((d) => d.to === next);
		if (index < 0) return undefined;
		const [declared] = pending.splice(index, 1);
		if (exact < 0) {
			warnOnce(
				"unexpected-previous",
				`slate: a slate-initiated model switch to ${sanitizeForNotify(next)} arrived with an unexpected previous model ` +
					`(declared ${describeSpec(declared.from)}, reported ${describeSpec(previous)}) — treating it as slate's own, ` +
					"so the orchestrator's base model for new worker threads is unchanged",
			);
		}
		return declared;
	};

	return {
		current: () => base,
		currentEffort: () => baseEffort,

		seed: (model, effort) => {
			// undefined is legitimate and SILENT: a session with no model, or none it
			// has auth for, resolves nothing — dispatch then falls back to whatever it
			// did before this tracker existed.
			if (model === undefined) {
				base = undefined;
				baseEffort = undefined;
				return;
			}
			if (!isModelSpec(model)) {
				warnOnce(
					"seed",
					`slate: ignoring an unusable session model ${describeSource(model)} — new worker threads will use pi's own default model`,
				);
				base = undefined;
				baseEffort = undefined;
				return;
			}
			base = model;
			baseEffort = effort;
		},

		expectOwnSwitch: (from, to) => {
			prune();
			if (!isModelSpec(to)) {
				// Without a usable target the declaration cannot match anything, and
				// slate's own switch would then move the base — say so once.
				warnOnce(
					"declaration",
					`slate: ignoring an unusable declared model-switch target ${describeSource(to)} — slate's own switch to it ` +
						"would be recorded as the orchestrator's base model for new worker threads",
				);
				return;
			}
			if (pending.length >= MAX_PENDING) {
				pending.shift();
				warnOnce(
					"overflow",
					`slate: more than ${MAX_PENDING} slate-initiated model switches are outstanding at once — dropping the oldest ` +
						"declaration; a fallback model may be recorded as the orchestrator's base model for new worker threads",
				);
			}
			// A non-canonical `from` is stored as absent rather than as a value no
			// event can ever equal: the target-only rule then still recognises the
			// switch, with its one report.
			pending.push({ from: isModelSpec(from) ? from : undefined, to, at: now() });
		},

		adopt: (model, effort) => {
			prune();
			if (!isModelSpec(model)) {
				warnOnce(
					"adopt",
					`slate: ignoring an unusable adopted model ${describeSource(model)} — the orchestrator's base model for new ` +
						"worker threads is unchanged",
				);
				return;
			}
			// The adoption's OWN declaration is moot now, so consume every outstanding
			// declaration for THIS target: handoff's equality guard can skip the setter
			// entirely, and that declaration would otherwise sit unmatched until its
			// TTL and swallow a user switch to the same model. Declarations for other
			// targets are left alone — a failover switch in flight must still be
			// recognised when its event arrives.
			for (let i = pending.length - 1; i >= 0; i--) {
				if (pending[i].to === model) pending.splice(i, 1);
			}
			base = model;
			baseEffort = effort;
		},

		observe: (event, effort) => {
			prune();
			const next = modelSpecOf(event?.model);
			if (next === undefined) {
				// No usable target ⇒ nothing can be decided: neither move the base nor
				// consume a declaration.
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
				// Declared in the SDK, emitted by nothing shipped: treat it as no change
				// at all, and say so once — its appearance means pi's semantics moved.
				warnOnce(
					"restore",
					`slate: ignoring a "restore"-sourced model switch to ${sanitizeForNotify(next)} — pi emits that source nowhere ` +
						"today, so slate is not treating it as a change of the orchestrator's base model",
				);
				return;
			}
			if (source !== "cycle") {
				if (source !== "set") {
					warnOnce(
						"source",
						`slate: unrecognised model_select source ${describeSource(event?.source)} — treating the switch to ` +
							`${sanitizeForNotify(next)} as a user switch of the orchestrator's base model`,
					);
				}
				// "set" (and anything unknown) is the only source slate itself can
				// produce, so it is the only one matched against declarations.
				if (consumeMatch(previous, next)) return;
			}
			base = next;
			baseEffort = effort;
		},
	};
}
