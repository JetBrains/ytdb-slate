// =============================================================================
// slate — shared test fakes for Track 01 (dispatch-substrate)
// =============================================================================
// A0's whole job: build the fakes A2-A5 all need, once, so they do not each
// invent their own. Three fakes live here:
//
//   · createFakeExtensionAPI()     — captures pi.on(event, handler) by event
//     name and records every sendMessage/appendEntry call, IN OBSERVED ORDER,
//     not just as counts (several Track 01 invariants are about ordering and
//     about "exactly once per run", which a count alone cannot distinguish
//     from two runs of one call each — see AGENTS.md).
//   · createFakeExtensionContext() — a fake ExtensionContext whose `signal` is
//     a real AbortSignal a test can flip to aborted at a CHOSEN moment (mid
//     flight, not just "start aborted"), by calling the returned `abort()`.
//   · createFakeWorkerSession()    — a fake WorkerSession whose `prompt()`
//     calls stay pending until a test resolves or rejects them explicitly, or
//     is left deliberately unsettled to model a hung worker.
//
// Shape follows the capture-and-drive pattern already proven in this repo by
// verification/resolver-checks.mjs's `doctrine()` helper: a plain object
// implementing just the ExtensionAPI members the code under test calls, with
// `on` pushed into a handler map a test later invokes directly. This module
// does the same but as a reusable, typed, order-recording fake rather than a
// one-off inline object.
//
// node:test has NO default timeout. Every test that awaits a promise this
// module can leave pending (a session.prompt() call, in particular) MUST
// carry an explicit `{ timeout: ... }`, following the pattern on the waiter
// test in test/thread-manager.test.ts — copy that pattern, not a number.
// =============================================================================
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkerSession } from "../extension/worker.ts";

// --------------------------------------------------------------- fake pi.* --

/** One recorded pi.sendMessage call, in the shape sendMessage actually receives it. */
export interface RecordedSendMessageCall {
	kind: "sendMessage";
	/**
	 * Strictly increasing across BOTH sendMessage and appendEntry calls on the
	 * same fake — the shared counter is what lets a test assert relative
	 * ordering between the two kinds, not just within one kind.
	 */
	seq: number;
	message: { customType: string; content?: unknown; display?: unknown; details?: unknown };
	options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined;
}

/** One recorded pi.appendEntry call. */
export interface RecordedAppendEntryCall {
	kind: "appendEntry";
	seq: number;
	customType: string;
	data: unknown;
}

export type RecordedCall = RecordedSendMessageCall | RecordedAppendEntryCall;

export interface FakeExtensionAPI {
	/** Hand this to code under test as its `pi: ExtensionAPI`. */
	api: ExtensionAPI;
	/**
	 * Every `pi.on(event, handler)` registration, keyed by event name. A second
	 * registration for the same event OVERWRITES the first here, mirroring a
	 * real ExtensionAPI (one extension does not register the same event twice
	 * in this codebase; the map is not a multi-map on purpose).
	 */
	handlers: Map<string, (...args: unknown[]) => unknown>;
	/** Every sendMessage/appendEntry call, interleaved in the order they occurred. */
	calls: RecordedCall[];
	/** sendMessage calls only, still in their original relative order. */
	sendMessageCalls: RecordedSendMessageCall[];
	/** appendEntry calls only, still in their original relative order. */
	appendEntryCalls: RecordedAppendEntryCall[];
	/**
	 * Look up a captured handler by event name, cast to the caller's expected
	 * signature. Throws with a descriptive message when nothing registered for
	 * that event, so a test that expected the code under test to call
	 * `pi.on(event, ...)` gets a clear failure instead of the code under test
	 * silently never having fired — the exact failure mode this fake exists to
	 * make loud rather than silent.
	 */
	handler<H = (...args: unknown[]) => unknown>(event: string): H;
}

export function createFakeExtensionAPI(): FakeExtensionAPI {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const calls: RecordedCall[] = [];
	const sendMessageCalls: RecordedSendMessageCall[] = [];
	const appendEntryCalls: RecordedAppendEntryCall[] = [];
	let seq = 0;

	const api: Partial<ExtensionAPI> = {
		on: (event, h) => {
			handlers.set(event, h as (...args: unknown[]) => unknown);
		},
		sendMessage: (message, options) => {
			const call: RecordedSendMessageCall = {
				kind: "sendMessage",
				seq: seq++,
				message: message as RecordedSendMessageCall["message"],
				options: options as RecordedSendMessageCall["options"],
			};
			calls.push(call);
			sendMessageCalls.push(call);
		},
		appendEntry: (customType, data) => {
			const call: RecordedAppendEntryCall = { kind: "appendEntry", seq: seq++, customType, data };
			calls.push(call);
			appendEntryCalls.push(call);
		},
		sendUserMessage: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		getAllTools: () => [],
		getCommands: () => [],
		setModel: async () => true,
		setThinkingLevel: () => {},
	};

	return {
		api: api as unknown as ExtensionAPI,
		handlers,
		calls,
		sendMessageCalls,
		appendEntryCalls,
		handler<H>(event: string): H {
			const found = handlers.get(event);
			if (!found) {
				throw new Error(
					`createFakeExtensionAPI: no handler registered for "${event}" — the code under test never called pi.on("${event}", ...)`,
				);
			}
			return found as unknown as H;
		},
	};
}

// ------------------------------------------------------- fake ExtensionContext --

export interface FakeExtensionContextOptions {
	cwd?: string;
	mode?: ExtensionContext["mode"];
	hasUI?: boolean;
	isProjectTrusted?: () => boolean;
	/** Pre-existing signal to use instead of a fresh AbortController's. */
	signal?: AbortSignal;
}

