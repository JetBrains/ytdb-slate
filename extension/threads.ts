/**
 * ThreadManager: dispatch lifecycle (ExecPlan M1).
 *
 * One dispatch = one bounded action on one thread:
 *   resolve/create thread → per-thread FIFO queue → global semaphore →
 *   open/reuse worker session → inject context episodes → prompt →
 *   compress the new messages into an episode (ok or FAILED) → update store.
 *
 * Parallelism happens ACROSS threads (pi runs sibling tool calls
 * concurrently); a single thread is a serial work stream (D9).
 */

import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compressEpisode } from "./episodes.ts";
import { isAuthFailure, isFailoverCandidate, resolveMappedModel } from "./failover.ts";
import type { EpisodeRecord, SlateConfig, SlateStore, ThreadRecord } from "./state.ts";
import { openWorkerSession, type WorkerSession } from "./worker.ts";
import { EMPTY_WORKER_EXTENSION_SET, type WorkerExtensionSet } from "./worker-extensions.ts";

export interface DispatchOptions {
	threadId?: string;
	name?: string;
	task: string;
	contextEpisodeIds?: string[];
	model?: string;
	tools?: string[];
}

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
}

/** Loose shape of an assistant message as seen in session.messages / message_end. */
interface WorkerAssistantMsg {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
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

/** Continuation nudge for the post-failover re-prompt (same live session, context intact). */
const FAILOVER_NUDGE =
	"The previous attempt was interrupted by a model API failure. The conversation context is intact " +
	"and partial changes may exist — verify the current state, then complete the original action.";

class Semaphore {
	private waiters: Array<() => void> = [];
	private active = 0;
	constructor(private limit: number) {}
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
	/** threadId → "provider/id" a LIVE session was switched to by model failover (AF12). */
	private failoverLive = new Map<string, string>();
	private queues = new Map<string, Promise<unknown>>();
	private semaphore: Semaphore;

	constructor(
		private store: SlateStore,
		private config: SlateConfig,
		// This session's frozen worker-extension resolver (AD41), bound BY VALUE at
		// construction (CN20) so a manager orphaned by a session swap keeps its own
		// session's set instead of resolving against a later one's. Read lazily per
		// new worker. Defaults to the empty-set function so existing construction
		// sites and test harnesses keep working with the feature off.
		private resolveExtensions: () => WorkerExtensionSet = () => EMPTY_WORKER_EXTENSION_SET,
	) {
		this.semaphore = new Semaphore(config.maxConcurrent ?? 4); // default rationale: docs/design-principles.md §5 repo-local note
	}

	getConfig(): SlateConfig {
		return this.config;
	}

	/**
	 * The "provider/id" a thread's LIVE session runs after a model failover,
	 * undefined when none happened or the session has since been disposed.
	 * Failover is deliberately NOT persisted to ThreadRecord.model. A reopen
	 * normally reverts to the configured model because worker.ts passes an
	 * explicit model (thread.model, else the host's current model) which
	 * overrides the session file — EXCEPT when both are absent (no thread.model
	 * and a model-less host session): the SDK then restores the session file's
	 * last model_change, which can be the mapped model (CQ3).
	 */
	liveFailoverModel(threadId: string): string | undefined {
		return this.live.has(threadId) ? this.failoverLive.get(threadId) : undefined;
	}

	async dispatch(
		opts: DispatchOptions,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
	): Promise<DispatchResult> {
		// Pause blocks only NEW dispatches — in-flight ones already hold their
		// queue slot and are allowed to finish (their episodes still get written).
		if (this.store.paused) {
			throw new Error(
				"Slate is paused for handoff: the context budget was exceeded and new dispatches are rejected. " +
					"Reply to the user with a handoff brief (overall goal, per-thread state with episode ids, immediate next actions) " +
					"and ask them to run /slate handoff [focus] to continue in a fresh session.",
			);
		}
		const thread = this.resolveThread(opts);

		// Per-thread FIFO: chain onto the previous dispatch for this thread.
		const prev = this.queues.get(thread.id) ?? Promise.resolve();
		const run = prev
			.catch(() => undefined) // a failed predecessor must not poison the queue
			.then(() => this.runDispatch(thread, opts, ctx, signal, onProgress));
		this.queues.set(thread.id, run);
		return run;
	}

