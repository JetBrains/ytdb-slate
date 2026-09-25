/**
 * Coordinates one new thread for each accepted action.
 *
 * Validation runs before thread creation. The global semaphore limits parallel
 * actions. Each action opens one worker session. In-action failover can re-prompt
 * that session once. Terminal work creates at most one episode.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { WorkerRetryEvidence, executeRecovery, type CompressorRetryPolicy } from "./logical-model-adapters.ts";
import type { LogicalRuntime } from "./logical-model-runtime.ts";
import type { RecoveryAdmission, RecoveryCandidate } from "./logical-model-recovery.ts";
import {
	compressEpisode,
	createCompletedFactRecorder,
	EpisodePersistenceError,
	writeFailedEpisode,
	type FrozenCompletedFacts,
} from "./episodes.ts";
import { LOGICAL_MODEL_EFFORTS, type LogicalModelEffort } from "./logical-model-definitions.ts";
import { captureObservation, durableObservation, shouldWarnFindingsGrammar, type ObservationCapture, type ObservationRecord } from "./observations.ts";
import { slateEpisodeId } from "./slate-files.ts";
import { sanitizeForNotify } from "./notify.ts";
import type { RequestThrottle } from "./request-throttle.ts";
import { planSessionOpen, type SessionOpenDecision } from "./logical-model-runtime.ts";
import {
	effectiveThreadType,
	parseThreadType,
	sanitizeDispatchReason,
	resolveEpisodeFile,
	type EpisodeRecord,
	type EpisodeUsage,
	type SlateConfig,
	type SlateStore,
	type ThreadRecord,
	type ThreadType,
} from "./state.ts";
import {
	createWorkerRequestContract,
	DEFAULT_WORKER_TOOLS,
	isJudgementThreadType,
	openWorkerSession,
	resolveModel,
	type WorkerRequestContract,
	type WorkerSession,
} from "./worker.ts";
import { EMPTY_WORKER_EXTENSION_SET, type WorkerExtensionSet } from "./worker-extensions.ts";
import { isWorkerReminderMessage, workerReminderDeliveryMissing } from "./worker-reminder.ts";
import { loadImplementationReviewGuidance, validateReviewPerspectives, type ReviewFileReader } from "./review-perspectives.ts";

/**
 * One prompt-cache key for ONE main slate session.
 *
 * Every worker session and every model of that main session shares this key, so
 * their requests reach the same provider cache routing group. A second main
 * session calls this again and therefore gets a different key, which is what
 * keeps two concurrent main sessions isolated from each other.
 *
 * The value carries no project path and no user name. A random UUID supplies
 * the session identity. The key is 50 characters, inside the platform limit
 * slate pins in worker.ts.
 */
export function createSessionPromptCacheKey(): string {
	return `slate-session-${randomUUID()}`;
}

/**
 * The parts of a dispatch that belong to the MAIN SESSION rather than to a
 * thread: its shared prompt-cache key and its shared request throttle.
 *
 * Bound BY VALUE at construction like every other session-scoped component
 * (CN20): a manager orphaned by a session swap keeps its own session's key and
 * its own session's limiter, so a stale worker can neither join a newer
 * session's cache group nor spend a newer session's request budget.
 */
export interface ThreadSessionScope {
	/** The main session's shared cache-routing key. Absent means no key injection. */
	promptCacheKey?: string;
	/** The main session's shared per-model request throttle. Absent means no pacing. */
	requestThrottle?: RequestThrottle;
}

export const MAX_CONTEXT_EPISODES = 32;

/** Validate and deduplicate episode references while preserving first position. */
export function normalizeContextEpisodeIds(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) {
		throw new Error(`context must be a list of up to ${MAX_CONTEXT_EPISODES} episode ids.`);
	}
	if (value.length > MAX_CONTEXT_EPISODES) {
		throw new Error(`context accepts at most ${MAX_CONTEXT_EPISODES} episode ids.`);
	}
	return [...new Set(value)];
}

export interface DispatchOptions {
	/** Removed public field. Kept only so direct callers receive the migration error. */
	threadId?: unknown;
	name?: string;
	type?: ThreadType;
	task: string;
	contextEpisodeIds?: unknown;
	/** Removed public field. Kept only so direct callers receive the migration error. */
	freshContext?: unknown;
	model?: string; // required at the public runtime boundary
	/** Removed public field. Kept only so direct callers receive the migration error. */
	effort?: unknown;
	reason?: string; // sanitized dispatch rationale, required and at most 200 characters
	tools?: string[];
	/** Optional built-in implementation-review selection. Never persisted. */
	reviewPerspectives?: unknown;
}

/**
 * An apply-time rejection: the world moved between the early validation and the
 * dispatch. Thrown ONLY from the pre-prompt phase, and caught separately from
 * every other failure so the dispatch ends WITHOUT an episode and WITHOUT a
 * compressor call — nothing was billed, so nothing should be recorded as work.
 */
class DispatchAbort extends Error {}

export interface UsageStats {
	turns: number;
	input: number;
	output: number;
	cost: number;
	contextTokens: number;
}

export interface DispatchProgress {
	threadId: string;
	threadName: string;
	lines: string[];
	usage: UsageStats;
	done: boolean;
	status?: "ok" | "failed";
}

export interface DispatchResult {
	episodeText: string;
	episode: EpisodeRecord;
	thread: ThreadRecord;
	usage: UsageStats;
	/** Routing notices for this action. */
	warnings: readonly string[];
}

/** Loose shape of an assistant message as seen in session.messages / message_end. */
interface WorkerAssistantMsg {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	content?: Array<{ type: string; text?: string }>;
}

/**
 * Final assistant message of THIS action (AF3): backward scan, because the
 * last array element can be a toolResult (e.g. after a tool abort), and pi's
 * internal retry strips recovered errored attempts from session.messages
 * entirely — so the last assistant message is the authoritative outcome.
 */
function lastAssistantMessage(messages: unknown[]): WorkerAssistantMsg | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as WorkerAssistantMsg;
		if (m.role === "assistant") return m;
	}
	return undefined;
}

/** Remove worker reminders and Slate's injected user prompt from episode input. */
export function messagesForCompression(messages: unknown[], injectedPrompt?: string): unknown[] {
	const filtered = messages.filter((message) => !isWorkerReminderMessage(message));
	if (injectedPrompt === undefined) return filtered;
	const textOf = (message: unknown): string | undefined => {
		const candidate = message as { role?: unknown; content?: unknown } | null;
		if (candidate?.role !== "user") return undefined;
		if (typeof candidate.content === "string") return candidate.content;
		if (!Array.isArray(candidate.content)) return undefined;
		return candidate.content
			.filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
	};
	let removed = false;
	return filtered.filter((message) => {
		if (removed || textOf(message) !== injectedPrompt) return true;
		removed = true;
		return false;
	});
}

/** Retry nudge for the in-action failover prompt. */
const FAILOVER_NUDGE =
	"The previous attempt was interrupted by a model API failure. The conversation context is intact " +
	"and partial changes may exist — verify the current state, then complete the original action.";

class Semaphore {
	private waiters: Array<() => void> = [];
	private active = 0;
	private limit: number;
	constructor(limit: number) {
		this.limit = limit;
	}
	async acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active++;
			return;
		}
		// Wait for a slot transferred directly by release(); do NOT increment
		// here — the releasing side keeps `active` unchanged when handing over.
		await new Promise<void>((r) => this.waiters.push(r));
	}
	release(): void {
		const next = this.waiters.shift();
		if (next) {
			// Transfer the slot to the next waiter without decrementing:
			// the slot never becomes observable as free.
			next();
		} else {
			this.active--;
		}
	}
}

