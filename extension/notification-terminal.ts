import type { NotificationProtocol, NotificationSettings } from "./notification-config.ts";
import type { NotificationChannel } from "./notification-dispatcher.ts";
import { notificationSequences, wrapNotificationSequence } from "./notification-protocols.ts";
import { queryTmuxClients, selectTmuxNotificationProtocols } from "./notification-tmux.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type Output = Pick<NodeJS.WriteStream, "isTTY" | "write" | "on" | "removeListener">;

/** First matching identity wins, including identities with no automatic protocol. */
export function automaticNotificationProtocols(env: Environment): readonly NotificationProtocol[] {
	if (env.TERM === "xterm-ghostty") return ["osc777"];
	if (env.TERM === "xterm-kitty" || env.TERM?.startsWith("foot")) return ["osc99"];
	if (env.TERM === "alacritty") return [];
	switch (env.TERM_PROGRAM) {
		case "iTerm.app": return ["osc9"];
		case "WezTerm": case "ghostty": return ["osc777"];
		case "vscode": return ["osc99"];
		case "Alacritty": case "Apple_Terminal": return [];
	}
	if (env.LC_TERMINAL === "iTerm2") return ["osc9"];
	if (env.KITTY_WINDOW_ID) return ["osc99"];
	if (env.KONSOLE_VERSION) return ["osc777"];
	if (env.WT_SESSION || env.VTE_VERSION || env.GNOME_TERMINAL_SCREEN) return [];
	return [];
}

export interface TerminalNotificationOptions {
	readonly mode: string;
	readonly settings: Pick<NotificationSettings, "sequences">;
	readonly environment?: Environment;
	readonly projectDirectory?: string;
	readonly output?: Output;
	readonly warn: (message: string) => void;
	/** A bounded tmux client selector can supply automatic choices. Explicit lists bypass it. */
	readonly selectAutomatic?: (environment: Environment, signal: AbortSignal) => Promise<readonly NotificationProtocol[]>;
}

/** Issue complete writes together. Callbacks retain the channel slot without a write timeout. */
async function writeNotificationBuffers(output: Output, buffers: readonly Buffer[]): Promise<void> {
	if (buffers.length === 0) return;
	const onError = () => {}; // Write callbacks report errors without an uncaught stream error.
	output.on("error", onError);
	try {
		const results = await Promise.allSettled(buffers.map((buffer) => new Promise<void>((resolve, reject) => {
			output.write(buffer, (error?: Error | null) => { if (error) reject(error); else resolve(); });
		})));
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	} finally { output.removeListener("error", onError); }
}

/** Use pi's frame stream only. The dispatcher invokes delivery outside event and render handlers. */
export function createTerminalNotificationChannels(options: TerminalNotificationOptions): readonly NotificationChannel[] {
	const output = options.output ?? process.stdout, environment = options.environment ?? process.env;
	const selectAutomatic = options.selectAutomatic ?? (async (env: Environment, signal: AbortSignal) =>
		env.TMUX ? selectTmuxNotificationProtocols(await queryTmuxClients(env, signal, options.projectDirectory)) ?? automaticNotificationProtocols(env) : automaticNotificationProtocols(env));
	let suppressionReported = false;
	const usable = (signal: AbortSignal) => options.mode === "tui" && output.isTTY === true && !signal.aborted;
	return [
		{ name: "terminal", async prepare(text, signal) {
			let buffers: Buffer[] = [];
			if (usable(signal)) {
				const env: Environment = Object.freeze(Object.fromEntries([
					"TMUX", "TMUX_PANE", "PATH", "STY", "ZELLIJ", "TERM", "TERM_PROGRAM", "LC_TERMINAL",
					"KITTY_WINDOW_ID", "KONSOLE_VERSION", "WT_SESSION", "VTE_VERSION", "GNOME_TERMINAL_SCREEN",
				].map((name) => [name, environment[name]])));
				if ([env.TMUX, env.STY, env.ZELLIJ].filter(Boolean).length > 1) {
					if (!suppressionReported) {
						suppressionReported = true;
						try { options.warn("slate: terminal notification suppressed. Multiple multiplexer hints leave the route ambiguous."); }
						catch { /* A failed warning cannot disable the independent bell. */ }
					}
					return () => {};
				}
				let protocols = options.settings.sequences;
				if (protocols === "auto") {
					try { protocols = await selectAutomatic(env, signal); }
					catch { protocols = automaticNotificationProtocols(env); }
				}
				if (usable(signal)) {
					for (const protocol of protocols) for (const sequence of notificationSequences(protocol, text)) {
						const wrapped = wrapNotificationSequence(sequence, env);
						if (wrapped === undefined) return () => {};
						buffers.push(wrapped);
					}
				}
			}
			return () => usable(signal) ? writeNotificationBuffers(output, buffers) : undefined;
		} },
		{ name: "bell", async prepare(_text, signal) {
			return () => usable(signal) ? writeNotificationBuffers(output, [Buffer.from([0x07])]) : undefined;
		} },
	];
}