	private resolveThread(opts: DispatchOptions): ThreadRecord {
		if (opts.threadId) {
			const existing = this.store.threads.get(opts.threadId);
			if (!existing) {
				const known = [...this.store.threads.keys()].join(", ") || "none";
				throw new Error(`Unknown thread "${opts.threadId}". Known threads: ${known}. Omit "thread" to create a new one.`);
			}
			return existing;
		}
		const id = this.store.nextThreadId();
		const record: ThreadRecord = {
			id,
			name: opts.name?.trim() || id,
			sessionFile: "",
			status: "idle",
			model: opts.model,
			episodeIds: [],
			episodeSeq: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.store.threads.set(id, record);
		this.store.save();
		return record;
	}

	private buildPrompt(opts: DispatchOptions): string {
		const contextIds = opts.contextEpisodeIds ?? [];
		if (contextIds.length === 0) return opts.task;
		const parts: string[] = ["## Context from prior episodes (injected by the orchestrator)", ""];
		for (const id of contextIds) {
			const episode = this.store.episodes.get(id);
			if (!episode) throw new Error(`Unknown episode "${id}". Known: ${[...this.store.episodes.keys()].join(", ") || "none"}`);
			parts.push(readFileSync(episode.file, "utf8").trim(), "");
		}
		parts.push("## Action", "", opts.task);
		return parts.join("\n");
	}

	private async runDispatch(
		thread: ThreadRecord,
		opts: DispatchOptions,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
	): Promise<DispatchResult> {
		const prompt = this.buildPrompt(opts); // may throw on unknown episode ids (before any state change)
		await this.semaphore.acquire();
		try {
			return await this.runDispatchInner(thread, opts, prompt, ctx, signal, onProgress);
		} finally {
			this.semaphore.release();
		}
	}

	private async runDispatchInner(
		thread: ThreadRecord,
		opts: DispatchOptions,
		prompt: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress?: (p: DispatchProgress) => void,
	): Promise<DispatchResult> {
		const usage: UsageStats = { turns: 0, input: 0, output: 0, cost: 0, contextTokens: 0 };
		const lines: string[] = [];
		const emit = (done: boolean, status?: "ok" | "failed") =>
			onProgress?.({ threadId: thread.id, threadName: thread.name, lines, usage, done, status });

		let session: WorkerSession | undefined;
		let unsubscribe: (() => void) | undefined;
		let onAbort: (() => void) | undefined;
		let messagesBefore = 0;
		let status: "ok" | "failed" = "ok";
		let diagnostics: string | undefined;

		// AF3: status/diagnostics derive from the FINAL assistant message of this
		// action after prompt() settles — not from a sticky message_end flag. This
		// fixes a latent bug: pi retries transient provider errors internally and
		// strips the recovered errored attempts from session.messages, so an
		// errored message_end mid-run does NOT mean the action failed. Thrown
		// prompt() exceptions and orchestrator aborts still mean failed.
		const deriveOutcome = (thrown?: { error: unknown }) => {
			const final = lastAssistantMessage(session ? session.messages.slice(messagesBefore) : []);
			if (signal?.aborted) {
				return { status: "failed" as const, diagnostics: "aborted by orchestrator", final };
			}
			if (thrown) {
				const msg = thrown.error instanceof Error ? thrown.error.message : String(thrown.error);
				return { status: "failed" as const, diagnostics: msg, final };
			}
			if (!final) {
				return { status: "failed" as const, diagnostics: "worker produced no assistant message", final };
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

		try {
			thread.status = "running";
			thread.updatedAt = Date.now();
			this.store.save();
			emit(false);

			session = this.live.get(thread.id);
			if (!session) {
				// A NEW session gets the CURRENT frozen worker-extension set. A LIVE
				// cached session (reused when present) keeps whatever set it was opened
				// with — which is precisely why the resolution is frozen per session
				// (AD41): every worker in this session then shares one extension set.
				session = await openWorkerSession({
					ctx,
					sessionFile: thread.sessionFile || undefined,
					model: thread.model,
					tools: opts.tools ?? this.config.workerTools,
					promptDocs: this.config.workerPromptDocs,
					extensionPaths: this.resolveExtensions().paths,
				});
				this.live.set(thread.id, session);
				// A freshly opened session starts on its configured model — drop any
				// stale failover marker (possible if a previous live session was
				// disposed mid-dispatch after its marker was set).
				this.failoverLive.delete(thread.id);
				if (!thread.sessionFile && session.sessionFile) {
					thread.sessionFile = session.sessionFile;
					this.store.save();
				}
			}

			messagesBefore = session.messages.length;

			unsubscribe = session.subscribe((event: { type: string; [k: string]: unknown }) => {
				if (event.type === "tool_execution_start") {
					lines.push(`→ ${(event as unknown as { toolName: string }).toolName}`);
					emit(false);
				} else if (event.type === "message_end") {
					// Usage accumulation + progress lines ONLY — outcome is derived
					// after prompt() settles (see deriveOutcome above, AF3).
					const msg = (event as unknown as { message: WorkerAssistantMsg }).message;
					if (msg.role !== "assistant") return;
					usage.turns++;
					usage.input += msg.usage?.input ?? 0;
					usage.output += msg.usage?.output ?? 0;
					usage.cost += msg.usage?.cost?.total ?? 0;
					usage.contextTokens = msg.usage?.totalTokens ?? usage.contextTokens;
					const text = (msg.content ?? [])
						.filter((c) => c.type === "text")
						.map((c) => c.text ?? "")
						.join(" ")
						.trim();
					if (text) lines.push(text.length > 120 ? `${text.slice(0, 120)}...` : text);
					emit(false);
				}
			});

			if (signal?.aborted) throw new Error("aborted before worker start");
			onAbort = () => void session?.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			// Attempt 1.
			let thrown: { error: unknown } | undefined;
			try {
				await session.prompt(prompt);
			} catch (error) {
				thrown = { error };
			}
			let outcome = deriveOutcome(thrown);
			({ status, diagnostics } = outcome);

			// Model failover — single hop, at most ONCE per dispatch: when the
			// attempt failed with a model-API error (never an abort or a context
			// overflow — see failover.ts) or prompt() threw AND the current model
			// now fails its auth check (state-based classification, AF10), switch
			// the LIVE session to the mapped model and re-prompt once. Usage keeps
			// accumulating through the same subscriber, and messagesBefore is
			// unchanged (same session), so the episode covers both attempts.
			const current = session.model;
			if (status === "failed" && !signal?.aborted && current) {
				// CN1/BG1 + CN2: every await below is a window in which the dispatch
				// can be aborted or this manager disposed. The abort listener cannot
				// cover it — session.abort() no-ops on an idle session — and a
				// DISPOSED worker session does not throw on setModel/prompt (workers
				// load no extensions, so the SDK's assertActive guard never fires on
				// this path). Re-check both hazards before each side effect; an abort
				// or disposal anywhere in the window means NO retry.
				const retryBlocked = () => signal?.aborted === true || this.live.get(thread.id) !== session;
				const candidate =
					isFailoverCandidate(outcome.final, current.contextWindow) ||
					(thrown !== undefined && (await isAuthFailure(ctx, current)));
				const mapped = candidate
					? await resolveMappedModel(ctx, this.config.modelFailover ?? {}, current.provider, current.id)
					: undefined;
				if (mapped && !retryBlocked()) {
					lines.push(`⚠ failover ${current.provider}/${current.id} ⇒ ${mapped.provider}/${mapped.id}`);
					emit(false);
					let switched = false;
					try {
						await session.setModel(mapped); // can throw on a failed live auth check
						switched = true;
					} catch {
						/* keep the original failure */
					}
					if (switched) {
						// The live session now runs the mapped model — sticky until the
						// session is disposed (ThreadRecord.model stays as configured);
						// record it for the threads listing (AF12).
						this.failoverLive.set(thread.id, `${mapped.provider}/${mapped.id}`);
					}
					// Re-check after the setModel await. If the signal has NOT fired,
					// the once-listener is still armed, so a retry that does start
					// remains abortable (a fire in the microtask gap between this check
					// and prompt() startup is the residual race inherent to
					// AbortSignal listeners).
					if (switched && !retryBlocked()) {
						thrown = undefined;
						try {
							await session.prompt(FAILOVER_NUDGE);
						} catch (error) {
							thrown = { error };
						}
						outcome = deriveOutcome(thrown);
						({ status, diagnostics } = outcome);
						// CQ2: an aborted retry is an abort, not a failover failure.
						if (status === "failed" && !signal?.aborted) {
							diagnostics = `${diagnostics} (failover to ${mapped.provider}/${mapped.id} also failed)`;
						}
					}
				}
				// CQ2: an abort that landed anywhere in this failover window surfaces
				// as an abort (deriveOutcome checks the signal first) — never as the
				// stale attempt-1 error or a "failover also failed". Disposal without
				// abort keeps the attempt-1 outcome.
				if (signal?.aborted) ({ status, diagnostics } = deriveOutcome(thrown));
			}
		} catch (error) {
			status = "failed";
			diagnostics = error instanceof Error ? error.message : String(error);
		} finally {
			unsubscribe?.();
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}

		const actionMessages = session ? session.messages.slice(messagesBefore) : [];

		const episodeId = `${thread.id}.e${++thread.episodeSeq}`;
		const compressed = await compressEpisode({
			ctx,
			episodeId,
			threadId: thread.id,
			threadName: thread.name,
			task: opts.task,
			status,
			diagnostics,
			messages: actionMessages as unknown[],
			workerModel: session?.model ? { provider: session.model.provider, id: session.model.id } : undefined,
			configuredModel: this.config.episodeModel,
			modelFailover: this.config.modelFailover,
			signal: signal?.aborted ? undefined : signal,
		});

		const episode: EpisodeRecord = {
			id: episodeId,
			threadId: thread.id,
			task: opts.task,
			status,
			file: compressed.file,
			createdAt: Date.now(),
		};
		this.store.episodes.set(episodeId, episode);
		thread.episodeIds.push(episodeId);
		thread.status = "idle";
		thread.updatedAt = Date.now();
		// Accumulate session-wide worker spend (worker turns + episode compressor)
		// BEFORE save so it persists with the snapshot.
		this.store.workerCostUsd += usage.cost + compressed.costUsd;
		this.store.save();

		emit(true, status);

		return { episodeText: compressed.text, episode, thread, usage };
	}

	disposeAll(): void {
		for (const session of this.live.values()) {
			try {
				session.dispose();
			} catch {
				/* ignore */
			}
		}
		this.live.clear();
		this.failoverLive.clear(); // markers describe live sessions only (see liveFailoverModel)
	}
}