export class ThreadManager {
	private live = new Map<string, WorkerSession>();
	/** Action-local request owners. Removed and invalidated before shutdown awaits. */
	private requestContracts = new Map<string, WorkerRequestContract>();
	/** Opens started by this manager but not yet returned to a dispatch. */
	private openingWorkers = new Set<Promise<void>>();
	/** Cleanup already claimed by a terminal path and removed from live. */
	private closingWorkers = new Set<Promise<void>>();
	/** Dispatch finalizers that manager teardown must join before it can return. */
	private actionFinalizers = new Map<string, Promise<void>>();
	/** One manager-wide teardown operation. Its presence permanently closes this manager. */
	private teardownPromise: Promise<void> | undefined;
	private teardownStarted = false;
	/** threadId → "provider/id" a LIVE session was switched to by model failover (AF12). */
	private failoverLive = new Map<string, string>();
	private semaphore: Semaphore;
	/** Session-owned persisted thread and episode state. */
	private store: SlateStore;
	/** This manager's immutable session configuration. */
	private config: SlateConfig;
	/** Frozen worker-extension resolver, bound by value to this session (AD41/CN20). */
	private resolveExtensions: () => WorkerExtensionSet;
	/** One immutable logical policy and shared preference owner for this parent session. */
	private logicalRuntime?: Readonly<LogicalRuntime>;
	/** Pi retry settings captured read-only at the parent-session boundary. */
	private compressorRetryPolicy?: CompressorRetryPolicy;
	/** This session's shared cache key and request throttle, frozen at construction. */
	private sessionScope: ThreadSessionScope;
	/** Captured by value so an older dispatch never writes into a replacement session's folder. */
	private readonly runtimeFolder: string;
	private readonly readReviewFile: ReviewFileReader;

	constructor(
		store: SlateStore,
		config: SlateConfig,
		// This session's frozen worker-extension resolver is bound by value.
		resolveExtensions: () => WorkerExtensionSet = () => EMPTY_WORKER_EXTENSION_SET,
		logicalRuntime?: Readonly<LogicalRuntime>,
		compressorRetryPolicy?: CompressorRetryPolicy,
		// Shared cache key and request throttle for this parent session.
		sessionScope: ThreadSessionScope = {},
		readReviewFile?: ReviewFileReader,
	) {
		this.store = store;
		this.runtimeFolder = store.runtimeFolder;
		this.config = config;
		this.resolveExtensions = resolveExtensions;
		this.logicalRuntime = logicalRuntime;
		this.compressorRetryPolicy = compressorRetryPolicy;
		this.sessionScope = sessionScope;
		this.readReviewFile = readReviewFile ?? ((file) => readFileSync(file, "utf8"));
		// Action concurrency and request pacing limit different quantities.
		this.semaphore = new Semaphore(config.maxConcurrent ?? 4);
	}

	getConfig(): SlateConfig {
		return this.config;
	}

	/** The live model after an in-action failover. Disposal removes the marker. */
	liveFailoverModel(threadId: string): string | undefined {
		return this.live.has(threadId) ? this.failoverLive.get(threadId) : undefined;
	}

	async dispatch(
		opts: DispatchOptions,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
	): Promise<DispatchResult> {
		// There is NO pause guard here, on purpose. A paused orchestrator must still
		// dispatch workers, because it saves the project state in the research log
		// through one worker before it writes the handoff brief (handoff.ts pause
		// instructions, docs/context-budget.md). New USER prompts are refused at the
		// pi input hook in mode.ts instead, so the pause still stops new user work.
		if (opts.threadId !== undefined) {
			throw new Error('The "thread" field was removed. Create a new thread and pass earlier episode ids through "context".');
		}
		if (opts.freshContext !== undefined) {
			throw new Error('The "freshContext" field was removed. Pass earlier episode ids through "context".');
		}
		const selected = validateReviewPerspectives(opts.reviewPerspectives, opts.type);
		if (typeof opts.task !== "string" || opts.task.trim() === "") {
			throw new Error("task must be a non-empty string.");
		}
		if (opts.effort !== undefined) throw new Error('The "effort" field was removed. Select a logical model. Its policy fixes the effort.');
		if (typeof opts.model !== "string" || opts.model.trim() === "") throw new Error("model must name one logical model from the active policy.");
		const reason = sanitizeDispatchReason(opts.reason);
		if (reason === undefined) throw new Error("reason must be a non-empty string of at most 200 characters after invisible and control characters are removed.");
		if (this.teardownStarted) throw new Error("Slate worker manager teardown has started. No new action was admitted.");
		const runtime = this.logicalRuntime;
		if (!runtime || !runtime.policy) throw new Error(runtime?.criticalErrors.join(" ") || "Logical model policy is unavailable for this parent session.");
		const admission = runtime.admit();
		if (!admission) throw new Error("Logical model policy could not admit this action.");
		const initialRoute = runtime.startRoute(opts.model, admission.snapshot);
		if (!initialRoute) throw new Error(`Logical model "${sanitizeForNotify(opts.model, 80)}" is not available for ordinary worker actions.`);
		const validation = await runtime.validateRoute(ctx, initialRoute);
		if (!validation.ok) throw new Error(`Logical model "${sanitizeForNotify(opts.model, 80)}" cannot start: ${validation.reason}`);
		if (this.teardownStarted) throw new Error("Slate worker manager teardown started while the action route was being validated. No action was admitted.");
		const type = parseThreadType(opts.type, true)!
		const contextEpisodeIds = normalizeContextEpisodeIds(opts.contextEpisodeIds);
		const accepted: DispatchOptions = { ...opts, reason, type, contextEpisodeIds };
		const prompt = this.buildPrompt(accepted, ctx.cwd);
		const reviewGuidance = selected === undefined ? undefined : loadImplementationReviewGuidance(selected, this.readReviewFile);
		const thread = this.createThread(accepted);
		return this.runDispatch(thread, accepted, prompt, ctx, signal, onProgress, admission, initialRoute, reviewGuidance);
	}

	private createThread(opts: DispatchOptions): ThreadRecord {
		const id = this.store.claimNextThreadId();
		const type = parseThreadType(opts.type, true)!
		const configuredTools = opts.tools ?? this.config.workerTools;
		const tools = [...new Set(configuredTools && configuredTools.length > 0 ? configuredTools : DEFAULT_WORKER_TOOLS)];
		const now = Date.now();
		const record: ThreadRecord = {
			id,
			name: opts.name?.trim() || id,
			status: "queued",
			type,
			tools,
			createdAt: now,
			updatedAt: now,
		};
		this.store.threads.set(id, record);
		try {
			this.store.save();
		} catch (error) {
			this.store.threads.delete(id);
			throw error;
		}
		return record;
	}

	private buildPrompt(opts: DispatchOptions, cwd: string): string {
		const contextIds = normalizeContextEpisodeIds(opts.contextEpisodeIds);
		if (contextIds.length === 0) return opts.task;
		const parts: string[] = ["## Context from prior episodes (loaded by Slate)", ""];
		for (const id of contextIds) {
			const episode = this.store.episodes.get(id);
			if (!episode) throw new Error(`Unknown context episode "${sanitizeForNotify(id, 80)}". Known episodes: ${[...this.store.episodes.keys()].join(", ") || "none"}.`);
			const file = resolveEpisodeFile(cwd, episode.file);
			if (file === undefined) throw new Error(`Episode "${sanitizeForNotify(id, 80)}" is not a safe readable Slate episode file.`);
			parts.push(readFileSync(file, "utf8").trim(), "");
		}
		parts.push("## Action", "", opts.task);
		return parts.join("\n");
	}

	// ---------------------------------------------------------------- routing --
	//
	// The DECISION is route.ts's (pure). What lives here is the part that cannot be
	// pure: reading this session's frozen resolver, pi's settings and the live
	// worker session, and assembling them into the planner's inputs.