export interface FakeExtensionContext {
	/** Hand this to code under test as its `ctx: ExtensionContext`. */
	ctx: ExtensionContext;
	/**
	 * Abort the context's signal NOW, at whatever point in the test's control
	 * flow this is called — including mid-await, between two awaited steps of
	 * the code under test. That precision (not just "construct pre-aborted") is
	 * the whole point: mid-flight abort is one of the defect classes Track 01
	 * exists to catch (I9's check-then-inject race).
	 */
	abort(reason?: unknown): void;
	/** Equivalent to `ctx.signal?.aborted`, exposed for readability at call sites. */
	isAborted(): boolean;
}

export function createFakeExtensionContext(options: FakeExtensionContextOptions = {}): FakeExtensionContext {
	const controller = new AbortController();
	const signal = options.signal ?? controller.signal;

	const ctx: Partial<ExtensionContext> = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? "/fake/cwd",
		model: undefined,
		scopedModels: [],
		thinkingLevel: undefined,
		isIdle: () => false,
		isProjectTrusted: options.isProjectTrusted ?? (() => true),
		signal,
		abort: () => controller.abort(),
		hasPendingMessages: () => false,
	};

	return {
		ctx: ctx as unknown as ExtensionContext,
		abort: (reason) => controller.abort(reason),
		isAborted: () => signal.aborted,
	};
}

// --------------------------------------------------------- fake WorkerSession --

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export type FakeSessionEvent = { type: string; [key: string]: unknown };

export type RecordedWorkerSessionCall =
	| { kind: "prompt"; text: unknown }
	| { kind: "setModel"; model: unknown }
	| { kind: "setThinkingLevel"; level: unknown }
	| { kind: "dispose" };

export interface FakeWorkerSessionOptions {
	model?: { provider: string; id: string };
	sessionFile?: string;
	messages?: unknown[];
}

export interface FakeWorkerSession {
	/** Hand this to code under test as its `session: WorkerSession`. */
	session: WorkerSession;
	/** Every call made on the fake session, in observed order. */
	calls: RecordedWorkerSessionCall[];
	/** True once `session.dispose()` has been called. */
	readonly disposed: boolean;
	/** Deliver `event` to every subscriber registered so far, in registration order. */
	emit(event: FakeSessionEvent): void;
	/**
	 * Resolve the OLDEST still-pending `session.prompt()` call (FIFO). Throws if
	 * none is pending, so a misordered test fails loudly instead of resolving
	 * the wrong call.
	 */
	resolvePrompt(value?: unknown): void;
	/** Reject the OLDEST still-pending `session.prompt()` call (FIFO). */
	rejectPrompt(error: unknown): void;
	/**
	 * How many `prompt()` calls are awaiting resolution. A test that wants a
	 * deliberately-hanging prompt (to model a mid-flight abort) asserts this is
	 * nonzero instead of leaving the test itself hanging — race the returned
	 * promise against a short timer under an explicit `{ timeout: ... }`
	 * instead of awaiting it directly.
	 */
	pendingPromptCount(): number;
}

export function createFakeWorkerSession(options: FakeWorkerSessionOptions = {}): FakeWorkerSession {
	const calls: RecordedWorkerSessionCall[] = [];
	const subscribers: Array<(event: FakeSessionEvent) => void> = [];
	const pendingPrompts: Array<Deferred<unknown>> = [];
	let model = options.model;
	let disposed = false;
	const messages = options.messages ?? [];

	const session: Partial<WorkerSession> = {
		get model() {
			return model as WorkerSession["model"];
		},
		sessionFile: options.sessionFile ?? "/fake/session.jsonl",
		messages: messages as WorkerSession["messages"],
		getContextUsage: () => undefined,
		subscribe: ((listener: (event: FakeSessionEvent) => void) => {
			subscribers.push(listener);
			return () => {
				const index = subscribers.indexOf(listener);
				if (index >= 0) subscribers.splice(index, 1);
			};
		}) as WorkerSession["subscribe"],
		prompt: ((text: unknown) => {
			calls.push({ kind: "prompt", text });
			const deferred = createDeferred<unknown>();
			pendingPrompts.push(deferred);
			return deferred.promise;
		}) as WorkerSession["prompt"],
		setModel: (async (next: unknown) => {
			calls.push({ kind: "setModel", model: next });
			model = next as { provider: string; id: string };
		}) as WorkerSession["setModel"],
		setThinkingLevel: ((level: unknown) => {
			calls.push({ kind: "setThinkingLevel", level });
		}) as WorkerSession["setThinkingLevel"],
		dispose: (() => {
			calls.push({ kind: "dispose" });
			disposed = true;
		}) as WorkerSession["dispose"],
	};

	return {
		session: session as unknown as WorkerSession,
		calls,
		get disposed() {
			return disposed;
		},
		emit(event) {
			for (const listener of [...subscribers]) listener(event);
		},
		resolvePrompt(value) {
			const deferred = pendingPrompts.shift();
			if (!deferred) throw new Error("createFakeWorkerSession: resolvePrompt called with no pending prompt() call");
			deferred.resolve(value);
		},
		rejectPrompt(error) {
			const deferred = pendingPrompts.shift();
			if (!deferred) throw new Error("createFakeWorkerSession: rejectPrompt called with no pending prompt() call");
			deferred.reject(error);
		},
		pendingPromptCount() {
			return pendingPrompts.length;
		},
	};
}
