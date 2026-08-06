/**
 * Thread choice: WHETHER one dispatched action continues an existing worker
 * thread or runs in a FRESH thread seeded with named episodes.
 *
 * PURE, INJECTED — the discipline route.ts follows, and for the same reason. A
 * thread choice destroys or preserves a cached request prefix worth up to
 * twenty-two times the price of the alternative, and a planner that silently
 * stops planning still "works": the dispatch runs, an episode is written, and
 * nothing reports a wrong verdict. So every environment fact arrives as a
 * parameter — INCLUDING THE CURRENT TIME (`now`) — and every answer is a value.
 * Nothing here reads a clock, a file, the network, pi's model registry, the
 * process environment or a random source, so the whole decision is exercisable
 * against fabricated in-memory inputs.
 *
 * A VERDICT IS A RETURN VALUE, never a throw and never a boolean. Four kinds,
 * and the kind is the whole instruction to the caller:
 *
 *   continue — run the action on the existing thread.
 *   fresh    — open a new thread and seed it with the named episodes.
 *   abstain  — the inputs cannot support a decision. The caller decides, and it
 *              must not read an abstention as either answer.
 *   refused  — a RULE forbids a fresh thread, whatever the economics say. The
 *              caller may not open one, and the reason names the rule.
 *
 * Every verdict carries a `code` for a machine and a `reason` for a person. The
 * reason is renderable with no further lookup: it names the thread, the money,
 * the turn counts and the warmth evidence it used.
 *
 * THE ORDER OF DECISION, and the order is load-bearing:
 *
 *   1. UNUSABLE INPUT — no action at all, or a named episode that cannot be
 *      checked because no episode index was supplied. Abstain.
 *   2. REFUSALS. They outrank every later step, because no price makes a
 *      forbidden thread permissible.
 *   3. NO SOURCE THREAD — there is nothing to continue, so the answer is fresh
 *      and no arithmetic is needed.
 *   4. WARMTH — measured, never assumed (see classifyPrefixWarmth).
 *   5. THE TWO-TURN GUARD — work of at most two turns continues, because the
 *      measured setup cost of a fresh thread does not recover over that span.
 *   6. THE ARITHMETIC — price both arms over the whole work stream and take the
 *      cheaper one. A TIE continues: see UNCERTAINTY below.
 *
 * THE ARITHMETIC, and each of these four rules corrects a mistake an earlier
 * design shipped:
 *
 *   · THE THREE TOKEN BUCKETS ARE DISJOINT. A provider bills input, cache read
 *     and cache write separately, and a reported input count already EXCLUDES
 *     the cached and the written tokens. So a token is priced ONCE here: as a
 *     cache read, or as a fresh token, and never as both. Adding a cache-write
 *     charge on top of the same tokens counted as input double-charges the
 *     largest term in the comparison.
 *   · THE LONG-CONTEXT MULTIPLIER APPLIES TO BOTH ARMS, and its threshold is
 *     keyed on the SUM of the three buckets of ONE request. A warm continuation
 *     carries a large prefix into that sum, so it can cross the threshold on a
 *     turn where a fresh thread does not. Pricing the cliff for one arm only
 *     hides exactly that case.
 *   · A WORK STREAM IS PRICED, NOT ONE REQUEST. The setup cost of a fresh
 *     thread is amortised over the expected turn count, and that count defaults
 *     to DEFAULT_EXPECTED_TURNS — the same two-turn guard the shipped evidence
 *     document draws from its cost grids.
 *   · AN ABSENT OR ZERO CACHE-WRITE PRICE IS LEGITIMATE AND COMMON. It records
 *     a write premium of zero, not missing data, so it never causes an
 *     abstention. It also never prices a rewritten prefix at nothing: a fresh
 *     token with no write premium bills at the model's INPUT rate, which is
 *     what the provider charges for it. See resolveTokenRates.
 *
 * UNCERTAINTY NEVER DESTROYS A WARM THREAD. A false cold estimate prices
 * continuation at up to twenty-two times its true cost, while a false warm
 * estimate costs one rewritten prefix. The two errors are not symmetric, so
 * every unreadable input resolves toward continuation: an unknown previous
 * model or effort is not a route change, an unknown elapsed time is not an
 * expiry, a model with no retention data at all is WARM, and an exact tie in
 * the arithmetic continues. Where continuation cannot be priced at all, this
 * module abstains rather than guessing in either direction.
 *
 * WHAT THIS MODULE DOES NOT DECIDE. Thread separation is a semantic boundary
 * before it is a cost choice: an action that begins a NEW work stream belongs
 * in a new thread whatever the arithmetic says, and that judgement stays with
 * the orchestrator, which is the only party that knows the work. A caller
 * expressing that judgement passes no source thread, and step 3 answers fresh.
 */

import type { ThinkingLevel } from "./model-profiles.ts";
import { sanitizeForNotify } from "./notify.ts";

/**
 * Turns assumed when the caller estimates none. Two is the shipped evidence
 * document's guard: its cost grids place one- and two-turn work on the
 * continuation side, so an absent estimate resolves toward continuation.
 */
export const DEFAULT_EXPECTED_TURNS = 2;

/** Work of at most this many turns continues without pricing (the two-turn guard). */
export const SHORT_WORK_TURNS = 2;

/**
 * Turns charged to a FRESH thread for rediscovery. The measured difference was
 * one extra tool call on a fresh arm that already held durable episode context,
 * expressed as approximately one turn. It is a charge, not a constant of nature.
 */