	/**
	 * OPEN a worker session for a thread and capture what it opened on.
	 *
	 * The dispatch options are intentionally out of scope here. The only model in
	 * scope is the exact physical route from the immutable admitted candidate.
	 * The new session receives the frozen worker-extension set for this orchestrator session.
	 */
	private async openWorkerFor(args: {
		thread: ThreadRecord;
		ctx: ExtensionContext;
		open: SessionOpenDecision;
		tools: string[] | undefined;
		report: (message: string) => void;
		requestContract: WorkerRequestContract;
		reviewGuidance?: string;
		/**
		 * Report the created worker session to the action that owns it.
		 *
		 * The action keeps this reference even when opening fails later, so the
		 * failed result can still read the startup work of its own session.
		 */
		observeSession?: (session: WorkerSession) => void;
		/** Record an ordinary startup failure at the point the open promise observes it. */
		observeStartupFailure?: (detail: string) => void;
	}): Promise<{ session: WorkerSession }> {
		if (this.teardownStarted) {
			throw new DispatchAbort(`slate: worker startup for thread ${args.thread.id} was cancelled during session teardown`);
		}
		// Publish the action owner before openWorkerSession reaches any awaited
		// extension load or startup work. Teardown can now invalidate that owner even
		// while no WorkerSession exists yet.
		this.requestContracts.set(args.thread.id, args.requestContract);
		let finishOpening!: () => void;
		const openingDone = new Promise<void>((resolve) => { finishOpening = resolve; });
		this.openingWorkers.add(openingDone);
		let opening: WorkerSession | undefined;
		let session: WorkerSession;
		let opened = false;
		try {
			// Startup preparation belongs to the owned opening lifetime. A synchronous
			// throw from role selection or from extension resolution used to escape this
			// scope. The opening promise then never settled, and a later disposeAll
			// waited for it forever.
			try {
				const type = effectiveThreadType(args.thread, args.report);
				const extensions = this.resolveExtensions();
				session = await openWorkerSession({
					ctx: args.ctx,
					sessionFile: undefined,
					runtimeFolder: this.runtimeFolder,
					model: args.open.model,
					tools: args.tools,
					promptDocs: this.config.workerPromptDocs,
					config: this.config,
					extensionPaths: extensions.paths,
					extensionToolNames: extensions.toolNames,
					reviewerCharter: isJudgementThreadType(type),
					reviewGuidance: args.reviewGuidance,
					report: args.report,
					onCreated: (created) => {
						opening = created;
						args.observeSession?.(created);
						if (this.teardownStarted || args.requestContract?.invalidationSignal.aborted === true) {
							created.closeManagedOperations();
							void created.abort().catch(() => {});
							return;
						}
						this.live.set(args.thread.id, created);
					},
					deferShutdownOnOpenFailure: true,
					// ONE key for the whole main session, and the cache-key switch is the only
					// thing that withholds it. Every worker of this session shares one group.
					promptCacheKey: this.config.cacheKeyEnabled === false ? undefined : this.sessionScope.promptCacheKey,
					// Request pacing has its own switch and remains independent of cache keys.
					requestThrottle: this.sessionScope.requestThrottle,
					requestContract: args.requestContract,
				});
			} catch (error) {
				if (opening !== undefined && this.live.get(args.thread.id) === opening) this.live.delete(args.thread.id);
				this.failoverLive.delete(args.thread.id);
				args.observeStartupFailure?.(error instanceof Error ? error.message : String(error));
				throw error;
			}
			if (this.teardownStarted || args.requestContract?.invalidationSignal.aborted === true || this.live.get(args.thread.id) !== session) {
				session.closeManagedOperations();
				await session.settleManagedOperations();
				const cause = this.teardownStarted ? "session teardown" : "action cancellation";
				throw new DispatchAbort(`slate: worker startup for thread ${args.thread.id} was cancelled during ${cause}`);
			}
			// A freshly opened session starts on its configured model — drop any stale
			// failover marker (possible if a previous live session was disposed mid-dispatch
			// after its marker was set).
			this.failoverLive.delete(args.thread.id);
			opened = true;
			return { session };
		} finally {
			if (!opened) {
				// This action never became live. Manager teardown can already have
				// invalidated and removed the same owner while startup was paused, and
				// both operations are idempotent, so this repeat stays safe. One thread
				// id owns at most one contract, so this removal is exact.
				args.requestContract.invalidate();
				this.requestContracts.delete(args.thread.id);
			}
			this.openingWorkers.delete(openingDone);
			finishOpening();
		}
	}

	/**
	 * Remove a worker from the live maps before awaiting extension shutdown.
	 * Every terminal path converges here. WorkerSession memoizes shutdown, so an
	 * overlapping host cleanup and action cleanup emit session_shutdown once.
	 */
	private async closeWorker(threadId: string, session: WorkerSession | undefined): Promise<void> {
		const requestContract = this.requestContracts.get(threadId);
		requestContract?.invalidate();
		this.requestContracts.delete(threadId);
		if (session === undefined) return;
		session.closeManagedOperations?.();
		if (session.settleManagedOperations !== undefined) await session.settleManagedOperations();
		if (this.live.get(threadId) === session) this.live.delete(threadId);
		this.failoverLive.delete(threadId);
		const closing = (async () => {
			const lifecycle = session as WorkerSession & { shutdownWorker?: () => Promise<void>; dispose?: () => void };
			if (lifecycle.shutdownWorker) await lifecycle.shutdownWorker();
			else lifecycle.dispose?.();
		})();
		this.closingWorkers.add(closing);
		try {
			await closing;
		} finally {
			this.closingWorkers.delete(closing);
		}
	}

	/** The level a session is ACTUALLY on (post-clamp), when it is one pi/slate both know. */
	private sessionEffort(session: WorkerSession | undefined): LogicalModelEffort | undefined {
		try {
			const level = session?.thinkingLevel as LogicalModelEffort | undefined;
			return level !== undefined && LOGICAL_MODEL_EFFORTS.includes(level) ? level : undefined;
		} catch {
			return undefined;
		}
	}

	private captureAppliedRoute(
		session: WorkerSession,
		candidate: RecoveryCandidate,
	):
		| { ok: true; model: { provider: string; id: string }; effort: LogicalModelEffort }
		| { ok: false; reason: string } {
		let model: { provider?: unknown; id?: unknown } | undefined;
		try { model = session.model; } catch { model = undefined; }
		if (model?.provider !== candidate.provider || model.id !== candidate.model) {
			return { ok: false, reason: `The worker session did not apply physical route ${candidate.provider}/${candidate.model}.` };
		}
		const effort = this.sessionEffort(session);
		if (effort !== candidate.effort) {
			return { ok: false, reason: `The worker session applied effort ${String(effort)} instead of required effort ${candidate.effort}.` };
		}
		return { ok: true, model: { provider: candidate.provider, id: candidate.model }, effort };
	}

	private cancelBeforeStart(thread: ThreadRecord): never {
		this.store.threads.delete(thread.id);
		try {
			this.store.save();
		} catch {
			/* the in-memory removal remains authoritative */
		}
		throw new Error(`Thread ${thread.id} was cancelled before the action started. No thread or episode was recorded.`);
	}

	private async runDispatch(
		thread: ThreadRecord,
		opts: DispatchOptions,
		prompt: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
		admission?: RecoveryAdmission,
		initialRoute?: RecoveryCandidate,
		reviewGuidance?: string,
	): Promise<DispatchResult> {
		const episodeId = slateEpisodeId(thread.id)!;
		// Enroll synchronously before the semaphore can suspend this action. Manager
		// teardown snapshots this map, so a queued action cannot begin terminal work
		// after teardown has already returned.
		let finishFinalizer!: () => void;
		const finalizer = new Promise<void>((resolve) => { finishFinalizer = resolve; });
		this.actionFinalizers.set(thread.id, finalizer);
		let acquired = false;
		try {
			if (signal?.aborted) this.cancelBeforeStart(thread);
			await this.semaphore.acquire();
			acquired = true;
			if (this.teardownStarted) this.cancelBeforeStart(thread);
			if (signal?.aborted) this.cancelBeforeStart(thread);
			const lease = this.logicalRuntime?.ownership.acquire(thread.id);
			if (lease?.kind === "busy") throw new Error(`Thread ${thread.id} cannot start because its recovery owner is busy.`);
			try {
				return await this.runDispatchInner(thread, opts, prompt, episodeId, ctx, signal, onProgress, admission, initialRoute, reviewGuidance);
			} finally {
				if (lease?.kind === "acquired") lease.lease.release();
			}
		} finally {
			if (acquired) this.semaphore.release();
			this.actionFinalizers.delete(thread.id);
			finishFinalizer();
		}
	}

	private async runDispatchInner(
		thread: ThreadRecord,
		opts: DispatchOptions,
		prompt: string,
		episodeId: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
		admission?: RecoveryAdmission,
		initialRoute?: RecoveryCandidate,
		reviewGuidance?: string,
	): Promise<DispatchResult> {
		const usage: UsageStats = { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 };
		let workerCostUsd: number | undefined;
		let reportedContextTokens: number | undefined;
		const episodeUsage: Partial<Pick<EpisodeRecord, "input" | "output" | "cacheRead" | "cacheWrite">> = {};
		const addEpisodeUsage = (field: keyof typeof episodeUsage, value: number | undefined) => {
			if (value === undefined) return;
			episodeUsage[field] = (episodeUsage[field] ?? 0) + value;
		};
		const compactionUsage: EpisodeUsage = {};
		let compactionCostUsd: number | undefined;
		const seenCompactionEvents = new WeakSet<object>();
		const addCompactionUsage = (reported: (EpisodeUsage & { cost?: { total?: number } }) | undefined) => {
			if (reported === undefined) return;
			for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				const value = reported[field];
				if (value !== undefined) compactionUsage[field] = (compactionUsage[field] ?? 0) + value;
			}
			const cost = reported.cost?.total;
			if (cost !== undefined) compactionCostUsd = (compactionCostUsd ?? 0) + cost;
		};
		const lines: string[] = [];
		const warnings: string[] = [];
		const progressWarnings: string[] = [];
		const reportProgressFailure = (error: unknown) => {
			const message = `slate: progress callback failed — ${sanitizeForNotify(error instanceof Error ? error.message : String(error), 200)}`;
			if (progressWarnings.includes(message)) return;
			progressWarnings.push(message);
			warnings.push(message);
			lines.push(`⚠ ${message}`);
		};
		const emit = (done: boolean, status?: "ok" | "failed") => {
			try {
				onProgress?.({ threadId: thread.id, threadName: thread.name, lines, usage, done, status });
			} catch (error) {
				reportProgressFailure(error);
			}
		};

