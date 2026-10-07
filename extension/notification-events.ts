import { AsyncLocalStorage } from "node:async_hooks";
import type { ContextEditEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notificationSettings, type NotificationSettings } from "./notification-config.ts";
import { NotificationDispatcher, type NotificationChannel, type NotificationDispatcherOptions } from "./notification-dispatcher.ts";

/** Read finalized branch text. Aborted responses and omitted attempts do not count as completed text. */
function latestCompletedMessage(ctx: ExtensionContext) {
	const edits = new Map<string, ContextEditEntry["replacement"]>();
	const visited = new Set<string>();
	let entry = ctx.sessionManager.getLeafEntry();
	while (entry && !visited.has(entry.id)) {
		visited.add(entry.id);
		if (entry.type === "context_edit" && !edits.has(entry.targetId)) edits.set(entry.targetId, entry.replacement);
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "aborted") {
			const edit = edits.get(entry.id);
			if (edit !== null) return edit ? { ...entry.message, content: edit.content } : entry.message;
		}
		entry = entry.parentId ? ctx.sessionManager.getEntry(entry.parentId) : undefined;
	}
	return undefined;
}

/** Register activity before handoff and mode. Earlier extensions can hide input by handling it. */
export function registerNotificationEvents(pi: ExtensionAPI, options: {
	currentLifecycle: () => boolean;
	recovering: () => boolean;
	channels?: readonly NotificationChannel[] | ((ctx: ExtensionContext, settings: NotificationSettings, warn: (message: string) => void) => readonly NotificationChannel[]);
	now?: NotificationDispatcherOptions["now"];
	schedule?: NotificationDispatcherOptions["schedule"];
}) {
	let dispatcher: NotificationDispatcher | undefined;
	let unsubscribe: (() => void) | undefined;
	let liveConfig: object | undefined;
	let suspendedConfig: object | undefined;
	let observedRun = false;
	// Each Slate handoff claims one before-event. Inherited callbacks can start other requests.
	const ownRequest = new AsyncLocalStorage<{ claimed: boolean }>();
	let ownPending = 0, foreignPending = false, generation = 0;
	const restore = (ctx: ExtensionContext) => {
		if (suspendedConfig && ownPending === 0 && !foreignPending) start(suspendedConfig, ctx, observedRun);
	};
	const signals = new Set<AbortSignal>();
	const activity = () => { dispatcher?.activity(); };
	const observeSignal = (signal: AbortSignal | undefined) => {
		if (!observedRun || !signal) return;
		signals.add(signal);
		dispatcher?.observeSignal(signal);
	};
	const retireDispatcher = () => {
		dispatcher?.retire();
		dispatcher = undefined;
		try { unsubscribe?.(); } catch { /* The obsolete listener cannot affect its retired dispatcher. */ }
		unsubscribe = undefined;
	};
	const reset = (preserveRun = false) => {
		retireDispatcher();
		liveConfig = suspendedConfig = undefined;
		// Failover consumes this evidence even when notification policy is restored mid-run.
		if (!preserveRun) { observedRun = false; signals.clear(); }
	};
	const retire = () => {
		generation++;
		ownPending = 0;
		foreignPending = false;
		reset();
	};
	const start = (config: object, ctx: ExtensionContext, preserveRun = false) => {
		reset(preserveRun);
		if (ctx.mode !== "tui" || !options.currentLifecycle()) return;
		const settings = notificationSettings(config);
		const warn = (message: string) => { if (ctx.hasUI) ctx.ui.notify(message, "warning"); else console.warn(message); };
		const channels = typeof options.channels === "function" ? options.channels(ctx, settings, warn) : options.channels ?? [];
		const owned: NotificationDispatcher = new NotificationDispatcher({
			mode: ctx.mode, cwd: ctx.cwd, settings, channels, warn,
			current: () => dispatcher === owned && options.currentLifecycle(),
			idle: () => ctx.isIdle(), queued: () => ctx.hasPendingMessages(), recovering: options.recovering,
			now: options.now, schedule: options.schedule,
		});
		dispatcher = owned;
		liveConfig = config;
		// resetExtensionUI clears subscriptions. Every session_start installs a fresh listener.
		try { unsubscribe = ctx.ui.onTerminalInput(() => { try { owned.activity(); } catch { /* Input stays unchanged. */ } return undefined; }); }
		catch { /* No usable terminal listener in this context. */ }
	};
	const suspend = () => {
		const request = ownRequest.getStore();
		if (!request || request.claimed) foreignPending = true;
		else request.claimed = true;
		suspendedConfig = liveConfig ?? suspendedConfig;
		liveConfig = undefined;
		// A later handler can cancel replacement. Failover still needs the active run's signals.
		retireDispatcher();
	};
	const submission = (_event: unknown, ctx: ExtensionContext) => {
		// Pi gives no final result for replacements Slate did not start.
		// Such a request can still await a later handler when idle input clears its flag.
		if (suspendedConfig && ctx.isIdle()) { foreignPending = false; restore(ctx); }
		activity();
	};
	pi.on("input", (event, ctx) => { if (event.source === "interactive") submission(event, ctx); });
	pi.on("user_bash", activity);
	pi.on("session_before_switch", suspend);
	pi.on("session_before_fork", suspend);
	pi.on("session_before_tree", activity);
	pi.on("session_tree", activity);
	pi.on("model_select", activity);
	pi.on("thinking_level_select", activity);
	pi.on("session_info_changed", activity);
	pi.on("session_before_compact", (event, ctx) => {
		if (event.reason === "manual") activity();
		if (event.reason === "overflow") observeSignal(event.signal);
		observeSignal(ctx.signal);
	});
	pi.on("agent_start", (_event, ctx) => {
		observedRun = true;
		signals.clear();
		dispatcher?.runStart(ctx.signal);
		observeSignal(ctx.signal);
	});
	const observeContext = (_event: unknown, ctx: ExtensionContext) => { observeSignal(ctx.signal); };
	pi.on("turn_start", observeContext);
	pi.on("message_start", observeContext);
	pi.on("agent_end", observeContext);
	pi.on("message_end", observeContext);
	pi.on("turn_end", (event, ctx) => {
		observeSignal(ctx.signal);
		// Pi has applied every message_end replacement to this finalized object.
		if (event.message.role === "assistant") dispatcher?.message(event.message);
	});
	pi.on("ui_prompt_start", (_event, ctx) => {
		if (!dispatcher) return;
		// Persistence follows all message_end replacements and precedes tool execution.
		// During message_end itself, only the previous persisted response is available.
		// The newest context edit wins, including content replacement and omission.
		try { dispatcher.dialogMessage(latestCompletedMessage(ctx)); }
		catch { dispatcher.dialogMessage(undefined); }
		dispatcher.dialog(true);
	});
	pi.on("ui_prompt_end", () => { dispatcher?.dialog(false); });
	return {
		retire,
		cancelled: () => [...signals].some((signal) => signal.aborted),
		recoveryFinished: () => { dispatcher?.recoveryFinished(); },
		start,
		/** Own the entire handoff, including its idle wait. Retirement invalidates late results. */
		async ownReplacement<T>(ctx: ExtensionContext, request: () => Promise<T>): Promise<T> {
			const lifecycle = generation;
			ownPending++;
			try { return await ownRequest.run({ claimed: false }, request); }
			finally {
				if (lifecycle === generation) {
					ownPending--;
					try { restore(ctx); } catch { /* A stale context cannot start fresh policy. */ }
				}
			}
		},
		/** Register after failover so recovery ownership is visible before settlement arms a wait. */
		registerSettlement() {
			pi.on("agent_settled", (_event, ctx) => {
				observeSignal(ctx.signal);
				try { dispatcher?.settled(); }
				finally { observedRun = false; signals.clear(); }
			});
		},
	};
}