export const DEFAULT_REDISCOVERY_TURNS = 1;

/** Context tokens one turn adds, from the shipped cost-grid parameters. */
export const DEFAULT_GROWTH_TOKENS_PER_TURN = 3500;

/** Output tokens one turn bills, from the shipped cost-grid parameters. */
export const DEFAULT_OUTPUT_TOKENS_PER_TURN = 600;

/**
 * The pricing loop runs once per turn, so a caller's turn estimate bounds the
 * work this module does. A malformed or absurd estimate is CLAMPED here rather
 * than trusted: the verdict reports the clamp, and the loop stays bounded.
 */
export const MAX_PRICED_TURNS = 100;

/** The slice of a thread record this module reads. ThreadRecord satisfies it structurally. */
export interface ThreadChoiceThread {
	id: string;
	/**
	 * The thread's effective built-in worker tool allowlist. ABSENT means an older
	 * record whose tools were never written down, which is a refusal below and not
	 * a value to guess: a replacement thread built from today's configuration
	 * default may hold a different tool set than the work already done.
	 */
	tools?: readonly string[];
}

/**
 * What the PREVIOUS dispatch on that thread ran on and measured. EpisodeRecord
 * satisfies it structurally, so a caller passes the thread's last episode.
 *
 * Every field may be absent, because a provider reports each quantity at its own
 * discretion and an unversioned snapshot may predate the field. Absent is
 * ALWAYS "unknown" here and never zero — the distinction decides warmth, since a
 * REPORTED cache read of zero is measured evidence of a cold prefix while an
 * absent one is no evidence at all.
 */
export interface ThreadChoiceLastDispatch {
	/** "failed" refuses a fresh replacement thread (see the refusal table). */
	status?: "ok" | "failed";
	/** "provider/id" the dispatch actually ran on, post-failover. */
	model?: string;
	/** Effort level the dispatch actually ran at, post-clamp. */
	effort?: ThinkingLevel;
	/** Reported prompt-cache read tokens. A reported ZERO is evidence of a cold prefix. */
	cacheRead?: number;
	/** Reported prompt-cache write tokens. Carried for the caller's reporting only. */
	cacheWrite?: number;
	/** Final reported worker context tokens — the size of the prefix a continuation reuses. */
	contextTokens?: number;
	/** Milliseconds since the epoch at which that dispatch's record was written. */
	createdAt?: number;
}

/**
 * One model's cache-retention evidence, as the shipped profile table records it.
 * A caller maps a profile's `cacheRetention` onto this shape; the module reads no
 * table of its own.
 */
export interface ThreadChoiceRetention {
	/** The provider's documented cache lifetime, in seconds. */
	documentedSeconds?: number;
	/**
	 * The longest gap at which a local probe still measured a warm prefix, in
	 * seconds. It EXTENDS the documented window when it is longer, because a
	 * measurement of warmth outranks a documented minimum.
	 */
	measuredWarmSeconds?: number;
}

/** The action being placed. */
export interface ThreadChoiceAction {
	/** "provider/id" this action will run on, as the route planner resolved it. */
	model?: string;
	/** The effort level this action will run at, as the route planner resolved it. */
	effort?: ThinkingLevel;
	/**
	 * Expected worker turns for this action. Absent, non-numeric or below one
	 * resolves to DEFAULT_EXPECTED_TURNS, which continues under the two-turn guard.
	 */
	expectedTurns?: number;
	/** Episode ids a fresh thread would be seeded with. */
	contextEpisodeIds?: readonly string[];
}

/**
 * Per-million-token rates for the action's model. A PriceRow satisfies this
 * structurally, so a caller passes the covering row of the shipped schedule.
 */
export interface ThreadChoiceRates {
	inUsdPerMTok?: number;
	outUsdPerMTok?: number;
	cachedInUsdPerMTok?: number;
	cacheWriteUsdPerMTok?: number;
}

/** The long-context BILLING cliff for the action's model. Never a capacity limit. */
export interface ThreadChoiceLongContext {
	/** Billed tokens in one request at or above which the multipliers apply. */
	threshold?: number | null;
	/** The multipliers themselves. Absent leaves the cliff KNOWN but unpriced. */
	multipliers?: { in?: number; out?: number; cachedIn?: number; cacheWrite?: number } | null;
}

/** Token sizes of the two arms. Each absent value is stated at its own field. */
export interface ThreadChoiceSizes {
	/**
	 * Tokens a NEW thread must establish before it does any work: the worker
	 * instructions, the tool definitions and the rest of its opening prefix.
	 * Required for the arithmetic; absent abstains.
	 */
	freshSeedTokens?: number;
	/**
	 * Tokens the named episodes add to a fresh thread's prefix. Absent abstains
	 * when the action names episodes, because a fresh arm priced without them is
	 * understated, and understating the fresh arm destroys warm threads.
	 */
	episodeTokens?: number;
	/** Tokens the action's own task text adds to EITHER arm. Absent counts as zero. */
	taskTokens?: number;
	/** Context tokens one turn adds. Absent uses DEFAULT_GROWTH_TOKENS_PER_TURN. */
	growthTokensPerTurn?: number;
	/** Output tokens one turn bills. Absent uses DEFAULT_OUTPUT_TOKENS_PER_TURN. */
	outputTokensPerTurn?: number;
	/** Turns charged to the fresh arm for rediscovery. Absent uses DEFAULT_REDISCOVERY_TURNS. */
	rediscoveryTurns?: number;
	/**
	 * true when the fresh thread's SEED is expected to be read from a shared cache
	 * shard rather than written. Default FALSE: assuming a shared read makes a
	 * fresh thread look cheap, which is the direction that destroys warm threads.
	 */
	freshSeedCached?: boolean;
}