		let session: WorkerSession | undefined;
		/** The worker session this action opened, kept readable after a failed open. */
		let startupSession: WorkerSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let onAbort: (() => void) | undefined;
		let messagesBefore = 0;
		let actionCompacted = false;
		/** The refusal of this action, reported to the caller exactly once. */
		let reportedRefusal: string | undefined;
		let workerCallStarted = false;
		let observationOrder = 0;
		let cancellationObservation: { kind: "caller" | "session teardown"; order: number } | undefined;
		let startupFailureOrder: number | undefined;
		let startupFailureDetail: string | undefined;
		const reportedStartupDetails: string[] = [];
		const startupWarningPrefix = "slate: worker extension startup failed — ";
		const lifecycleWarnings: string[] = [];
		const observeCancellation = (kind: "caller" | "session teardown") => {
			if (cancellationObservation !== undefined) return;
			cancellationObservation = { kind, order: ++observationOrder };
		};
		const observeStartupFailure = () => {
			if (startupFailureOrder === undefined) startupFailureOrder = ++observationOrder;
		};
		const isStartupWarning = (message: string) => /worker extension (?:startup failed|failed to load)/u.test(message);
		const isLifecycleWarning = (message: string) => /worker (?:extension (?:startup|shutdown) failed|session disposal failed|extension failed to load)/u.test(message);
		const appendLifecycleWarnings = (message: string): string => {
			const reports: string[] = [];
			if (lifecycleWarnings.length > 0) reports.push(`Lifecycle failures: ${lifecycleWarnings.join(" ")}`);
			if (progressWarnings.length > 0) reports.push(`Progress callback failures: ${progressWarnings.join(" ")}`);
			return reports.length === 0 ? message : `${message} ${reports.join(" ")}`;
		};
		const cancellationReason = (): string =>
			cancellationObservation?.kind === "caller"
				? "cancelled by the caller"
				: cancellationObservation?.kind === "session teardown"
					? "cancelled during session teardown"
					: signal?.aborted === true ? "cancelled by the caller" : "cancelled during session teardown";
		const startupCancellation = () =>
			startupFailureOrder !== undefined &&
			cancellationObservation !== undefined &&
			cancellationObservation.order < startupFailureOrder &&
			reportedRefusal === undefined;
		let completedWorkerText: string | undefined;
		let latestAssistant: WorkerAssistantMsg | undefined;
		// Keep observed errors outside Pi's projected history. A retry or a successful
		// overflow continuation supersedes only the attempt it actually replaces.
		const terminalCandidates: WorkerAssistantMsg[] = [];
		let overflowContinuation: WorkerAssistantMsg | undefined;
		let retryingCandidate: WorkerAssistantMsg | undefined;
		let captureExecutionReports = false;
		let executionReport: string | undefined;
		const completedFacts = createCompletedFactRecorder();
		let frozenCompletedFacts: FrozenCompletedFacts | undefined;
		let status: "ok" | "failed" = "ok";
		let diagnostics: string | undefined;
		let ordinarySucceededBeforeSettlement = false;
		let settlementRefusal: string | undefined;
		/** The selected logical route. It changes only after proved physical exhaustion. */
		let logicalRoute = initialRoute;
		let lastExecution: { model: { provider: string; id: string }; effort: LogicalModelEffort } | undefined;
		const requestContract = createWorkerRequestContract();
		/** Set ONLY by an apply-time rejection: end the dispatch with no episode and no compression. */
		let aborted: DispatchAbort | undefined;
		const retryEvidence = new WorkerRetryEvidence();
		// Routing notices go to BOTH channels: the progress lines (so they are visible
		// while the action runs) and the tool result (so the ORCHESTRATOR reads them —
		// a cost cliff or an evidence gap is its decision to make, not the user's).
		const routeWarn = (message: string) => {
			if (isStartupWarning(message)) {
				if (message.startsWith(startupWarningPrefix)) reportedStartupDetails.push(message.slice(startupWarningPrefix.length));
				if (this.teardownStarted) observeCancellation("session teardown");
				observeStartupFailure();
			}
			if (isLifecycleWarning(message)) lifecycleWarnings.push(message);
			warnings.push(message);
			lines.push(`⚠ ${message}`);
			if (captureExecutionReports && executionReport === undefined) executionReport = message;
		};
		// ONE action-scoped refusal report at the managed request boundary. Worker
		// startup, initial work, a later turn, recovery continuation and worker
		// history compaction all cross the same contract, so no event position needs
		// its own detector. The FIRST observation stops this action: the reader below
		// runs before the ordinary prompt, before logical recovery and after the
		// action settles. A refusal makes the action fail visibly, and no later
		// success may replace that result. The contract itself refuses every later
		// request of a refused action, so a continuation that races this reader
		// cannot reach a provider either.
		const captureRefusal = (): string | undefined => {
			const refusal = requestContract.refusal();
			if (refusal !== undefined && reportedRefusal === undefined) {
				reportedRefusal = refusal;
				routeWarn(refusal);
			}
			return reportedRefusal;
		};
		// The early check uses the final assistant after prompt settles to decide
		// recovery. Pi strips recovered transient errors from session.messages.
		// Terminal failures retained from included work take precedence at freeze.
		// Thrown prompts and orchestrator aborts also fail the action.
		const deriveOutcome = (thrown?: { error: unknown }) => {
			const final = latestAssistant ?? lastAssistantMessage(session ? session.messages.slice(messagesBefore) : []);
			if (signal?.aborted) {
				return { status: "failed" as const, diagnostics: "aborted by orchestrator", final };
			}
			if (thrown) {
				const msg = thrown.error instanceof Error ? thrown.error.message : String(thrown.error);
				return { status: "failed" as const, diagnostics: msg, final };
			}
			if (!final) {
				const noResponse = "worker produced no assistant message";
				return {
					status: "failed" as const,
					diagnostics: executionReport === undefined ? noResponse : `${noResponse}. ${executionReport}`,
					final,
				};
			}
			if (final.stopReason === "error" || final.stopReason === "aborted") {
				return {
					status: "failed" as const,
					diagnostics: final.errorMessage ?? `worker stopReason: ${final.stopReason}`,
					final,
				};
			}
			return { status: "ok" as const, diagnostics: undefined, final };
		};

