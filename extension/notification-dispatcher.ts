import type { NotificationSettings } from "./notification-config.ts";
import { notificationText, type NotificationEvent, type NotificationText } from "./notification-protocols.ts";
import { classifyRunOutcome } from "./run-outcome.ts";

export interface NotificationMessage {
	readonly role: string;
	readonly stopReason?: unknown;
	readonly errorMessage?: string;
	readonly content?: string | readonly { readonly type: string; readonly text?: string }[];
}
export interface NotificationChannel {
	readonly name: "terminal" | "native" | "bell" | "push";
	/** Prepare without accepting delivery. The returned function starts delivery. */
	prepare(text: NotificationText, signal: AbortSignal): Promise<() => void | Promise<void>>;
}
export interface NotificationDispatcherOptions {
	readonly mode: string;
	readonly cwd: string;
	readonly settings: NotificationSettings;
	readonly channels: readonly NotificationChannel[];
	readonly current: () => boolean;
	readonly idle: () => boolean;
	readonly queued: () => boolean;
	readonly recovering: () => boolean;
	readonly now?: () => number;
	readonly schedule?: (delay: number, callback: () => void) => () => void;
}
interface Wait { readonly kind: "run" | "dialog"; readonly event: NotificationEvent; readonly since: number; cancel?: () => void }
interface Attempt { readonly controller: AbortController; cancel: () => void; started: boolean }
// A retired session keeps its process-wide channel slot until its started work settles.
const inFlightAttempts = new Map<NotificationChannel["name"], Attempt>();
const schedule = (delay: number, callback: () => void): (() => void) => {
	const timer = setTimeout(callback, Math.min(delay, 2_147_483_647));
	timer.unref();
	return () => clearTimeout(timer);
};

/** Retain only the bounded text suffix when admission permits message detail. */
function messageTail(message: NotificationMessage | undefined, error: boolean): string {
	const content = message?.content;
	if (typeof content === "string" && content.length > 0) return content.slice(-400);
	let text = "";
	if (Array.isArray(content)) {
		for (let i = content.length - 1; i >= 0 && Buffer.byteLength(text) < 200; i--) {
			const part = content[i];
			if (part?.type === "text" && part.text) text = `${part.text.slice(-400)}${text ? "\n" + text : ""}`;
		}
	}
	return text || (error ? message?.errorMessage?.slice(-400) ?? "" : "");
}

/** One dispatcher owns waits, cooldowns, message references and channel attempts for one session. */
export class NotificationDispatcher {
	readonly #options: NotificationDispatcherOptions;
	readonly #now: () => number;
	readonly #schedule: NonNullable<NotificationDispatcherOptions["schedule"]>;
	#retired = false;
	#activity: number;
	#run?: Wait;
	#dialog?: Wait;
	#starts = 0;
	#ends = 0;
	#observedRun = false;
	#settled = false;
	#runMessage?: NotificationMessage;
	#lastMessage?: NotificationMessage;
	readonly #signals = new Set<AbortSignal>();
	readonly #cooldowns = new Map<NotificationEvent, number>();
	readonly #attempts = new Map<NotificationChannel["name"], Attempt>();

