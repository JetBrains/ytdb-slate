export type NotificationDetail = "generic" | "project" | "message";
export type NotificationProtocol = "osc9" | "osc777" | "osc99";
export interface NotificationSettings {
	readonly terminal: boolean;
	readonly native: boolean;
	readonly bell: boolean;
	readonly detail: NotificationDetail;
	readonly pushDetail: NotificationDetail;
	readonly minimumDelayMs: number;
	readonly cooldownMs: number;
	readonly sequences: "auto" | readonly NotificationProtocol[];
	readonly push: Readonly<{ enabled: boolean; server?: string; topic?: string; token?: string; username?: string; password?: string }>;
}
const details: readonly NotificationDetail[] = ["generic", "project", "message"];
const protocols: readonly NotificationProtocol[] = ["osc9", "osc777", "osc99"];
const policies = new WeakMap<object, NotificationSettings>();
export const NOTIFICATION_DEFAULTS: NotificationSettings = Object.freeze({
	terminal: true, native: true, bell: true, detail: "generic", pushDetail: "generic",
	minimumDelayMs: 30000, cooldownMs: 60000, sequences: "auto", push: Object.freeze({ enabled: false }),
});
function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** Resolve sources separately so a trusted project cannot grant disclosure or push authority. */
export function resolveNotificationSettings(home: unknown, project: unknown, warn: (message: string) => void): NotificationSettings {
	const invalid = (key: string) => warn(`slate: invalid notifications.${key}. Using a safe default.`);
	const group = (value: unknown, key: string) => {
		if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) invalid(key);
		return object(value);
	};
	const h = group(home, "settings"), p = group(project, "settings");
	const bool = (value: unknown, fallback: boolean, key: string): boolean => {
		if (value === undefined) return fallback;
		if (typeof value === "boolean") return value;
		invalid(key);
		return fallback;
	};
	const lowerChannel = (homeValue: unknown, projectValue: unknown, fallback: boolean, key: string) => {
		const permitted = bool(homeValue, fallback, key);
		const requested = bool(projectValue, true, key);
		return permitted && requested;
	};
	const detail = (value: unknown, key: string): NotificationDetail => {
		if (value === undefined) return "generic";
		if (details.includes(value as NotificationDetail)) return value as NotificationDetail;
		invalid(key);
		return "generic";
	};
	const lowerDetail = (key: "detail" | "pushDetail") => {
		const permitted = detail(h[key], key);
		return p[key] === undefined ? permitted : details[Math.min(details.indexOf(permitted), details.indexOf(detail(p[key], key)))]!;
	};
	const interval = (key: "minimumDelayMs" | "cooldownMs") => {
		const value = Object.hasOwn(p, key) ? p[key] : h[key];
		if (value === undefined) return NOTIFICATION_DEFAULTS[key];
		if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
		invalid(key);
		return NOTIFICATION_DEFAULTS[key];
	};
	let sequences: NotificationSettings["sequences"] = "auto";
	const raw = Object.hasOwn(p, "sequences") ? p.sequences : h.sequences;
	if (raw !== undefined && raw !== "auto") {
		if (Array.isArray(raw) && raw.length > 0 && raw.every((v) => protocols.includes(v)) && new Set(raw).size === raw.length) {
			sequences = Object.freeze([...raw]) as readonly NotificationProtocol[];
		} else invalid("sequences");
	}
	const push = group(h.push, "push"), projectPush = group(p.push, "push");
	const destination: { enabled: boolean; server?: string; topic?: string; token?: string; username?: string; password?: string } = {
		enabled: lowerChannel(push.enabled, projectPush.enabled, false, "push.enabled"),
	};
	let valid = true;
	for (const key of ["server", "topic", "token", "username", "password"] as const) {
		const value = push[key];
		if (value === undefined) continue;
		if (typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)) destination[key] = value;
		else { invalid(`push.${key}`); valid = false; }
	}
	if (destination.server !== undefined) {
		try {
			const url = new URL(destination.server);
			const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
			if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) throw new Error();
		} catch { invalid("push.server"); valid = false; }
	}
	if (destination.topic !== undefined && !/^[a-zA-Z0-9_-]+$/.test(destination.topic)) { invalid("push.topic"); valid = false; }
	if ((destination.username === undefined) !== (destination.password === undefined) || (destination.token !== undefined && destination.username !== undefined)) {
		invalid("push.credentials"); valid = false;
	}
	if (destination.enabled && (!destination.server || !destination.topic)) { invalid("push.destination"); valid = false; }
	if (!valid) destination.enabled = false;
	return Object.freeze({
		terminal: lowerChannel(h.terminal, p.terminal, true, "terminal"),
		native: lowerChannel(h.native, p.native, true, "native"),
		bell: lowerChannel(h.bell, p.bell, true, "bell"),
		detail: lowerDetail("detail"), pushDetail: lowerDetail("pushDetail"),
		minimumDelayMs: interval("minimumDelayMs"), cooldownMs: interval("cooldownMs"), sequences,
		push: Object.freeze(destination),
	});
}

/** Bind only source-resolved policy. Copies and replacement objects receive safe defaults. */
export function bindNotificationSettings(config: object, home: unknown, project: unknown, warn: (message: string) => void): void {
	policies.set(config, resolveNotificationSettings(home, project, warn));
}
export function notificationSettings(config: object | undefined): NotificationSettings {
	return config === undefined ? NOTIFICATION_DEFAULTS : policies.get(config) ?? NOTIFICATION_DEFAULTS;
}