		const observeWorkerEvent = (event: { type: string; [k: string]: unknown }) => {
			retryEvidence.observe(event);
			if (event.type === "message_update") {
				// Streaming deltas are deliberately not completed facts.
			} else if (event.type === "tool_execution_start") {
				lines.push(`→ ${(event as unknown as { toolName: string }).toolName}`);
				emit(false);
			} else if (event.type === "tool_execution_end") {
				const tool = event as unknown as { toolName: string; result: unknown; isError: boolean };
				completedFacts.addTool(tool.toolName, tool.result, tool.isError);
			} else if (event.type === "auto_retry_start") {
				// Keep the failed attempt until another assistant response actually replaces it.
				// Pi can cancel during backoff without producing a replacement message.
				retryingCandidate = terminalCandidates.at(-1) === latestAssistant ? latestAssistant : undefined;
			} else if (event.type === "auto_retry_end") {
				retryingCandidate = undefined;
			} else if (event.type === "compaction_end") {
				if (event.result !== undefined && event.aborted !== true) actionCompacted = true;
				if (event.reason === "overflow" && event.willRetry === true && event.result !== undefined &&
					terminalCandidates.at(-1) === latestAssistant) {
					overflowContinuation = latestAssistant;
				}
				if (seenCompactionEvents.has(event)) return;
				seenCompactionEvents.add(event);
				const compactionEvent = event as unknown as {
					result?: { usage?: EpisodeUsage & { cost?: { total?: number } } };
					aborted?: boolean;
				};
				addCompactionUsage(compactionEvent.result?.usage);
			} else if (event.type === "message_end") {
				const msg = (event as unknown as { message: WorkerAssistantMsg }).message;
				if (msg.role !== "assistant") return;
				latestAssistant = msg;
				if (retryingCandidate !== undefined && retryingCandidate !== msg) {
					const replaced = terminalCandidates.indexOf(retryingCandidate);
					if (replaced !== -1) terminalCandidates.splice(replaced, 1);
					retryingCandidate = undefined;
				}
				if (overflowContinuation !== undefined) {
					const replaced = terminalCandidates.indexOf(overflowContinuation);
					if (replaced !== -1) terminalCandidates.splice(replaced, 1);
					overflowContinuation = undefined;
				}
				if (msg.stopReason === "error" || msg.stopReason === "aborted") terminalCandidates.push(msg);
				const emittedText = completedFacts.addAssistant(msg.content, msg.stopReason);
				if (/\S/u.test(emittedText)) completedWorkerText = emittedText;
				usage.turns++;
				usage.input += msg.usage?.input ?? 0;
				usage.output += msg.usage?.output ?? 0;
				addEpisodeUsage("input", msg.usage?.input);
				addEpisodeUsage("output", msg.usage?.output);
				addEpisodeUsage("cacheRead", msg.usage?.cacheRead);
				addEpisodeUsage("cacheWrite", msg.usage?.cacheWrite);
				const reportedCost = msg.usage?.cost?.total;
				if (reportedCost !== undefined) {
					workerCostUsd = (workerCostUsd ?? 0) + reportedCost;
					usage.cost += reportedCost;
				}
				const contextTokens = msg.usage?.totalTokens;
				if (typeof contextTokens === "number" && Number.isFinite(contextTokens) && Number.isInteger(contextTokens) && contextTokens >= 0) {
					reportedContextTokens = contextTokens;
					usage.contextTokens = contextTokens;
				}
				const text = emittedText.replace(/\s+/g, " ").trim();
				if (text) lines.push(text.length > 120 ? `${text.slice(0, 120)}...` : text);
				emit(false);
			}
		};

		thread.status = "running";
		thread.updatedAt = Date.now();
		try {
			this.store.save();
		} catch (error) {
			this.store.threads.delete(thread.id);
			try { this.store.save(); } catch { /* the in-memory rollback remains authoritative */ }
			throw new Error(
				`Slate could not start thread ${thread.id}: ${sanitizeForNotify(error instanceof Error ? error.message : String(error), 200)}. ` +
					"Nothing ran and no episode was recorded.",
			);
		}

