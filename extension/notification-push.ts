import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import { pinnedPushLookup, resolvePushAddresses, selectPushAddress, type PushResolverOptions } from "./notification-push-resolution.ts";
import type { NotificationSettings } from "./notification-config.ts";
import type { NotificationChannel } from "./notification-dispatcher.ts";
import { sanitizeNotificationText, truncateNotificationUtf8 } from "./notification-protocols.ts";

export const PUSH_ATTEMPT_TIMEOUT_MS = 5000;
export const PUSH_TEXT_MAX_BYTES = 1024;
export interface PushNotificationOptions {
	readonly mode: string;
	/** The private policy returned by notificationSettings(config), not config.notifications. */
	readonly settings: NotificationSettings;
	/** Inject resolution for tests. Address validation still applies. */
	readonly resolver?: PushResolverOptions;
}

/** Request finish accepts delivery. Socket close releases the shared delivery slot. */
function deliver(url: URL, options: RequestOptions, payload: string, signal: AbortSignal, resolver?: PushResolverOptions): Promise<void> {
	return new Promise((done) => {
		let request: ClientRequest | undefined, response: IncomingMessage | undefined, socket: Socket | undefined;
		let settled = false, stopping = false, accepted = false, resolving = false;
		const resolution = new AbortController();
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
			resolution.abort();
			response?.destroy();
			request?.destroy();
			socket?.destroy();
			if (!request && !resolving) finish();
		};
		const cancel = () => { if (!accepted) stop(); };
		const timer = setTimeout(stop, PUSH_ATTEMPT_TIMEOUT_MS);
		timer.unref();
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) { cancel(); return; }
		const connect = (addresses: unknown) => {
			resolving = false;
			try {
				const address = selectPushAddress(addresses, url.protocol === "http:");
				if (stopping || !address) { stop(); return; }
				const transport = url.protocol === "https:" ? https : http;
				const connectionOptions = { ...options, lookup: pinnedPushLookup(address), family: address.family, autoSelectFamily: false };
				// The URL still supplies Host and the TLS certificate identity.
				if (url.protocol === "https:" && !isIP(host)) (connectionOptions as https.RequestOptions).servername = host;
				request = transport.request(url, connectionOptions, (incoming) => {
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
		};
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const family = isIP(host);
		if (family) connect([{ address: host, family }]);
		else {
			resolving = true;
			void resolvePushAddresses(host, resolution.signal, PUSH_ATTEMPT_TIMEOUT_MS, resolver).then(connect, () => connect(undefined));
		}
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
			return () => deliver(url, { method: "POST", agent: false, headers }, payload, signal, options.resolver);
		} catch { return () => {}; }
	} };
}
