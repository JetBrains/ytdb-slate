import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { NotificationSettings } from "./notification-config.ts";
import type { NotificationChannel } from "./notification-dispatcher.ts";
import { sanitizeNotificationText, truncateNotificationUtf8 } from "./notification-protocols.ts";

export const PUSH_ATTEMPT_TIMEOUT_MS = 5000;
export const PUSH_TEXT_MAX_BYTES = 1024;
export interface PushNotificationOptions {
	readonly mode: string;
	/** The private policy returned by notificationSettings(config), not config.notifications. */
	readonly settings: NotificationSettings;
	/** Select a connection address without changing the destination host or TLS identity. */
	readonly lookup?: RequestOptions["lookup"];
}

/** Request finish accepts delivery. Socket close releases the shared delivery slot. */
function deliver(url: URL, options: RequestOptions, payload: string, signal: AbortSignal): Promise<void> {
	return new Promise((done) => {
		let request: ClientRequest | undefined, response: IncomingMessage | undefined, socket: Socket | undefined;
		let settled = false, stopping = false, accepted = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			done();
		};
		const stop = () => {
			if (settled) return;
			stopping = true;
			response?.destroy();
			request?.destroy();
			socket?.destroy();
			if (!request) finish();
		};
		const cancel = () => { if (!accepted) stop(); };
		const timer = setTimeout(stop, PUSH_ATTEMPT_TIMEOUT_MS);
		timer.unref();
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) { cancel(); return; }
		try {
			const transport = url.protocol === "https:" ? https : http;
			request = transport.request(url, options, (incoming) => {
				response = incoming;
				incoming.on("error", stop);
				// No redirect, retry, or response buffering. Headers end this attempt for every status.
				stop();
			});
			request.once("socket", (connection) => {
				socket = connection;
				connection.unref();
				connection.once("close", finish);
				if (stopping) connection.destroy();
			});
			request.once("finish", () => {
				if (stopping) return;
				accepted = true;
				signal.removeEventListener("abort", cancel);
			});
			request.on("error", stop);
			request.once("close", () => { if (!socket) finish(); });
			request.end(payload);
		} catch { stop(); }
	});
}

/** Prepare fixed JSON data without network work. Delivery failures stay local and silent. */
export function createPushNotificationChannel(options: PushNotificationOptions): NotificationChannel {
	return { name: "push", async prepare(text, signal) {
		const push = options.settings.push;
		if (options.mode !== "tui" || !push.enabled || !push.server || !push.topic || signal.aborted) return () => {};
		try {
			const url = new URL(push.server);
			if (!url.pathname.endsWith("/")) url.pathname += "/";
			const safe = (value: string) => truncateNotificationUtf8(sanitizeNotificationText(value), PUSH_TEXT_MAX_BYTES);
			const payload = JSON.stringify({ topic: push.topic, title: safe(text.title), message: safe(text.body), markdown: false });
			const headers: Record<string, string | number> = {
				"Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Connection: "close",
			};
			if (push.token !== undefined) headers.Authorization = `Bearer ${push.token}`;
			else if (push.username !== undefined && push.password !== undefined) {
				headers.Authorization = `Basic ${Buffer.from(`${push.username}:${push.password}`, "utf8").toString("base64")}`;
			}
			return () => deliver(url, { method: "POST", agent: false, headers, lookup: options.lookup }, payload, signal);
		} catch { return () => {}; }
	} };
}