		try {
			emit(false);
			if (!logicalRoute || !admission || !this.logicalRuntime) throw new DispatchAbort("Logical route admission was lost before worker startup.");
			const queuedValidation = await this.logicalRuntime.validateRoute(ctx, logicalRoute);
			if (!queuedValidation.ok) throw new DispatchAbort(`Logical worker startup stopped before billed work: ${queuedValidation.reason}`);
			const open = planSessionOpen(logicalRoute);
			requestContract.expect(logicalRoute);
			onAbort = () => {
				observeCancellation("caller");
				requestContract.invalidate();
				const ownedSession = session ?? startupSession;
				ownedSession?.closeManagedOperations?.();
				void ownedSession?.abort().catch(() => {});
			};
			if (signal?.aborted === true) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			try {
				({ session } = await this.openWorkerFor({
					thread,
					ctx,
					open,
					tools: thread.tools,
					report: routeWarn,
					requestContract,
					reviewGuidance,
					observeStartupFailure: (detail) => {
						if (this.teardownStarted) observeCancellation("session teardown");
						observeStartupFailure();
						// worker.ts rethrows this exact aggregate after reporting each handler
						// error. Only that replay is redundant. Loader warnings do not cover
						// a later direct failure, such as a built-in-tool collision.
						const reportedAggregate = `slate: worker extension startup did not complete: ${reportedStartupDetails.join("; ")}`;
						if (reportedStartupDetails.length === 0 || detail !== reportedAggregate) startupFailureDetail = detail;
					},
					observeSession: (created) => {
						startupSession = created;
						if (unsubscribe === undefined) unsubscribe = created.subscribe(observeWorkerEvent);
					},
				}));
			} catch (error) {
				if (this.teardownStarted) observeCancellation("session teardown");
				throw error;
			}
			if (signal?.aborted === true) throw new DispatchAbort("Logical worker startup was cancelled by the caller.");
			if (this.live.get(thread.id) !== session) throw new DispatchAbort("Logical worker startup was cancelled during session teardown.");
			// Worker startup crosses this same request owner. A refusal recorded there
			// ends the action HERE, so no ordinary request follows the refused one.
			// The action owns the startup work of its own worker session, so that work
			// stays inside the action slice. The catch below records the accepted pair,
			// the refusal and the completed startup output of this failed action.
			const refusedAtStartup = captureRefusal();
			if (refusedAtStartup !== undefined) throw new Error(refusedAtStartup);
			try { session.setThinkingLevel(logicalRoute.effort); }
			catch (error) {
				throw new DispatchAbort(`Logical worker startup could not apply fixed effort: ${sanitizeForNotify(error instanceof Error ? error.message : String(error), 200)}.`);
			}
			const appliedValidation = await this.logicalRuntime.validateRoute(ctx, logicalRoute);
			if (!appliedValidation.ok) throw new DispatchAbort(`Logical worker startup stopped before billed work: ${appliedValidation.reason}`);

			messagesBefore = session.messages.length;
			// Startup assistant messages remain completed facts, but they cannot
			// classify the ordinary task or a slash command that returns no response.
			latestAssistant = undefined;
			executionReport = undefined;
			terminalCandidates.length = 0;
			overflowContinuation = undefined;
			retryingCandidate = undefined;
			session.resetIncludedOperationFailure?.();
			// Test doubles that bypass openWorkerFor's callback still receive capture.
			if (unsubscribe === undefined) unsubscribe = session.subscribe(observeWorkerEvent);

			if (signal?.aborted) throw new Error("aborted before worker start");

			// Attempt 1. Pi owns retries on this physical route. Route validation may
			// await credential work, so capture the final live route and effort only
			// after it settles. Keep capture and prompt invocation in one synchronous
			// path so an extension callback cannot change the selection between them.
			retryEvidence.reset();
			const applied = this.captureAppliedRoute(session, logicalRoute);
			if (!applied.ok) throw new DispatchAbort(`Logical worker startup stopped before billed work: ${applied.reason}`);
			let thrown: { error: unknown } | undefined;
			try {
				captureExecutionReports = true;
				const promptRun = session.prompt(prompt);
				// COMMIT POINT: prompt execution has started. A caller may no longer
				// roll this dispatch back or repeat its action on another thread.
				workerCallStarted = true;
				await promptRun;
			} catch (error) {
				thrown = { error };
			}
			lastExecution = requestContract.latestAccepted();
			let outcome = deriveOutcome(thrown);
			// A refusal from worker startup or from this prompt, including one inside
			// automatic history compaction, is a terminal fault for this action. It
			// therefore starts no logical recovery and no substitute request.
			const refusedBeforeRecovery = captureRefusal();
			({ status, diagnostics } = outcome);


			// Logical recovery starts only after direct Pi events prove that retries on
			// the current physical route are exhausted. The same worker session and its
			// transcript are retained. Only the continuation nudge is added.
			const recoverySession = session;
			const isAborted = () => signal?.aborted === true;
			const initialAttempt = refusedBeforeRecovery !== undefined
				? { kind: "terminal-fault" as const, reason: refusedBeforeRecovery }
				: thrown !== undefined && !isAborted()
					? { kind: "unknown" as const, reason: "The worker prompt threw without cancellation evidence." }
				: outcome.final === undefined
					? { kind: "terminal-fault" as const, reason: outcome.diagnostics ?? "The worker produced no assistant response." }
				: lastExecution === undefined
					? { kind: "unknown" as const, reason: outcome.diagnostics ?? "The worker prompt has no validated physical execution facts." }
					: retryEvidence.classify({
						final: outcome.final,
						value: outcome.final,
						actualEffort: lastExecution.effort,
						aborted: isAborted(),
						contextWindow: recoverySession.model?.contextWindow,
					});
			if (initialAttempt.kind === "retry-exhausted") {
				const retainedToolResults = recoverySession.messages.slice(messagesBefore).filter((message) => (message as { role?: unknown }).role === "toolResult");
				const recoveryAttempts = new Set<WorkerAssistantMsg>();
				if (outcome.final !== undefined) recoveryAttempts.add(outcome.final);
				const recovery = await executeRecovery({
					candidates: this.logicalRuntime.planOrdinary(logicalRoute.logicalModel, admission.snapshot, logicalRoute),
					retainedToolResults,
					validateSwitch: (candidate) => this.logicalRuntime!.validateRoute(ctx, candidate),
					attempt: async ({ candidate, retainedToolResults: retained }) => {
						if (isAborted() || this.live.get(thread.id) !== recoverySession) return { kind: "cancelled" as const };
						const beforeToolResults = recoverySession.messages.filter((message) => (message as { role?: unknown }).role === "toolResult");
						if (retained.some((message) => !beforeToolResults.includes(message))) {
							return { kind: "unknown" as const, reason: "A retained tool result disappeared before logical recovery." };
						}
						retryEvidence.reset();
						try {
							await recoverySession.setModel(resolveModel(ctx, `${candidate.provider}/${candidate.model}`));
							recoverySession.setThinkingLevel(candidate.effort);
						} catch (error) {
							return { kind: "terminal-fault" as const, reason: `The recovery route could not be applied: ${sanitizeForNotify(error instanceof Error ? error.message : String(error), 200)}.` };
						}
						if (isAborted() || this.live.get(thread.id) !== recoverySession) return { kind: "cancelled" as const };
						const recoveryValidation = await this.logicalRuntime!.validateRoute(ctx, candidate);
						if (!recoveryValidation.ok) return { kind: "terminal-fault" as const, reason: recoveryValidation.reason };
						if (isAborted() || this.live.get(thread.id) !== recoverySession) return { kind: "cancelled" as const };
						// No Slate-owned await may separate this final capture from prompt().
						const recoveryApplied = this.captureAppliedRoute(recoverySession, candidate);
						if (!recoveryApplied.ok) return { kind: "terminal-fault" as const, reason: recoveryApplied.reason };
						requestContract.expect(candidate);
						this.failoverLive.set(thread.id, `${recoveryApplied.model.provider}/${recoveryApplied.model.id}`);
						let retryThrow: { error: unknown } | undefined;
						try { await recoverySession.prompt(FAILOVER_NUDGE); } catch (error) { retryThrow = { error }; }
						lastExecution = requestContract.latestAccepted();
						const retryOutcome = deriveOutcome(retryThrow);
						outcome = retryOutcome;
						// Recovery may replace failures in its ordinary attempt chain, not
						// other included turns. Wait for proved recovery success below.
						// A refused recovery request, including a refused compaction inside
						// this prompt, ends the operation. No further candidate may replace it.
						const refusedRecovery = captureRefusal();
						if (refusedRecovery !== undefined) return { kind: "terminal-fault" as const, reason: refusedRecovery };
						if (retryThrow !== undefined && !isAborted()) return { kind: "unknown" as const, reason: "The recovery prompt threw without cancellation evidence." };
						const classified = retryEvidence.classify({
							final: retryOutcome.final,
							value: retryOutcome.final,
							actualEffort: recoveryApplied.effort,
							aborted: isAborted(),
							contextWindow: recoverySession.model?.contextWindow,
						});
						if (classified.kind === "retry-exhausted" && retryOutcome.final !== undefined) recoveryAttempts.add(retryOutcome.final);
						return classified;
					},
				});
				if (recovery.kind === "success") {
					// Every exhausted route is one attempt in this ordinary recovery chain.
					// Leave failures from other included work in their observed order.
					for (const recoveredAttempt of recoveryAttempts) {
						const replaced = terminalCandidates.indexOf(recoveredAttempt);
						if (replaced !== -1) terminalCandidates.splice(replaced, 1);
					}
					logicalRoute = recovery.candidate;
					status = "ok";
					diagnostics = undefined;
				} else {
					status = "failed";
					diagnostics = recovery.kind === "unknown" || recovery.kind === "terminal-fault"
						? recovery.reason
						: recovery.kind === "cancelled" ? "logical recovery was cancelled" : "all permitted logical recovery routes were exhausted";
				}
			} else if (initialAttempt.kind !== "success") {
				status = "failed";
				diagnostics = initialAttempt.kind === "unknown"
					? initialAttempt.reason
					: initialAttempt.kind === "cancelled" ? "worker action was cancelled" : diagnostics;
			}
			// The last read of the same owner. It records the refusal of an action whose
			// work already stopped at the reader that observed it first. A refused action
			// is failed here whatever the classified outcome said.
			const refusedDuringAction = captureRefusal();
			if (refusedDuringAction !== undefined) {
				status = "failed";
				diagnostics = refusedDuringAction;
			}

		} catch (error) {
			// The ONE non-billed exit (module header). Everything else in this method —
			// including a session that could not be opened — keeps its historical
			// behaviour of becoming a FAILED episode, because by then the action was
			// attempted; a DispatchAbort is raised only from the pre-prompt routing
			// phase, where nothing has been spent, so it must not manufacture work.
			if (this.teardownStarted) observeCancellation("session teardown");
			if (error instanceof DispatchAbort) {
				aborted = signal?.aborted === true
					? new DispatchAbort("Logical worker startup was cancelled by the caller.")
					: error;
			} else {
				status = "failed";
				const failure = error instanceof Error ? error.message : String(error);
				// A refusal latched on this owner survives a failed opening, and a startup
				// error is an independent fact. Report both, and each one exactly once.
				const refused = captureRefusal();
				diagnostics = refused === undefined || refused === failure ? failure : `${failure}; ${refused}`;
				// A request that startup already accepted keeps its physical facts. A
				// prompt that ran recorded its own facts, and those stay unchanged.
				if (lastExecution === undefined) lastExecution = requestContract.latestAccepted();
				// The action owns the worker session it opened, so a failed opening keeps
				// that transcript readable for the failed result. This adoption starts no
				// lifetime: openWorkerSession already shut such a session down, and every
				// later shutdown of the same session is memoized.
				if (session === undefined) session = startupSession;
			}
		} finally {
			ordinarySucceededBeforeSettlement = workerCallStarted && status === "ok";
			const ownedSession = session ?? startupSession;
			requestContract.invalidate();
			ownedSession?.closeManagedOperations?.();
			await ownedSession?.settleManagedOperations?.();
			if (session === undefined) session = startupSession;
			if (lastExecution === undefined) lastExecution = requestContract.latestAccepted();
			settlementRefusal = captureRefusal();
			if (settlementRefusal !== undefined) {
				status = "failed";
				diagnostics = diagnostics === undefined || diagnostics.includes(settlementRefusal)
					? diagnostics ?? settlementRefusal
					: `${diagnostics}; ${settlementRefusal}`;
			}
			frozenCompletedFacts = completedFacts.freeze();
			// Only the settled, frozen action gets a stored outcome. The early
			// outcome above decides retry and recovery, not durable success.
			if (workerCallStarted && status === "ok") {
				const terminal = terminalCandidates[0];
				const failure = ownedSession?.includedOperationFailure?.() ??
					(terminal?.errorMessage ?? (terminal ? `worker stopReason: ${terminal.stopReason}` : undefined));
				if (failure !== undefined) {
					status = "failed";
					diagnostics = failure;
				} else {
					const settled = deriveOutcome();
					if (settled.status === "failed") {
						status = "failed";
						diagnostics = settled.diagnostics;
					}
				}
			}
			captureExecutionReports = false;
			unsubscribe?.();
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}

		if (startupFailureDetail !== undefined) {
			routeWarn(`${startupWarningPrefix}${sanitizeForNotify(startupFailureDetail, 200)}`);
		}
		const cancelledDuringStartup = startupCancellation();

		if (aborted && frozenCompletedFacts?.hasFacts) {
			status = "failed";
			diagnostics = diagnostics ?? aborted.message;
			aborted = undefined;
		}

		if (aborted) {
			// Apply-time rejection occurs before the worker call. Remove the accepted
			// placeholder so an unbilled abort leaves neither a thread nor an episode.
			this.store.threads.delete(thread.id);
			try {
				this.store.save();
			} catch {
				/* the in-memory removal remains authoritative */
			} finally {
				await this.closeWorker(thread.id, session);
			}
			throw new Error(appendLifecycleWarnings(aborted.message));
		}

