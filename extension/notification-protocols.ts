import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { NotificationDetail, NotificationProtocol } from "./notification-config.ts";

export type NotificationEvent = "finished" | "input-needed" | "error";
export interface NotificationText { readonly title: string; readonly body: string }
const titles = { finished: "Finished", "input-needed": "Input needed", error: "Error" };
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
export function notificationText(event: NotificationEvent, detail: NotificationDetail, cwd: string, message = ""): NotificationText {
	const folder = detail === "generic" ? "" : sanitizeNotificationText(basename(cwd));
	const body = detail === "message" ? [folder, sanitizeNotificationText(message)].filter(Boolean).join(": ") : folder;
	return Object.freeze({ title: titles[event], body: truncateNotificationUtf8(body, 200) });
}

/** Assemble complete requests. Notification text never enters OSC 99 metadata. */
export function notificationSequences(protocol: NotificationProtocol, text: NotificationText, id: string = randomUUID()): Buffer[] {
	const field = (value: string) => sanitizeNotificationText(value);
	const title = field(text.title), body = field(text.body);
	const assemble = (header: string, payload: string, terminator: string) => Buffer.from(header +
		truncateNotificationUtf8(payload, NOTIFICATION_SEQUENCE_MAX_BYTES - Buffer.byteLength(header + terminator)) + terminator);
	if (protocol === "osc9") return [assemble(`${ESC}]9;Slate: `, `${title.replaceAll(";", "")}: ${body.replaceAll(";", "")}`, BEL)];
	if (protocol === "osc777") {
		const safeTitle = truncateNotificationUtf8(title.replaceAll(";", ""), 100);
		return [assemble(`${ESC}]777;notify;${safeTitle};`, body.replaceAll(";", ""), BEL)];
	}
	if (id === "0" || !/^[a-zA-Z0-9_+.-]{1,36}$/.test(id)) throw new Error("slate: invalid notification identifier");
	return [assemble(`${ESC}]99;i=${id}:d=0;`, title, ST), assemble(`${ESC}]99;i=${id}:p=body:d=1;`, body, ST)];
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