/** Everything one thread choice depends on. */
export interface ThreadChoiceInput {
	/**
	 * The caller's reading of the current time, in milliseconds since the epoch.
	 * Injected so this module needs no clock. Absent means the elapsed time is
	 * unknown, which is never treated as an expiry.
	 */
	now?: number;
	/** The thread a continuation would use. Absent = nothing to continue. */
	thread?: ThreadChoiceThread;
	/** The last dispatch on that thread. Absent = the thread has recorded none. */
	last?: ThreadChoiceLastDispatch;
	/** The action being placed. Required. */
	action?: ThreadChoiceAction;
	/** Cache-retention evidence for the action's model. */
	retention?: ThreadChoiceRetention;
	/** Rates for the action's model. */
	rates?: ThreadChoiceRates;
	/** The long-context billing cliff for the action's model. */
	longContext?: ThreadChoiceLongContext;
	/** Token sizes of the two arms. */
	sizes?: ThreadChoiceSizes;
	/**
	 * Every episode id the store holds. Absent abstains when the action names any
	 * episode, because a seed that cannot be checked cannot be approved.
	 */
	knownEpisodeIds?: readonly string[];
}

/** Why a prefix is warm or cold. Each code names ONE piece of evidence. */
export type PrefixWarmthCode =
	| "no-previous-dispatch"
	| "model-change"
	| "effort-change"
	| "measured-cache-miss"
	| "retention-expired"
	| "within-retention"
	| "no-retention-data"
	| "unknown-elapsed-time";

/** The warmth verdict, with the evidence that produced it. */
export interface PrefixWarmth {
	warm: boolean;
	code: PrefixWarmthCode;
	/** Human-readable, with no further lookup needed. */
	reason: string;
	/** Seconds since the previous dispatch, when both times were known. */
	elapsedSeconds?: number;
	/** The retention window applied, in seconds, when one was known. */
	windowSeconds?: number;
}

/** What one arm bills over the whole work stream. */
export interface ThreadChoiceArmCost {
	/** Turns priced, after the MAX_PRICED_TURNS clamp. */
	turns: number;
	/** Tokens billed as a cache READ across every turn. */
	cacheReadTokens: number;
	/**
	 * Tokens billed FRESH across every turn — the input and cache-write buckets,
	 * which are disjoint from the cache-read bucket and are priced once.
	 */
	freshTokens: number;
	/** Output tokens billed across every turn. */
	outputTokens: number;
	/** Total cost in USD. */
	usd: number;
	/** Turns whose billed tokens reached the long-context threshold. */
	longContextTurns: number;
}

/** The priced comparison behind a `continue` or `fresh` verdict. */
export interface ThreadChoiceEstimate {
	continuation: ThreadChoiceArmCost;
	fresh: ThreadChoiceArmCost;
	/** Turns priced for the continuation arm, before the fresh arm's extra turn. */
	expectedTurns: number;
	/** Turns charged to the fresh arm for rediscovery. */
	rediscoveryTurns: number;
	/** true when a turn estimate was clamped to MAX_PRICED_TURNS. */
	turnsClamped?: true;
	/**
	 * true when a long-context threshold was crossed but its multipliers were not
	 * recorded, so both arms were priced at the base rates past the cliff.
	 */
	longContextUnpriced?: true;
}

export type ThreadChoiceContinueCode = "short-work" | "continuation-cheaper" | "equal-cost";
export type ThreadChoiceFreshCode = "no-thread-to-continue" | "fresh-cheaper";
export type ThreadChoiceAbstainCode =
	| "no-action"
	| "episode-index-unavailable"
	| "prices-unusable"
	| "prefix-size-unknown"
	| "episode-size-unknown"
	| "fresh-size-unknown";
export type ThreadChoiceRefusedCode =
	| "episode-missing"
	| "tool-allowance-unrecorded"
	| "tool-allowance-empty"
	| "last-dispatch-failed";

/** Continue the existing thread. */
export interface ThreadChoiceContinue {
	kind: "continue";
	code: ThreadChoiceContinueCode;
	reason: string;
	warmth?: PrefixWarmth;
	estimate?: ThreadChoiceEstimate;
}

/** Open a fresh thread and seed it with the named episodes. */
export interface ThreadChoiceFresh {
	kind: "fresh";
	code: ThreadChoiceFreshCode;
	reason: string;
	warmth?: PrefixWarmth;
	estimate?: ThreadChoiceEstimate;
}

/** The inputs cannot support a decision. The caller decides. */
export interface ThreadChoiceAbstain {
	kind: "abstain";
	code: ThreadChoiceAbstainCode;
	reason: string;
	warmth?: PrefixWarmth;
}

/** A rule forbids a fresh thread, whatever the economics say. */
export interface ThreadChoiceRefused {
	kind: "refused";
	code: ThreadChoiceRefusedCode;
	reason: string;
	/** The thread id or episode id the rule is about, sanitized for display. */
	subject?: string;
}

export type ThreadChoiceVerdict = ThreadChoiceContinue | ThreadChoiceFresh | ThreadChoiceAbstain | ThreadChoiceRefused;