		const cancelledAfterStart = workerCallStarted &&
			(signal?.aborted === true || (session !== undefined && this.live.get(thread.id) !== session));
		const cancelledAction = cancelledDuringStartup || cancelledAfterStart;
		if (cancelledAction && frozenCompletedFacts?.hasFacts) {
			status = "failed";
			if (cancelledDuringStartup) diagnostics = cancellationReason();
			else if (ordinarySucceededBeforeSettlement && settlementRefusal === undefined) diagnostics = cancellationReason();
			else diagnostics ??= cancellationReason();
		}
		if (cancelledAction && !frozenCompletedFacts?.hasFacts) {
			const reason = cancelledDuringStartup ? cancellationReason() : signal?.aborted === true ? "cancelled by the caller" : "cancelled during session teardown";
			thread.status = "cancelled";
			thread.outcomeReason = reason;
			thread.updatedAt = Date.now();
			let cancellationSaveError: unknown;
			try {
				this.store.save();
			} catch (error) {
				cancellationSaveError = error;
			} finally {
				await this.closeWorker(thread.id, session);
			}
			if (cancellationSaveError !== undefined) {
				throw new Error(appendLifecycleWarnings(`Thread ${thread.id} was ${reason}, and Slate could not save that terminal state: ${sanitizeForNotify(cancellationSaveError instanceof Error ? cancellationSaveError.message : String(cancellationSaveError), 200)}.`));
			}
			throw new Error(appendLifecycleWarnings(`Thread ${thread.id} was ${reason}. No episode was recorded.`));
		}

		if (status === "ok" && admission && logicalRoute) {
			this.logicalRuntime!.publishProvider(admission, logicalRoute.logicalModel, logicalRoute.provider);
		}
		const actionMessages = session ? session.messages.slice(messagesBefore) : [];
		if (workerReminderDeliveryMissing(
			actionMessages,
			session?.workerReminderHandledToolResult?.() === true,
			actionCompacted,
		)) {
			routeWarn("slate: a worker tool result reached the reminder handler, but the reminder is missing. Review the worker transcript before you rely on the result.");
			emit(false);
		}
		const compressionMessages = messagesForCompression(
			actionMessages,
			normalizeContextEpisodeIds(opts.contextEpisodeIds).length > 0 ? prompt : undefined,
		);

		// Keep facts from the last route that actually reached prompt execution.
		// A rejected recovery switch must not replace the prior execution history.
		const ranModel = lastExecution?.model;
		const actualModel = ranModel ? `${ranModel.provider}/${ranModel.id}` : undefined;
		const actualEffort = lastExecution?.effort;

		// An event-local response flag and recorded billing survive host rewrites of
		// session.messages. Either selects compression even when the rewritten slice
		// no longer contains an assistant message. A reported zero cost still proves
		// that a call produced billing evidence.
		const actionHasBillingEvidence =
			workerCostUsd !== undefined ||
			compactionCostUsd !== undefined ||
			Object.values(compactionUsage).some((quantity) => quantity > 0);
		if (status === "failed" && !frozenCompletedFacts?.hasFacts && !actionHasBillingEvidence) {
			const reason = diagnostics ?? "the worker action failed";
			const totalActionCost = usage.cost + (compactionCostUsd ?? 0);
			let failed: ReturnType<typeof writeFailedEpisode>;
			try {
				failed = writeFailedEpisode({
					ctx, episodeId, threadId: thread.id, threadName: thread.name, task: opts.task,
					diagnostics: reason, workerModel: ranModel, workerCostUsd: totalActionCost, runtimeFolder: this.runtimeFolder,
				});
			} catch (error) {
				const storageCause = error instanceof EpisodePersistenceError ? error.originalError : error;
				const storageDetail = sanitizeForNotify(storageCause instanceof Error ? storageCause.message : String(storageCause), 200);
				const storageReason = `failure episode persistence failed: ${storageDetail}`;
				thread.status = "failed";
				thread.outcomeReason = `${reason}; ${storageReason}`;
				thread.updatedAt = Date.now();
				this.store.workerCostUsd += totalActionCost;
				let saveError: unknown;
				try { this.store.save(); } catch (error) { saveError = error; }
				if (saveError !== undefined) {
					thread.outcomeReason += `; thread state persistence failed: ${sanitizeForNotify(saveError instanceof Error ? saveError.message : String(saveError), 200)}`;
				}
				emit(true, "failed");
				await this.closeWorker(thread.id, session);
				const saveDetail = saveError === undefined ? "" : ` Slate could not save its terminal thread state: ${sanitizeForNotify(saveError instanceof Error ? saveError.message : String(saveError), 200)}.`;
				throw new Error(appendLifecycleWarnings(`Thread ${thread.id} failed: ${sanitizeForNotify(reason, 200)}. Slate could not store episode ${episodeId}: ${storageDetail}.${saveDetail}`));
			}
			const episode: EpisodeRecord = {
				id: episodeId, threadId: thread.id, task: opts.task, status: "failed", file: failed.file,
				reason: opts.reason!, logicalModel: opts.model!,
				...(initialRoute ? { requestedModel: `${initialRoute.provider}/${initialRoute.model}`, requestedEffort: initialRoute.effort } : {}),
				...(actualModel ? { model: actualModel } : {}),
				...(actualEffort ? { effort: actualEffort } : {}), ...episodeUsage,
				...(reportedContextTokens !== undefined ? { contextTokens: reportedContextTokens } : {}),
				...(workerCostUsd !== undefined ? { workerCostUsd } : {}),
				...(Object.keys(compactionUsage).length > 0 ? { compactionUsage } : {}),
				...(compactionCostUsd !== undefined ? { compactionCostUsd } : {}), createdAt: Date.now(),
			};
			this.store.episodes.set(episodeId, episode);
			thread.episodeId = episodeId;
			thread.status = "failed";
			thread.outcomeReason = reason;
			thread.updatedAt = Date.now();
			this.store.workerCostUsd += totalActionCost;
			let saveError: unknown;
			try { this.store.save(); } catch (error) { saveError = error; }
			await this.closeWorker(thread.id, session);
			if (saveError !== undefined) {
				emit(true, "failed");
				throw new Error(appendLifecycleWarnings(`Slate stored episode ${episodeId}, but could not save its thread record: ${sanitizeForNotify(saveError instanceof Error ? saveError.message : String(saveError), 200)}.`));
			}
			emit(true, "failed");
			return { episodeText: failed.text, episode, thread, usage, warnings };
		}
		// Capture before compression so an episode-write failure does not itself
		// remove the exact output. The returned union is the single source for the
		// path, byte count, truncation fact and structural grammar result.
		//
		// BG6: this feature must NEVER fail a dispatch and never fail an episode, so
		// EVERY step of it sits inside one guard — reading the final message,
		// extracting its text, the capture, both warnings and the progress emit.
		// The guard used to cover only the two fs calls inside captureObservation, so
		// a throw from any other step escaped, left the thread stuck "running" and
		// lost the episode the action had already paid for. The fallback below is the
		// answer to a throw: it is the same not-stored fact a failed write records,
		// because both mean there is no file to point at.
		let observation: ObservationCapture | ObservationRecord = {
			stored: false,
			reason: "write-failed",
			grammar: "absent",
			zeroFindings: false,
		};
		try {
			const finalMessage = lastAssistantMessage(actionMessages);
			observation = captureObservation(ctx.cwd, episodeId, finalMessage ? (finalMessage.content ?? []) : undefined, this.runtimeFolder);
			const warningsBeforeObservation = warnings.length;
			if (!observation.stored && observation.reason === "write-failed" && "warning" in observation) routeWarn(observation.warning);
			const judgementType = isJudgementThreadType(thread.type);
			// SE1: the id can come from a restored snapshot, so every observation
			// warning uses the shared notification sanitizer.
			const safeEpisodeId = sanitizeForNotify(episodeId, 80);
			if (judgementType && !observation.stored && observation.reason === "no-final-message") {
				routeWarn(
					`slate: episode ${safeEpisodeId} produced no final response, so no compact findings row is available.`,
				);
			} else if (judgementType && !observation.stored && observation.reason === "no-final-text") {
				routeWarn(
					`slate: episode ${safeEpisodeId}'s final response contained no text blocks, so no compact findings row is available.`,
				);
			} else if (shouldWarnFindingsGrammar(
				status,
				judgementType,
				observation.grammar,
				"zeroFindings" in observation && observation.zeroFindings,
			)) {
				const responseScope = observation.stored ? "stored final response" : "final response";
				if (observation.grammar === "absent") {
					routeWarn(
						`slate: episode ${safeEpisodeId}'s ${responseScope} has no pipe-delimited findings row. Use exactly five fields for each finding. Put a file and line or line range in the location field, with no pipe character. Otherwise end with the exact line No findings.`,
					);
				} else {
					routeWarn(
						`slate: episode ${safeEpisodeId}'s ${responseScope} has a malformed findings row. Use exactly five pipe-delimited fields for each finding. Put a file and line or line range in the location field, with no pipe character.`,
					);
				}
			}
			if (warnings.length > warningsBeforeObservation) emit(false);
		} catch (error) {
			// Reporting is BEST EFFORT on purpose: the throw may have come from the
			// progress channel itself, and the dispatch must survive a broken one.
			// Whatever `observation` holds by now is kept — a capture that succeeded
			// before a later step threw keeps its real facts.
			try {
				routeWarn(
					`slate: could not record observations for episode ${sanitizeForNotify(episodeId, 80)} — ` +
						sanitizeForNotify(error instanceof Error ? error.message : String(error)),
				);
			} catch {
				/* nothing about an observation may end a dispatch */
			}
		}
		const durableObservations = durableObservation(observation);

