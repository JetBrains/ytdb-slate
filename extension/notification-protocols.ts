import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { NotificationDetail, NotificationProtocol } from "./notification-config.ts";

export type NotificationEvent = "input-needed" | "error";
export interface NotificationText {
	readonly title: string;
	readonly body: string;
	/** Explicit body boundaries survive object copies and JSON serialization. */
	readonly folder?: string;
	readonly copied?: string;
}
const titles = { "input-needed": "Input needed", error: "Error" };
const ESC = "\x1b", BEL = "\x07", ST = `${ESC}\\`;
export const NOTIFICATION_SEQUENCE_MAX_BYTES = 252;

/** Remove terminal controls and direction changes without changing existing UI notice behavior. */
export function sanitizeNotificationText(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, "");
}
export function truncateNotificationUtf8(text: string, bytes: number): string {
	let result = "", used = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character);
		if (used + size > bytes) break;
		result += character;
		used += size;
	}
	return result;
}
function notificationUtf8Tail(text: string, limit: number): string {
	let tail = "", used = 0;
	for (let end = text.length; end > 0;) {
		const low = text.charCodeAt(end - 1);
		const start = low >= 0xdc00 && low <= 0xdfff && end > 1 && text.charCodeAt(end - 2) >= 0xd800 && text.charCodeAt(end - 2) <= 0xdbff ? end - 2 : end - 1;
		const character = text.slice(start, end), bytes = Buffer.byteLength(character);
		if (used + bytes > limit) break;
		tail = character + tail;
		used += bytes;
		end = start;
	}
	return tail;
}
export function notificationText(event: NotificationEvent, detail: NotificationDetail, cwd: string, message = ""): NotificationText {
	const folder = detail === "generic" ? "" : sanitizeNotificationText(basename(cwd));
	const copied = detail === "message" ? sanitizeNotificationText(notificationUtf8Tail(message, 200)) : "";
	const prefix = folder && copied ? `${folder}: ` : folder;
	return Object.freeze({ title: titles[event], body: prefix + (copied ? `…${copied}` : ""), folder, copied });
}

/** Keep the whole folder when it fits, then keep the marker and newest copied characters. */
function fitNotificationField(value: string, bytes: number, parts?: { folder: string; copied: string }, prefix = ""): string {
	if (Buffer.byteLength(value) <= bytes) return value;
	// Standalone fields can use the same folder and copied-text shape as notificationText.
	const marker = value.startsWith("…") ? 0 : value.indexOf(": …") < 0 ? -1 : value.indexOf(": …") + 2;
	const folder = parts?.folder ?? (marker < 0 ? value : marker === 0 ? "" : value.slice(0, marker - 2));
	const copied = parts?.copied ?? (marker < 0 ? "" : value.slice(marker + 1));
	const keptPrefix = truncateNotificationUtf8(prefix, bytes);
	bytes -= Buffer.byteLength(keptPrefix);
	if (!copied || Buffer.byteLength(folder) > bytes) return keptPrefix + truncateNotificationUtf8(folder, bytes);
	const copiedPrefix = folder ? `${folder}: …` : "…";
	const tail = notificationUtf8Tail(copied, bytes - Buffer.byteLength(copiedPrefix));
	return keptPrefix + (tail ? copiedPrefix + tail : folder);
}

/** Assemble complete requests. Notification text never enters OSC 99 metadata. */
export function notificationSequences(protocol: NotificationProtocol, text: NotificationText, id: string = randomUUID()): Buffer[] {
	const field = (value: string) => {
		const safe = sanitizeNotificationText(value);
		return protocol === "osc99" ? safe : safe.replaceAll(";", "");
	};
	const title = field(text.title), body = field(text.body);
	const safeParts = text.folder !== undefined && text.copied !== undefined ? { folder: field(text.folder), copied: field(text.copied) } : undefined;
	const assemble = (header: string, payload: string, terminator: string, components?: typeof safeParts, prefix = "") => Buffer.from(header +
		fitNotificationField(payload, NOTIFICATION_SEQUENCE_MAX_BYTES - Buffer.byteLength(header + terminator), components, prefix) + terminator);
	if (protocol === "osc9") return [assemble(`${ESC}]9;Slate: `, `${title}: ${body}`, BEL, safeParts, safeParts ? `${title}: ` : "")];
	if (protocol === "osc777") {
		const safeTitle = fitNotificationField(title, 100);
		return [assemble(`${ESC}]777;notify;${safeTitle};`, body, BEL, safeParts)];
	}
	if (id === "0" || !/^[a-zA-Z0-9_+.-]{1,36}$/.test(id)) throw new Error("slate: invalid notification identifier");
	return [assemble(`${ESC}]99;i=${id}:d=0;`, title, ST), assemble(`${ESC}]99;i=${id}:p=body:d=1;`, body, ST, safeParts)];
}

/** Return one complete write buffer per request, including every screen envelope. */
export function wrapNotificationSequence(sequence: Buffer, environment: Readonly<Record<string, string | undefined>>): Buffer | undefined {
	const hints = [environment.TMUX, environment.STY, environment.ZELLIJ].filter(Boolean);
	if (hints.length > 1) return undefined;
	if (environment.TMUX) return Buffer.from(`${ESC}Ptmux;${sequence.toString("utf8").replaceAll(ESC, ESC + ESC)}${ST}`);
	if (!environment.STY) return sequence;
	const chunks: Buffer[] = [];
	let start = 0;
	while (start < sequence.length) {
		let end = Math.min(start + 252, sequence.length);
		for (let i = start; i < end - 1; i++) {
			if (sequence[i] === 0x1b && sequence[i + 1] === 0x5c) { end = i + 1; break; }
		}
		chunks.push(Buffer.from(`${ESC}P`), sequence.subarray(start, end), Buffer.from(ST));
		start = end;
	}
	return Buffer.concat(chunks);
}
