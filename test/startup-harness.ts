/**
 * A fake Pi extension host for the startup-activation tests.
 *
 * It keeps ONE entry list and serves it as both the session entries and the
 * active branch, because the locator-note rules depend on that relationship: a
 * note appended during a session must count as present on the branch at once.
 * A test that needs an off-branch note sets `branchEntries` explicitly.
 */

import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface FakeEntry {
	type: "custom";
	customType: string;
	data: Record<string, unknown>;
}

export type FakeHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

export class FakeExtensionHost {
	readonly handlers = new Map<string, FakeHandler[]>();
	readonly commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	readonly entries: FakeEntry[] = [];
	readonly sent: Array<{ customType?: string; content?: string }> = [];
	/** Entries returned as the active branch. Undefined means the entry list itself. */
	branchEntries: FakeEntry[] | undefined;
	failNextAppend = false;
	private activeTools: string[] = [];

	on(event: string, handler: FakeHandler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }): void {
		this.commands.set(name, command.handler);
	}
	registerTool(): void {}
	getActiveTools(): string[] { return [...this.activeTools]; }
	setActiveTools(tools: string[]): void { this.activeTools = [...tools]; }
	getAllTools(): Array<{ name: string }> { return []; }
	/**
	 * It keeps the entry of a FAILED append, like Pi: Pi adds the entry to its own
	 * memory before it writes the entry, and it removes nothing when its write throws
	 * (CN1504). A fake that threw before the push made a memory-only note look
	 * impossible.
	 */
	appendEntry(customType: string, data: Record<string, unknown>): void {
		this.entries.push({ type: "custom", customType, data });
		if (this.failNextAppend) {
			this.failNextAppend = false;
			throw new Error("forced entry persistence failure");
		}
	}
	sendMessage(message: { customType?: string; content?: string }): void { this.sent.push(message); }
	getThinkingLevel(): undefined { return undefined; }
	setThinkingLevel(): void {}

	/** Every entry of one custom type, in append order. */
	notes(customType: string): Array<Record<string, unknown>> {
		return this.entries.filter((entry) => entry.customType === customType).map((entry) => entry.data);
	}

	branch(): FakeEntry[] {
		return this.branchEntries ?? this.entries;
	}

	get api(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}
}

export function fakeContext(
	host: FakeExtensionHost,
	options: { cwd: string; sessionId: string; sessionFile: string; mode?: string; trusted?: boolean },
): ExtensionContext {
	return {
		cwd: options.cwd,
		hasUI: false,
		mode: options.mode ?? "print",
		model: undefined,
		modelRegistry: { find: () => undefined },
		isProjectTrusted: () => options.trusted !== false,
		getContextUsage: () => undefined,
		waitForIdle: async () => {},
		sessionManager: {
			getBranch: () => host.branch(),
			getEntries: () => host.entries,
			getHeader: () => ({}),
			getSessionId: () => options.sessionId,
			getSessionFile: () => options.sessionFile,
		},
		ui: { notify() {}, setWidget() {}, setStatus() {} },
	} as unknown as ExtensionContext;
}

export async function startSession(host: FakeExtensionHost, ctx: ExtensionContext): Promise<void> {
	const handlers = host.handlers.get("session_start");
	assert.ok(handlers);
	for (const handler of handlers) await handler({}, ctx);
}