		let compressed: Awaited<ReturnType<typeof compressEpisode>>;
		try {
			compressed = await compressEpisode({
				runtimeFolder: this.runtimeFolder,
				ctx,
				episodeId,
				threadId: thread.id,
				threadName: thread.name,
				task: opts.task,
				status,
				diagnostics,
				messages: compressionMessages as unknown[],
				observations: durableObservations,
				workerModel: ranModel,
				workerEffort: actualEffort,
				completedText: completedWorkerText,
				completedFacts: frozenCompletedFacts,
				logicalRuntime: this.logicalRuntime!,
				admission: admission!,
				retryPolicy: this.compressorRetryPolicy,
				signal,
			});
		} catch (error) {
			// The live session has grown, but no episode will publish its new cache and
			// prefix evidence. The next choice must not reuse the older measurements.
			// Compression includes the episode-file write. If that write fails, the
			// earlier observation normally becomes an unreferenced orphan. It remains
			// until the user removes it. Persist every cost and recoverable session fact.
			//
			// A later session can reuse the id after snapshot repair drops a thread,
			// snapshot repair rebuilds a stale episode counter, or the process exits
			// before this increment is saved. A storing dispatch at that id overwrites
			// the orphan through writeFreshFile's unlink-and-recreate path. Known accepted
			// limitation: a non-storing dispatch (no-final-message, no-final-text or
			// write-failed) leaves stale prose while its episode header says "not stored".
			//
			// Never add failure-time rollback or orphan sweeping. Measurements on ext4
			// showed that inode reuse after unlink makes dev-plus-ino and strengthened
			// timestamp identities delete a later live file. writeFreshFile replaces the
			// canonical name only while storing the new artifact. Detached cleanup cannot
			// prove ownership and must not delete that name.
			this.store.workerCostUsd +=
				usage.cost +
				(error instanceof EpisodePersistenceError ? (error.costUsd ?? 0) : 0) +
				(compactionCostUsd ?? 0);
			const actionFailure = diagnostics ?? "the worker action failed";
			const storageCause = error instanceof EpisodePersistenceError ? error.originalError : undefined;
			const storageDetail = storageCause === undefined
				? undefined
				: sanitizeForNotify(storageCause instanceof Error ? storageCause.message : String(storageCause), 200);
			const compressionDetail = sanitizeForNotify(error instanceof Error ? error.message : String(error), 200);
			thread.status = "failed";
			thread.outcomeReason = storageDetail === undefined
				? compressionDetail
				: status === "failed"
					? `${actionFailure}; failure episode persistence failed: ${storageDetail}`
					: `failure episode persistence failed: ${storageDetail}`;
			thread.updatedAt = Date.now();
			let saveError: unknown;
			try { this.store.save(); } catch (error) { saveError = error; }
			if (saveError !== undefined) {
				thread.outcomeReason += `; thread state persistence failed: ${sanitizeForNotify(saveError instanceof Error ? saveError.message : String(saveError), 200)}`;
			}
			await this.closeWorker(thread.id, session);
			const safeEpisodeId = sanitizeForNotify(episodeId, 80);
			lines.push(`✗ slate could not store episode ${safeEpisodeId}.`);
			emit(true, "failed");
			const persistenceMessage = storageDetail !== undefined
				? status === "failed"
					? `Thread ${thread.id} failed: ${sanitizeForNotify(actionFailure, 200)}. Slate could not store episode ${safeEpisodeId}: ${storageDetail}.`
					: `Slate could not store episode ${safeEpisodeId}: ${storageDetail}.`
				: `slate could not store episode ${safeEpisodeId}.`;
			const saveDetail = saveError === undefined
				? ""
				: ` Slate could not save its thread record: ${sanitizeForNotify(saveError instanceof Error ? saveError.message : String(saveError), 200)}.`;
			throw new Error(appendLifecycleWarnings(`${persistenceMessage}${saveDetail}`));
		}

		const episode: EpisodeRecord = {
			id: episodeId,
			threadId: thread.id,
			task: opts.task,
			status,
			file: compressed.file,
			reason: opts.reason!,
			logicalModel: opts.model!,
			...(initialRoute ? { requestedModel: `${initialRoute.provider}/${initialRoute.model}`, requestedEffort: initialRoute.effort } : {}),
			...(actualModel ? { model: actualModel } : {}),
			...(actualEffort ? { effort: actualEffort } : {}),
			observations: durableObservations,
			...episodeUsage,
			...(reportedContextTokens !== undefined ? { contextTokens: reportedContextTokens } : {}),
			...(workerCostUsd !== undefined ? { workerCostUsd } : {}),
			...(compressed.compressorUsage ? { compressorUsage: compressed.compressorUsage } : {}),
			...(compressed.costUsd !== undefined ? { compressorCostUsd: compressed.costUsd } : {}),
			...(Object.keys(compactionUsage).length > 0 ? { compactionUsage } : {}),
			...(compactionCostUsd !== undefined ? { compactionCostUsd } : {}),
			createdAt: Date.now(),
		};
		this.store.episodes.set(episodeId, episode);
		thread.episodeId = episodeId;
		thread.status = status === "failed" ? "failed" : "successful";
		if (status === "failed") thread.outcomeReason = diagnostics ?? "the worker action failed";
		thread.updatedAt = Date.now();
		// Accumulate session-wide worker spend, including compression and compaction,
		// BEFORE save so it persists with the snapshot.
		this.store.workerCostUsd += usage.cost + (compressed.costUsd ?? 0) + (compactionCostUsd ?? 0);
		let saveError: unknown;
		try {
			this.store.save();
		} catch (error) {
			saveError = error;
		} finally {
			await this.closeWorker(thread.id, session);
		}
		if (saveError !== undefined) {
			emit(true, "failed");
			throw new Error(appendLifecycleWarnings(`Slate stored episode ${episodeId}, but could not save its thread record: ${sanitizeForNotify(saveError instanceof Error ? saveError.message : String(saveError), 200)}.`));
		}

		emit(true, status);
		return { episodeText: compressed.text, episode, thread, usage, warnings };
	}

	async disposeAll(): Promise<void> {
		if (this.teardownPromise !== undefined) return this.teardownPromise;
		// Close both admission boundaries before the first await. Running dispatches
		// retain persistence ownership and converge on their shared finalizer.
		this.teardownStarted = true;
		const contracts = [...this.requestContracts.values()];
		this.requestContracts.clear();
		for (const contract of contracts) contract.invalidate();
		const live = [...this.live.entries()];
		const openings = [...this.openingWorkers];
		const alreadyClosing = [...this.closingWorkers];
		const actionFinalizers = new Map(this.actionFinalizers);
		for (const [, session] of live) {
			session.closeManagedOperations?.();
			void session.abort?.().catch(() => {});
		}
		this.live.clear();
		this.openingWorkers.clear();
		this.failoverLive.clear();
		this.teardownPromise = (async () => {
			const orphanClosures = live
				.filter(([threadId]) => !actionFinalizers.has(threadId))
				.map(([threadId, session]) => this.closeWorker(threadId, session));
			await Promise.allSettled([
				...actionFinalizers.values(),
				...orphanClosures,
				...openings,
				...alreadyClosing,
			]);
		})();
		return this.teardownPromise;
	}
}