/** A finite number, or undefined. Every injected figure may be null or malformed. */
function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A token count: finite and not negative. Zero is a real count and stays. */
function tokenCount(value: unknown): number | undefined {
	const n = finite(value);
	return n !== undefined && n >= 0 ? n : undefined;
}

/** A price: finite and not negative. Zero is a real price (see resolveTokenRates). */
function priceValue(value: unknown): number | undefined {
	const n = finite(value);
	return n !== undefined && n >= 0 ? n : undefined;
}

/** A multiplier: finite and above zero. A zero or negative multiplier is malformed data. */
function multiplierValue(value: unknown): number | undefined {
	const n = finite(value);
	return n !== undefined && n > 0 ? n : undefined;
}

/**
 * A model spec, BYTE-FOR-BYTE. Only a non-string or the empty string reads as
 * absent, exactly as route.ts reads a spec. Warmth compares specs for equality
 * and never repairs one, so a padded spec is a DIFFERENT model here — which is
 * the safe direction, because pi's registry treats it as one too.
 */
function specValue(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** A string list, defensively: an unversioned snapshot may hold any shape. */
function stringList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

/** Display form of an id that came from a tool argument or a snapshot. */
function shown(value: string): string {
	return sanitizeForNotify(value, 60);
}

function count(tokens: number): string {
	return Math.round(tokens).toLocaleString("en-US");
}

/** Money, with enough decimals for the small sums a single action bills. */
function usd(value: number): string {
	return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

function turnWord(turns: number): string {
	return turns === 1 ? "1 turn" : `${turns} turns`;
}

/**
 * The rates one arm is priced with, after the DISJOINT-BUCKET rule is applied.
 * Every field is a usable per-million-token price.
 */
export interface TokenRates {
	/** Cache-read rate, for tokens the provider already holds. */
	cacheRead: number;
	/**
	 * Rate for a token processed FRESH — the input and cache-write buckets. It is
	 * ONE rate on purpose: a fresh token is billed once, so nothing here can add a
	 * cache-write charge on top of the same token counted as input.
	 */
	fresh: number;
	/** Output rate. */
	output: number;
	/** true when the fresh rate came from the input price because no write premium was recorded. */
	freshFromInputPrice: boolean;
}

/**
 * Resolve the rates, or report that they cannot be resolved.
 *
 * THE INPUT, CACHE-READ AND OUTPUT PRICES ARE REQUIRED. Without the cache-read
 * price there is no way to value warmth, and pricing a warm prefix at the input
 * rate makes continuation look expensive — the one direction this module refuses
 * to guess in. So the caller is told to abstain instead.
 *
 * THE CACHE-WRITE PRICE IS OPTIONAL, and an absent or ZERO value means the same
 * thing: this model records no write premium. That is legitimate and common, so
 * it never abstains. The fresh rate then falls back to the INPUT price, because
 * a provider that publishes no write premium still bills that token as ordinary
 * input. Treating a zero write price as "free" would price a rewritten prefix at
 * nothing and flip the verdict on its own.
 */
export function resolveTokenRates(rates: ThreadChoiceRates | undefined): TokenRates | undefined {
	if (!rates || typeof rates !== "object") return undefined;
	const input = priceValue(rates.inUsdPerMTok);
	const output = priceValue(rates.outUsdPerMTok);
	const cacheRead = priceValue(rates.cachedInUsdPerMTok);
	if (input === undefined || output === undefined || cacheRead === undefined) return undefined;
	const write = priceValue(rates.cacheWriteUsdPerMTok);
	if (write !== undefined && write > 0) return { cacheRead, fresh: write, output, freshFromInputPrice: false };
	return { cacheRead, fresh: input, output, freshFromInputPrice: true };
}

/** The long-context cliff, resolved. `priced` is false when only the threshold was recorded. */
export interface ResolvedLongContext {
	threshold: number;
	cacheRead: number;
	fresh: number;
	output: number;
	priced: boolean;
}

/**
 * Resolve the cliff. An absent, null or malformed threshold means NO cliff, which
 * is a stated absence in the shipped table for several models and not a gap.
 *
 * A threshold with no multipliers stays a KNOWN cliff that cannot be priced: both
 * arms are then billed at base rates past it, and the estimate says so
 * (`longContextUnpriced`). Abstaining over a missing documentation figure would
 * surrender the whole decision to one absent number.
 */
export function resolveLongContext(value: ThreadChoiceLongContext | undefined): ResolvedLongContext | undefined {
	if (!value || typeof value !== "object") return undefined;
	const threshold = tokenCount(value.threshold);
	if (threshold === undefined) return undefined;
	const multipliers = value.multipliers;
	if (!multipliers || typeof multipliers !== "object") {
		return { threshold, cacheRead: 1, fresh: 1, output: 1, priced: false };
	}
	const base = multiplierValue(multipliers.in);
	const cacheRead = multiplierValue(multipliers.cachedIn) ?? base;
	const fresh = multiplierValue(multipliers.cacheWrite) ?? base;
	const output = multiplierValue(multipliers.out);
	if (base === undefined && cacheRead === undefined && fresh === undefined && output === undefined) {
		return { threshold, cacheRead: 1, fresh: 1, output: 1, priced: false };
	}
	return { threshold, cacheRead: cacheRead ?? 1, fresh: fresh ?? 1, output: output ?? 1, priced: true };
}

/** One arm of the comparison, described in tokens and turns. */
export interface ThreadChoiceArm {
	/** Tokens the provider already holds at the first turn. Zero for a cold arm. */
	cachedPrefixTokens: number;
	/** Tokens that must be processed at the first turn because no cache holds them. */
	uncachedPrefixTokens: number;
	/** Turns this arm runs, already including any rediscovery charge. */
	turns: number;
	growthTokensPerTurn: number;
	outputTokensPerTurn: number;
	rates: TokenRates;
	longContext?: ResolvedLongContext | undefined;
}

function perMillion(tokens: number, usdPerMTok: number): number {
	return (tokens * usdPerMTok) / 1_000_000;
}

/**
 * Price one arm over its whole run of turns.
 *
 * THE TURN MODEL, stated once. At turn `t` the request carries everything
 * established before it, which is the two prefix figures plus the growth of each
 * earlier turn. Those tokens are billed as a cache READ, except at the first
 * turn, where only `cachedPrefixTokens` is a read and `uncachedPrefixTokens` is
 * processed fresh. Each turn also processes its own growth fresh and bills its
 * own output. No token appears in two buckets in one turn, which is the
 * disjoint-bucket rule made structural.
 *
 * THE CLIFF IS JUDGED PER REQUEST, on the SUM of that turn's read and fresh
 * tokens — the input, cache-read and cache-write buckets together. A warm arm
 * carries a large read into that sum, so it can cross where a cold arm does not.
 */
export function estimateArmCost(arm: ThreadChoiceArm): ThreadChoiceArmCost {
	const cached = tokenCount(arm.cachedPrefixTokens) ?? 0;
	const uncached = tokenCount(arm.uncachedPrefixTokens) ?? 0;
	const growth = tokenCount(arm.growthTokensPerTurn) ?? 0;
	const output = tokenCount(arm.outputTokensPerTurn) ?? 0;
	const turns = Math.min(Math.max(Math.ceil(finite(arm.turns) ?? 1), 1), MAX_PRICED_TURNS);
	const cliff = arm.longContext;
	let cacheReadTokens = 0;
	let freshTokens = 0;
	let outputTokens = 0;
	let longContextTurns = 0;
	let total = 0;
	for (let turn = 1; turn <= turns; turn++) {
		const established = cached + uncached + growth * (turn - 1);
		const read = turn === 1 ? cached : established;
		const fresh = turn === 1 ? uncached + growth : growth;
		const billed = read + fresh;
		const long = cliff !== undefined && billed >= cliff.threshold;
		if (long) longContextTurns++;
		const readRate = arm.rates.cacheRead * (long && cliff ? cliff.cacheRead : 1);
		const freshRate = arm.rates.fresh * (long && cliff ? cliff.fresh : 1);
		const outputRate = arm.rates.output * (long && cliff ? cliff.output : 1);
		cacheReadTokens += read;
		freshTokens += fresh;
		outputTokens += output;
		total += perMillion(read, readRate) + perMillion(fresh, freshRate) + perMillion(output, outputRate);
	}
	return { turns, cacheReadTokens, freshTokens, outputTokens, usd: total, longContextTurns };
}

/** Inputs of the warmth question, which is a question about the PREVIOUS dispatch. */
export interface PrefixWarmthInput {
	/** The caller's reading of the current time, in milliseconds since the epoch. */
	now?: number;
	/** "provider/id" this action will run on. */
	model?: string;
	/** The effort level this action will run at. */
	effort?: ThinkingLevel;
	/** The previous dispatch on the thread. Absent = the thread has recorded none. */
	last?: ThreadChoiceLastDispatch;
	/** Cache-retention evidence for the action's model. */
	retention?: ThreadChoiceRetention;
}

/**
 * IS THE THREAD'S CACHED PREFIX STILL THERE? Measured, never assumed.
 *
 * Four facts make a prefix cold, and each one is evidence-backed:
 *
 *   1. A DIFFERENT MODEL. Provider caches are per model, and a documented
 *      invalidation on both provider families.
 *   2. A DIFFERENT REASONING EFFORT. Measured at zero cache reads in three of
 *      three probes on both provider families, against three of three warm
 *      same-effort controls. Anthropic documents it; for OpenAI the measurement
 *      is the whole evidence, and it is why this rule is not a documentation
 *      transcription.
 *   3. A MEASURED CACHE READ OF ZERO on the previous dispatch. The provider
 *      already told us the prefix was not there. A REPORTED zero only: an absent
 *      figure is no measurement.
 *   4. ELAPSED TIME BEYOND THE RETENTION WINDOW, and this one is ASYMMETRIC.
 *      Inside the window the prefix is warm. Beyond it, cold. With NO retention
 *      data at all the prefix is WARM, because a false cold estimate prices
 *      continuation at up to twenty-two times its true cost while a false warm
 *      estimate costs one rewritten prefix. An unknown elapsed time reads the
 *      same way.
 *
 * The window is the documented lifetime, EXTENDED by the longest gap a local
 * probe still measured warm. A measurement of warmth outranks a documented
 * minimum, and never shortens it.
 *
 * Rules 1 and 2 compare two KNOWN values. An unknown previous model or effort is
 * not a route change, because "we did not record it" is not evidence that it
 * differs.
 */
export function classifyPrefixWarmth(input: PrefixWarmthInput): PrefixWarmth {
	const last = input?.last;
	if (!last || typeof last !== "object") {
		return {
			warm: false,
			code: "no-previous-dispatch",
			reason: "The thread records no previous dispatch, so it holds no cached prefix to reuse.",
		};
	}
	const nextModel = specValue(input.model);
	const lastModel = specValue(last.model);
	if (nextModel !== undefined && lastModel !== undefined && nextModel !== lastModel) {
		return {
			warm: false,
			code: "model-change",
			reason:
				`The previous dispatch ran on ${shown(lastModel)} and this action runs on ${shown(nextModel)}. ` +
				"A provider cache is per model, so the whole prefix must be written again.",
		};
	}
	const nextEffort = levelValue(input.effort);
	const lastEffort = levelValue(last.effort);
	if (nextEffort !== undefined && lastEffort !== undefined && nextEffort !== lastEffort) {
		return {
			warm: false,
			code: "effort-change",
			reason:
				`The previous dispatch ran at effort ${lastEffort} and this action runs at effort ${nextEffort}. ` +
				"An effort change measured zero cache reads on both provider families, so treat the prefix as gone.",
		};
	}
	const lastRead = tokenCount(last.cacheRead);
	if (lastRead === 0) {
		return {
			warm: false,
			code: "measured-cache-miss",
			reason: "The previous dispatch on this thread reported a cache read of zero tokens, so no prefix survived it.",
		};
	}
	const window = retentionWindowSeconds(input.retention);
	const elapsed = elapsedSeconds(input.now, last.createdAt);
	if (window === undefined) {
		return {
			warm: true,
			code: "no-retention-data",
			reason:
				"The route is unchanged and this model records no cache-retention data, so the prefix counts as warm. " +
				"A false cold estimate is the more expensive error.",
			...(elapsed !== undefined ? { elapsedSeconds: elapsed } : {}),
		};
	}
	if (elapsed === undefined) {
		return {
			warm: true,
			code: "unknown-elapsed-time",
			reason:
				"The route is unchanged and the time since the previous dispatch is unknown, so the prefix counts as warm. " +
				"An unknown age is not an expiry.",
			windowSeconds: window,
		};
	}
	if (elapsed > window) {
		return {
			warm: false,
			code: "retention-expired",
			reason:
				`The previous dispatch ended about ${count(elapsed)} seconds ago, past this model's ` +
				`${count(window)}-second cache retention window, so the prefix has expired.`,
			elapsedSeconds: elapsed,
			windowSeconds: window,
		};
	}
	return {
		warm: true,
		code: "within-retention",
		reason:
			`The route is unchanged and the previous dispatch ended about ${count(elapsed)} seconds ago, ` +
			`inside this model's ${count(window)}-second cache retention window.`,
		elapsedSeconds: elapsed,
		windowSeconds: window,
	};
}

/** pi's thinking-level vocabulary, for validating a level read back from a record. */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * A level from a record or a tool argument, validated against pi's vocabulary.
 * Anything else reads as absent, so a junk level cannot be compared for equality
 * and cannot fabricate an effort change.
 */
function levelValue(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

/** The window: the documented lifetime, extended by the longest measured warm gap. */
function retentionWindowSeconds(retention: ThreadChoiceRetention | undefined): number | undefined {
	if (!retention || typeof retention !== "object") return undefined;
	const documented = tokenCount(retention.documentedSeconds);
	const measured = tokenCount(retention.measuredWarmSeconds);
	if (documented === undefined) return measured;
	if (measured === undefined) return documented;
	return Math.max(documented, measured);
}

/** Seconds between the previous dispatch and now. A negative gap is unusable, not zero. */
function elapsedSeconds(now: unknown, then: unknown): number | undefined {
	const a = finite(now);
	const b = finite(then);
	if (a === undefined || b === undefined) return undefined;
	const seconds = (a - b) / 1000;
	return seconds >= 0 ? seconds : undefined;
}

/** The caller's turn estimate, sanitized. */
function expectedTurnsOf(value: unknown): { turns: number; clamped: boolean } {
	const raw = finite(value);
	if (raw === undefined || raw < 1) return { turns: DEFAULT_EXPECTED_TURNS, clamped: false };
	const turns = Math.ceil(raw);
	return turns > MAX_PRICED_TURNS ? { turns: MAX_PRICED_TURNS, clamped: true } : { turns, clamped: false };
}

/**
 * CONTINUE THE THREAD OR OPEN A FRESH ONE — the whole decision, as a function of
 * its inputs. The module header states the order of the six steps and why each
 * one sits where it does.
 */
export function planThreadChoice(input: ThreadChoiceInput): ThreadChoiceVerdict {
	// STEP 1 — is there anything to decide about? A missing or malformed action
	// carries no model, no effort and no turn estimate, so every later step would
	// be about fabricated inputs.
	const action = input?.action;
	if (!action || typeof action !== "object") {
		return {
			kind: "abstain",
			code: "no-action",
			reason: "slate: no action was described, so slate cannot choose between continuing a thread and opening a fresh one.",
		};
	}
	const thread = input.thread && typeof input.thread === "object" ? input.thread : undefined;
	const threadId = thread ? shown(specValue(thread.id) ?? "an unnamed thread") : undefined;
	const named = stringList(action.contextEpisodeIds) ?? [];

	// STEP 2 — THE REFUSALS. They come before the arithmetic because no price makes
	// a forbidden thread permissible, and before the warmth measurement because a
	// refusal needs no cache evidence at all.
	//
	// The episode rule is UNCONDITIONAL: a fresh thread is seeded from the named
	// episodes, so a name that does not resolve would open a thread missing the
	// context the action was planned around. That is worse than a slow dispatch,
	// and it is the caller's request to correct.
	const known = stringList(input.knownEpisodeIds);
	if (named.length > 0) {
		if (known === undefined) {
			return {
				kind: "abstain",
				code: "episode-index-unavailable",
				reason:
					"slate: the action names episodes to seed a fresh thread with, and slate received no episode index to check them " +
					"against. A seed that cannot be checked cannot be approved.",
			};
		}
		const missing = named.filter((id) => !known.includes(id));
		const first = missing[0];
		if (first !== undefined) {
			return {
				kind: "refused",
				code: "episode-missing",
				reason:
					`slate: a fresh thread is refused because episode ${shown(first)} does not exist. ` +
					`Named episodes seed a fresh thread, so slate will not open one around a missing episode. ` +
					`Missing: ${missing.map(shown).join(", ")}.`,
				subject: shown(first),
			};
		}
	}

	const last = input.last && typeof input.last === "object" ? input.last : undefined;
	if (thread && threadId !== undefined) {
		// The remaining refusals are about REPLACING this thread, so they apply only
		// while a thread exists to replace.
		//
		// THE TOOL ALLOWANCE. A fresh thread has to reproduce the tool set the work
		// already ran with. An UNRECORDED allowance is an older thread whose tools were
		// never written down, so a replacement would silently adopt today's
		// configuration default, which may differ. An EMPTY allowance grants no tools at
		// all, so a replacement could not do the work. Neither is a value to guess.
		const tools = stringList(thread.tools);
		if (tools === undefined) {
			return {
				kind: "refused",
				code: "tool-allowance-unrecorded",
				reason:
					`slate: a fresh thread is refused because thread ${threadId} records no worker tool allowlist. ` +
					"A replacement would adopt today's configured default, which may differ from the tools this work has run with.",
				subject: threadId,
			};
		}
		if (tools.length === 0) {
			return {
				kind: "refused",
				code: "tool-allowance-empty",
				reason:
					`slate: a fresh thread is refused because thread ${threadId}'s worker tool allowlist is empty. ` +
					"A replacement thread would have no tools to work with.",
				subject: threadId,
			};
		}
		// A FAILED LAST DISPATCH. The evidence of that failure lives in the thread, and
		// a fresh thread seeded from episodes alone does not carry it — so a retry
		// elsewhere would repeat the failure without the record of it. The same failure
		// also makes every cache figure on that dispatch unreliable, so the arithmetic
		// below would be reasoning from a broken measurement.
		if (last?.status === "failed") {
			return {
				kind: "refused",
				code: "last-dispatch-failed",
				reason:
					`slate: a fresh thread is refused because the last dispatch on thread ${threadId} failed. ` +
					"Continue that thread, where the failure and its context are recorded.",
				subject: threadId,
			};
		}
	}

	// STEP 3 — nothing to continue. This is also how a caller expresses a NEW WORK
	// STREAM: thread separation is a semantic judgement, it belongs to the
	// orchestrator, and a caller that has made it passes no source thread.
	if (!thread || threadId === undefined) {
		return {
			kind: "fresh",
			code: "no-thread-to-continue",
			reason: "slate: a fresh thread is the only option, because no existing thread was offered for this action.",
		};
	}

	// STEP 4 — WARMTH, measured.
	const warmth = classifyPrefixWarmth({
		...(finite(input.now) !== undefined ? { now: input.now } : {}),
		...(specValue(action.model) !== undefined ? { model: action.model } : {}),
		...(levelValue(action.effort) !== undefined ? { effort: levelValue(action.effort) } : {}),
		...(last ? { last } : {}),
		...(input.retention ? { retention: input.retention } : {}),
	});

	// STEP 5 — THE TWO-TURN GUARD. Short work continues without pricing, because the
	// setup cost of a fresh thread does not recover over one or two turns. This is a
	// measured guard, not an approximation of the arithmetic below.
	const { turns: expectedTurns, clamped } = expectedTurnsOf(action.expectedTurns);
	if (expectedTurns <= SHORT_WORK_TURNS) {
		return {
			kind: "continue",
			code: "short-work",
			reason:
				`slate: continue thread ${threadId}. The action is expected to need ${turnWord(expectedTurns)}, and short work ` +
				`does not recover the setup cost of a fresh thread. ${warmth.reason}`,
			warmth,
		};
	}

	// STEP 6 — THE ARITHMETIC. Every abstention below names one missing figure, and
	// each one is a figure without which the comparison would be biased rather than
	// merely imprecise.
	const sizes = input.sizes && typeof input.sizes === "object" ? input.sizes : {};
	const rates = resolveTokenRates(input.rates);
	if (rates === undefined) {
		return {
			kind: "abstain",
			code: "prices-unusable",
			reason:
				"slate: slate cannot compare the two options, because this model has no usable input, output and cache-read price " +
				"for today. Pricing a warm prefix at the input rate would understate continuation.",
			warmth,
		};
	}
	// The prefix a continuation reuses. NO previous dispatch means a prefix of zero
	// tokens, which is known. A previous dispatch with no reported context size means
	// the prefix size is UNKNOWN, and there is no honest substitute for it.
	const prefixTokens = last === undefined ? 0 : tokenCount(last.contextTokens);
	if (prefixTokens === undefined) {
		return {
			kind: "abstain",
			code: "prefix-size-unknown",
			reason:
				`slate: slate cannot compare the two options, because thread ${threadId}'s last dispatch reported no context size. ` +
				"The size of the prefix a continuation reuses is the largest term in the comparison.",
			warmth,
		};
	}
	const seedTokens = tokenCount(sizes.freshSeedTokens);
	if (seedTokens === undefined) {
		return {
			kind: "abstain",
			code: "fresh-size-unknown",
			reason:
				"slate: slate cannot compare the two options, because the opening prefix size of a fresh worker thread is unknown. " +
				"That figure is the setup cost the comparison amortises.",
			warmth,
		};
	}
	const episodeTokens = tokenCount(sizes.episodeTokens);
	if (episodeTokens === undefined && named.length > 0) {
		return {
			kind: "abstain",
			code: "episode-size-unknown",
			reason:
				"slate: slate cannot compare the two options, because the token size of " +
				`${named.length === 1 ? "the named episode" : `the ${named.length} named episodes`} is unknown. ` +
				"A fresh thread priced without its seed episodes looks cheaper than it is.",
			warmth,
		};
	}

	const growth = tokenCount(sizes.growthTokensPerTurn) ?? DEFAULT_GROWTH_TOKENS_PER_TURN;
	const output = tokenCount(sizes.outputTokensPerTurn) ?? DEFAULT_OUTPUT_TOKENS_PER_TURN;
	const rediscovery = Math.ceil(tokenCount(sizes.rediscoveryTurns) ?? DEFAULT_REDISCOVERY_TURNS);
	// The task text is new to BOTH arms, so it moves neither side materially; an
	// absent figure therefore counts as zero instead of abstaining.
	const taskTokens = tokenCount(sizes.taskTokens) ?? 0;
	const cliff = resolveLongContext(input.longContext);
	const freshSeedCached = sizes.freshSeedCached === true;
	// A thread that has NEVER dispatched holds no prefix at all, so continuing it must
	// establish the same opening prefix a fresh thread would. Pricing it at zero would
	// make an empty thread look free and would not be arithmetic about anything.
	const establishedPrefix = last === undefined ? seedTokens : prefixTokens;
	// KEEP THE REDISCOVERY GAP under the clamp. Clamping the fresh arm alone would
	// delete the extra turn it is charged, which is the one term that stops a fresh
	// thread from looking free on very long work.
	const pricedTurns = Math.max(1, Math.min(expectedTurns, MAX_PRICED_TURNS - rediscovery));

	const continuation = estimateArmCost({
		cachedPrefixTokens: warmth.warm ? establishedPrefix : 0,
		uncachedPrefixTokens: (warmth.warm ? 0 : establishedPrefix) + taskTokens,
		turns: pricedTurns,
		growthTokensPerTurn: growth,
		outputTokensPerTurn: output,
		rates,
		longContext: cliff,
	});
	const freshArm = estimateArmCost({
		// A fresh thread's seed is written unless the caller states that a shared cache
		// shard already holds it. The named episodes and the task are always new.
		cachedPrefixTokens: freshSeedCached ? seedTokens : 0,
		uncachedPrefixTokens: (freshSeedCached ? 0 : seedTokens) + (episodeTokens ?? 0) + taskTokens,
		turns: pricedTurns + rediscovery,
		growthTokensPerTurn: growth,
		outputTokensPerTurn: output,
		rates,
		longContext: cliff,
	});
	const clampedEither = clamped || pricedTurns < expectedTurns;
	const unpriced = cliff !== undefined && !cliff.priced && continuation.longContextTurns + freshArm.longContextTurns > 0;
	const estimate: ThreadChoiceEstimate = {
		continuation,
		fresh: freshArm,
		expectedTurns: pricedTurns,
		rediscoveryTurns: rediscovery,
		...(clampedEither ? { turnsClamped: true as const } : {}),
		...(unpriced ? { longContextUnpriced: true as const } : {}),
	};
	const comparison =
		`Continuing thread ${threadId} prices at about ${usd(continuation.usd)} over ${turnWord(continuation.turns)}, ` +
		`against ${usd(freshArm.usd)} for a fresh thread over ${turnWord(freshArm.turns)}, which includes ` +
		`${turnWord(rediscovery)} charged for rediscovery.` +
		(rates.freshFromInputPrice ? " This model records no cache-write premium, so fresh tokens bill at its input rate." : "") +
		(unpriced ? " One arm crosses this model's long-context billing threshold, whose multipliers are not recorded." : "");

	// A TIE CONTINUES. Equal estimates are not a reason to rewrite a prefix, and the
	// two errors are not symmetric: see UNCERTAINTY in the module header.
	if (freshArm.usd < continuation.usd) {
		return {
			kind: "fresh",
			code: "fresh-cheaper",
			reason: `slate: open a fresh thread seeded with the named episodes. ${comparison} ${warmth.reason}`,
			warmth,
			estimate,
		};
	}
	return {
		kind: "continue",
		code: freshArm.usd === continuation.usd ? "equal-cost" : "continuation-cheaper",
		reason:
			`slate: continue thread ${threadId}. ${comparison} ` +
			`${freshArm.usd === continuation.usd ? "The two options price the same, and a tie keeps the existing prefix. " : ""}` +
			warmth.reason,
		warmth,
		estimate,
	};
}