	constructor(options: NotificationDispatcherOptions) {
		this.#options = options;
		this.#now = options.now ?? (() => performance.now());
		this.#schedule = options.schedule ?? schedule;
		this.#activity = this.#now();
	}
	#current(): boolean {
		try { return !this.#retired && this.#options.mode === "tui" && this.#options.current(); }
		catch { return false; }
	}
	#recovering(): boolean {
		try { return this.#options.recovering(); }
		catch { return true; }
	}
	/** Record activity time without reading or retaining terminal input. */
	activity(): void { if (!this.#retired) this.#activity = this.#now(); }
	#cancel(kind: "run" | "dialog"): void {
		const wait = kind === "run" ? this.#run : this.#dialog;
		wait?.cancel?.();
		if (kind === "run") this.#run = undefined;
		else this.#dialog = undefined;
	}
	runStart(signal?: AbortSignal): void {
		if (!this.#current()) return;
		this.#cancel("run");
		this.#observedRun = true;
		this.#settled = false;
		this.#runMessage = undefined;
		this.#signals.clear();
		this.observeSignal(signal);
	}
	observeSignal(signal?: AbortSignal): void { if (!this.#retired && this.#observedRun && signal) this.#signals.add(signal); }
	message(message: NotificationMessage): void {
		if (message.role !== "assistant" || !this.#current()) return;
		this.#lastMessage = message;
		if (this.#observedRun) this.#runMessage = message;
	}
	/** Dialog text does not change the current run's outcome evidence. */
	dialogMessage(message: NotificationMessage | undefined): void {
		if (this.#current()) this.#lastMessage = message?.role === "assistant" ? message : undefined;
	}
	settled(): void {
		if (!this.#current() || !this.#observedRun || this.#settled) return;
		this.#settled = true;
		this.recoveryFinished();
	}
	/** Release main-session recovery ownership before calling this method. */
	recoveryFinished(): void {
		if (!this.#current() || !this.#settled || !this.#observedRun || this.#recovering()) return;
		this.#observedRun = false;
		const outcome = classifyRunOutcome(this.#runMessage, [...this.#signals].some((signal) => signal.aborted));
		this.#signals.clear();
		if (outcome !== "cancelled") this.#arm("run", outcome === "error" ? "error" : "input-needed");
	}
	dialog(start: boolean): void {
		if (!this.#current()) return;
		const wasOpen = this.#starts > this.#ends;
		if (start) this.#starts++;
		else this.#ends++;
		const open = this.#starts > this.#ends;
		if (!open) this.#cancel("dialog");
		else if (!wasOpen) this.#arm("dialog", "input-needed");
	}
	#arm(kind: Wait["kind"], event: NotificationEvent): void {
		const wait: Wait = { kind, event, since: this.#now() };
		if (kind === "run") this.#run = wait;
		else this.#dialog = wait;
		const expire = () => {
			if (this.#retired || (kind === "run" ? this.#run : this.#dialog) !== wait) return;
			const remaining = this.#options.settings.minimumDelayMs - (this.#now() - Math.max(wait.since, this.#activity));
			if (remaining > 0) { wait.cancel = this.#schedule(remaining, expire); return; }
			// Extension message transforms can supply throwing getters. Timer failures stay local.
			try { this.#admit(wait); } catch { this.#cancel(kind); }
		};
		wait.cancel = this.#schedule(this.#options.settings.minimumDelayMs, expire);
	}
	#admit(wait: Wait): void {
		this.#cancel(wait.kind);
		const options = this.#options, settings = options.settings, now = this.#now();
		try {
			if (!this.#current() || (wait.kind === "run"
				? !options.idle() || options.queued() || this.#recovering()
				: this.#starts <= this.#ends)) return;
		} catch { return; }
		if (now - (this.#cooldowns.get(wait.event) ?? -Infinity) < settings.cooldownMs) return;
		const channels = options.channels.filter((channel) => channel.name === "push" ? settings.push.enabled : settings[channel.name]);
		if (channels.length === 0) return;
		// Admission is synchronous. All channels share this fixed choice and cooldown.
		this.#cooldowns.set(wait.event, now);
		const message = wait.kind === "run" ? this.#runMessage : this.#lastMessage;
		const needsMessage = channels.some((channel) => channel.name === "push" ? settings.pushDetail === "message" : channel.name !== "bell" && settings.detail === "message");
		const tail = needsMessage ? messageTail(message, wait.event === "error") : "";
		const general = notificationText(wait.event, settings.detail, options.cwd, tail);
		const push = notificationText(wait.event, settings.pushDetail, options.cwd, tail);
		for (const channel of channels) {
			if (inFlightAttempts.has(channel.name)) continue;
			const controller = new AbortController();
			const attempt: Attempt = { controller, cancel: () => {}, started: false };
			inFlightAttempts.set(channel.name, attempt);
			this.#attempts.set(channel.name, attempt);
			attempt.cancel = this.#schedule(0, () => {
				if (attempt.started || inFlightAttempts.get(channel.name) !== attempt) return;
				if (!this.#current()) { this.#release(channel.name, attempt); return; }
				attempt.started = true;
				void (async () => {
					try {
						const text = channel.name === "bell" ? Object.freeze({ title: "", body: "" }) : channel.name === "push" ? push : general;
						const deliver = await channel.prepare(text, controller.signal);
						if (this.#current() && !controller.signal.aborted) await deliver();
					} catch { /* Delivery failure never enters session entries or model context. */ }
					finally { this.#release(channel.name, attempt); }
				})();
			});
		}
	}
	#release(name: NotificationChannel["name"], attempt: Attempt): void {
		if (inFlightAttempts.get(name) === attempt) inFlightAttempts.delete(name);
		if (this.#attempts.get(name) === attempt) this.#attempts.delete(name);
	}
	/** Retire synchronously before any awaited session teardown. */
	retire(): void {
		this.#retired = true;
		this.#cancel("run");
		this.#cancel("dialog");
		for (const [name, attempt] of this.#attempts) {
			attempt.cancel(); attempt.controller.abort();
			if (!attempt.started) this.#release(name, attempt);
		}
		this.#signals.clear();
		this.#runMessage = this.#lastMessage = undefined;
	}
}
