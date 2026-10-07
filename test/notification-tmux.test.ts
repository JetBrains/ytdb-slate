import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, parse } from "node:path";
import { test, type TestContext } from "node:test";
import {
	identifyNotificationTerminal, parseTmuxClients, queryTmuxClients, resolveTmuxExecutable, selectTmuxNotificationProtocols,
	TMUX_CLIENT_FORMAT, TMUX_QUERY_MAX_BYTES, TMUX_QUERY_TIMEOUT_MS, type NotificationTerminal,
} from "../extension/notification-tmux.ts";
import { createTerminalNotificationChannels } from "../extension/notification-terminal.ts";
import { NotificationDispatcher } from "../extension/notification-dispatcher.ts";
import { bindNotificationSettings, resolveNotificationSettings, type NotificationProtocol } from "../extension/notification-config.ts";
import { registerNotificationEvents } from "../extension/notification-events.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const text = { title: "Input needed", body: "folder: …newest" }, ESC = "\x1b", ST = `${ESC}\\`;
const framed = (...names: string[]) => Buffer.from(names.map((name, index) => `${index + 1}\t${Object.keys(support).map((terminal) => Number(identifyNotificationTerminal(name) === terminal)).join("")}\n`).join(""));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function scratch(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "slate-tmux-unit-")), executable = join(directory, "tmux");
	writeFileSync(executable, "fixture"); chmodSync(executable, 0o755);
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return { directory, executable, environment: { TMUX: "/tmp/private-socket,42,1", TMUX_PANE: "%42", PATH: directory } };
}
function fakeQuery(t: TestContext, reply: Buffer | Error | "pending") {
	let callback!: (error: Error | null, stdout: Buffer, stderr: Buffer) => void;
	let start!: () => void;
	const started = new Promise<void>((resolve) => { start = resolve; }), killed: string[] = [], unreferenced: string[] = [];
	const child = Object.assign(new EventEmitter(), {
		kill(signal: string): boolean { killed.push(signal); return true; }, unref() { unreferenced.push("child"); },
		stdin: { destroy() { unreferenced.push("stdin"); } },
		stdout: { unref() { unreferenced.push("stdout"); } }, stderr: { unref() { unreferenced.push("stderr"); } },
	});
	const execute = t.mock.method(childProcess, "execFile", ((...args: unknown[]) => {
		callback = args[3] as typeof callback;
		start();
		if (reply !== "pending") queueMicrotask(() => callback(reply instanceof Error ? reply : null, reply instanceof Error ? Buffer.alloc(0) : reply, Buffer.alloc(0)));
		return child;
	}) as unknown as typeof childProcess.execFile);
	return { execute, started, killed, unreferenced, child,
		complete: (reply: Buffer = framed("Konsole 24.08.0")) => callback(null, reply, Buffer.alloc(0)) };
}
function output() {
	const writes: Buffer[] = [];
	const stream = Object.assign(new EventEmitter(), { isTTY: true, write(buffer: Buffer, callback: () => void) { writes.push(Buffer.from(buffer)); callback(); return true; } });
	return { stream: stream as unknown as NodeJS.WriteStream, writes };
}
function bytes(writes: readonly Buffer[]) {
	return writes.map((buffer) => buffer.toString().replace(/i=[a-zA-Z0-9_+.-]+:/g, "i=ID:"));
}
function wrapped(protocol: NotificationProtocol) {
	const sequences = protocol === "osc777" ? [`${ESC}]777;notify;${text.title};${text.body}\x07`]
		: protocol === "osc9" ? [`${ESC}]9;Slate: ${text.title}: ${text.body}\x07`]
		: [`${ESC}]99;i=ID:d=0;${text.title}${ST}`, `${ESC}]99;i=ID:p=body:d=1;${text.body}${ST}`];
	return sequences.map((sequence) => `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ST}`);
}
async function send(channels: ReturnType<typeof createTerminalNotificationChannels>, name: "terminal" | "bell", signal = new AbortController().signal) {
	await (await channels.find((channel) => channel.name === name)!.prepare(text, signal))();
}

const support: Record<NotificationTerminal, readonly NotificationProtocol[]> = {
	iTerm2: ["osc9"], WezTerm: ["osc9", "osc777"], ghostty: ["osc9", "osc777"],
	kitty: ["osc9", "osc777", "osc99"], foot: ["osc9", "osc777", "osc99"], Konsole: ["osc777", "osc99"], vscode: ["osc99"],
};
const automatic: Record<NotificationTerminal, NotificationProtocol> = {
	iTerm2: "osc9", WezTerm: "osc777", ghostty: "osc777", kitty: "osc99", foot: "osc99", Konsole: "osc777", vscode: "osc99",
};
test("client names match known version replies, not TERM or generic xterm.js", () => {
	for (const terminal of Object.keys(support) as NotificationTerminal[]) {
		for (const name of [terminal, `${terminal} 1.2.3-test+4`, `${terminal}(1.2.3)`]) {
			assert.equal(identifyNotificationTerminal(name), terminal);
			assert.deepEqual(parseTmuxClients(framed(name)), [terminal]);
		}
		assert.deepEqual(selectTmuxNotificationProtocols([terminal]), [automatic[terminal]], "one identified client uses its own automatic row");
	}
	for (const name of ["", "xterm-256color", "xterm-kitty", "xterm.js(5.5.0)", "Windows Terminal", "VTE", "kitty impostor", "Konsole\x1b]9;PRIVATE\x07", "kitty\n", "foot\t1", "kitty(1.2.3)junk"]) {
		assert.equal(identifyNotificationTerminal(name), undefined, JSON.stringify(name));
	}
	assert.deepEqual(parseTmuxClients(framed("", "xterm-256color", "unrecognized", "Konsole 24.08.0", "kitty(0.42.2)", "é")), ["Konsole", "kitty"]);
});

test("reply parser accepts only fixed match bits and rejects malformed or oversized replies", () => {
	assert.deepEqual(parseTmuxClients(Buffer.alloc(0)), []);
	for (const reply of ["Konsole\n", "1\t0001000", "1\t00010000\n", "x\t0000000\n", "1\t1001000\n", "1\t000000x\n", "1\n\t0000000\n", "1\t0000000\nJUNK", "1\t0000000\r\n"]) {
		assert.throws(() => parseTmuxClients(Buffer.from(reply)));
	}
	assert.throws(() => parseTmuxClients(Buffer.alloc(TMUX_QUERY_MAX_BYTES + 1)));
	const escapedForge = Buffer.from("1\t6\tiTerm2\n2\t5\tkitty\n3\t16\t" + "\\033".repeat(4) + "\n2\t7\tKonsole\n");
	assert.throws(() => parseTmuxClients(escapedForge), "raw and tmux 3.4 escaped names are not the query wire format");
	assert.deepEqual(parseTmuxClients(Buffer.from("1\t1000000\n2\t0001000\n3\t0000000\n")), ["iTerm2", "kitty"]);
});

test("G9 maximizes coverage without duplicates and applies both tie-breaks for every client triple", () => {
	assert.equal(selectTmuxNotificationProtocols([]), undefined);
	assert.deepEqual(selectTmuxNotificationProtocols(["Konsole", "kitty"]), ["osc777"], "protocol-order tie-break");
	assert.deepEqual(selectTmuxNotificationProtocols(["iTerm2", "Konsole"]), ["osc777", "osc9"]);
	assert.deepEqual(selectTmuxNotificationProtocols(["iTerm2", "kitty"]), ["osc9"], "maximum coverage");
	assert.deepEqual(selectTmuxNotificationProtocols(["iTerm2", "Konsole", "kitty"]), ["osc777"], "fewer protocols wins");
	assert.deepEqual(selectTmuxNotificationProtocols(["kitty", "kitty"]), ["osc777"], "clients count, not distinct identities");
	assert.deepEqual(selectTmuxNotificationProtocols(["iTerm2", "iTerm2", "vscode", "vscode", "kitty"]), ["osc99"], "a duplicate-delivery set cannot outrank a valid set");
	assert.deepEqual(selectTmuxNotificationProtocols(["vscode", "iTerm2"]), ["osc99", "osc9"]);
	const preference = ["osc777", "osc99", "osc9"] as const;
	const allSets = Array.from({ length: 8 }, (_, mask) => preference.filter((_value, index) => (mask & (1 << index)) !== 0));
	const names = Object.keys(support) as NotificationTerminal[];
	for (const a of names) for (const b of names) for (const c of names) {
		const clients = [a, b, c], actual = selectTmuxNotificationProtocols(clients)!;
		const hits = (set: readonly NotificationProtocol[]) => clients.map((client) => set.filter((protocol) => support[client].includes(protocol)).length);
		assert.ok(hits(actual).every((count) => count <= 1));
		const valid = allSets.filter((set) => hits(set).every((count) => count <= 1));
		valid.sort((left, right) => hits(right).filter(Boolean).length - hits(left).filter(Boolean).length || left.length - right.length ||
			preference.reduce((rank, protocol, index) => rank + (Number(right.includes(protocol)) - Number(left.includes(protocol))) * (4 >> index), 0));
		assert.deepEqual(actual, valid[0], clients.join("+"));
	}
});

test("tmux executes an absolute helper with pane-targeted argument array, minimal environment and non-project cwd", { timeout: 1000 }, async (t) => {
	const f = scratch(t), query = fakeQuery(t, framed("Konsole 24.08.0", "kitty(0.42.2)"));
	const environment = { ...f.environment, HOME: "/private", LD_PRELOAD: "PRIVATE", NODE_OPTIONS: "PRIVATE", API_KEY: "PRIVATE", TERM: "xterm-kitty", STY: "PRIVATE" };
	assert.deepEqual(await queryTmuxClients(environment, new AbortController().signal), ["Konsole", "kitty"]);
	assert.equal(query.execute.mock.callCount(), 1);
	const args = query.execute.mock.calls[0]!.arguments;
	assert.equal(args[0], f.executable);
	assert.deepEqual(args[1], ["list-clients", "-t", "%42", "-F", "#{client_pid}\t" + Object.keys(support).map((name) => `#{m/r:^${name}( [0123456789][abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+_-]*|[(][0123456789][abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+_-]*[)])?$,#{client_termtype}}`).join("")]);
	assert.equal(TMUX_CLIENT_FORMAT, args[1]![4]);
	const options = args[2] as childProcess.ExecFileOptions;
	assert.equal(options.cwd, parse(process.cwd()).root); assert.notEqual(options.cwd, process.cwd());
	assert.deepEqual(options.env, { TMUX: f.environment.TMUX, TMUX_PANE: "%42", LC_ALL: "C" });
	assert.equal(options.shell, false); assert.equal(options.maxBuffer, TMUX_QUERY_MAX_BYTES); assert.equal(options.killSignal, "SIGKILL");
	assert.deepEqual(query.unreferenced, ["child", "stdin", "stdout", "stderr"]); assert.deepEqual(query.killed, []);
	assert.doesNotMatch(JSON.stringify(args[1]), /display-message|client_termname|client_activity|current/);
});

test("helper resolution rejects relative PATH, project directories, project symlinks, and nonexecutables", { timeout: 1000 }, async (t) => {
	const f = scratch(t), controller = new AbortController();
	const missing = join(f.directory, "missing"), folder = join(f.directory, "folder"), alias = join(f.directory, "alias"), blocked = join(f.directory, "blocked");
	mkdirSync(folder); mkdirSync(join(folder, "tmux")); mkdirSync(alias); mkdirSync(blocked);
	symlinkSync(join(process.cwd(), "package.json"), join(alias, "tmux"));
	writeFileSync(join(blocked, "tmux"), "not executable"); chmodSync(join(blocked, "tmux"), 0o644);
	const environment = { PATH: ["", ".", "node_modules/.bin", process.cwd(), missing, folder, alias, blocked, f.directory].join(delimiter) };
	assert.equal(await resolveTmuxExecutable(environment, controller.signal), f.executable);
	await assert.rejects(resolveTmuxExecutable(f.environment, controller.signal, f.directory), "the supplied project differs from process.cwd");
	await assert.rejects(resolveTmuxExecutable({ PATH: ["", ".", process.cwd(), alias, blocked, folder].join(delimiter) }, controller.signal));
	await assert.rejects(resolveTmuxExecutable({ PATH: "x".repeat(TMUX_QUERY_MAX_BYTES + 1) }, controller.signal));
	assert.equal(await resolveTmuxExecutable({}, new AbortController().signal).catch(() => "missing"), "missing");
	controller.abort(); await assert.rejects(resolveTmuxExecutable(f.environment, controller.signal));
});

test("query failures, malformed replies, missing tmux and invalid targets fail closed", { timeout: 1000 }, async (t) => {
	const f = scratch(t), signal = new AbortController().signal;
	for (const reply of [new Error("PRIVATE helper failure"), Buffer.from("unframed"), Buffer.alloc(TMUX_QUERY_MAX_BYTES + 1)]) {
		const query = fakeQuery(t, reply);
		await assert.rejects(queryTmuxClients(f.environment, signal), (error: Error) => !error.message.includes("PRIVATE"));
		assert.deepEqual(query.killed, ["SIGKILL"]); query.execute.mock.restore();
	}
	const query = fakeQuery(t, framed("kitty"));
	for (const environment of [{ ...f.environment, PATH: "." }, { ...f.environment, TMUX: "" }, { ...f.environment, TMUX: "x".repeat(4097) }, { ...f.environment, TMUX_PANE: "-t;PRIVATE" }, { ...f.environment, TMUX_PANE: undefined }]) {
		await assert.rejects(queryTmuxClients(environment, signal));
	}
	const aborted = new AbortController(); aborted.abort(); await assert.rejects(queryTmuxClients(f.environment, aborted.signal));
	assert.equal(query.execute.mock.callCount(), 0);
});

test("query timeout and cancellation kill pending work and ignore late replies", { timeout: 4000 }, async (t) => {
	const f = scratch(t);
	for (const cause of ["timeout", "abort"] as const) {
		const query = fakeQuery(t, "pending"), controller = new AbortController();
		const keepAlive = setTimeout(() => {}, TMUX_QUERY_TIMEOUT_MS + 1500);
		try {
			const result = queryTmuxClients(f.environment, controller.signal);
			const rejected = assert.rejects(result, cause === "timeout" ? /timed out/ : /cancelled/);
			await query.started; if (cause === "abort") controller.abort();
			await rejected; assert.deepEqual(query.killed, ["SIGKILL"]);
			query.complete(); await flush(); assert.deepEqual(query.killed, ["SIGKILL"]);
		} finally { clearTimeout(keepAlive); query.execute.mock.restore(); }
	}
});

test("production terminal factory uses G9, ignores unidentified clients and preserves wrapped send order", { timeout: 3000 }, async (t) => {
	const f = scratch(t);
	const cases: Array<[string[], NotificationProtocol[]]> = [
		[["kitty(0.42.2)"], ["osc99"]], [["Konsole 24.08.0", "kitty(0.42.2)"], ["osc777"]],
		[["iTerm2 3.5.0", "Konsole 24.08.0"], ["osc777", "osc9"]], [["iTerm2", "kitty"], ["osc9"]],
		[["iTerm2", "Konsole", "kitty"], ["osc777"]], [["vscode 1.0", "iTerm2"], ["osc99", "osc9"]],
		[["Konsole", "", "xterm-256color", "Windows Terminal", "kitty"], ["osc777"]],
	];
	for (const [names, expected] of cases) {
		const query = fakeQuery(t, framed(...names)), out = output();
		const channels = createTerminalNotificationChannels({ mode: "tui", settings: { sequences: "auto" }, environment: { ...f.environment, TERM_PROGRAM: "Apple_Terminal" }, output: out.stream, warn: assert.fail });
		await send(channels, "terminal"); assert.deepEqual(bytes(out.writes), expected.flatMap(wrapped));
		await send(channels, "bell"); assert.deepEqual(out.writes.at(-1), Buffer.from([7]));
		assert.equal(query.execute.mock.callCount(), 1); query.execute.mock.restore();
	}
});

test("production factory falls back for no identity, failure, malformed reply, missing helper and timeout", { timeout: 4000 }, async (t) => {
	const f = scratch(t);
	for (const reply of [framed("", "Windows Terminal", "xterm-256color"), Buffer.alloc(0), new Error("PRIVATE"), Buffer.from("bad"), "pending"] as const) {
		const query = fakeQuery(t, reply), out = output(), keepAlive = setTimeout(() => {}, 2500);
		try {
			const channels = createTerminalNotificationChannels({ mode: "tui", settings: { sequences: "auto" }, environment: { ...f.environment, TERM_PROGRAM: "iTerm.app" }, output: out.stream, warn: assert.fail });
			await send(channels, "terminal"); assert.deepEqual(bytes(out.writes), wrapped("osc9"));
			if (reply === "pending") assert.deepEqual(query.killed, ["SIGKILL"]);
		} finally { clearTimeout(keepAlive); query.execute.mock.restore(); }
	}
	const out = output();
	await send(createTerminalNotificationChannels({ mode: "tui", settings: { sequences: "auto" }, environment: { ...f.environment, PATH: ".", TERM_PROGRAM: "iTerm.app" }, output: out.stream, warn: assert.fail }), "terminal");
	assert.deepEqual(bytes(out.writes), wrapped("osc9"));
});

test("explicit lists bypass the real query and ambiguous hints suppress automatic and explicit requests", { timeout: 1000 }, async (t) => {
	const f = scratch(t), query = fakeQuery(t, framed("Konsole", "kitty"));
	const out = output();
	await send(createTerminalNotificationChannels({ mode: "tui", settings: { sequences: ["osc777", "osc99", "osc9"] }, environment: f.environment, output: out.stream, warn: assert.fail }), "terminal");
	assert.deepEqual(bytes(out.writes), ["osc777", "osc99", "osc9"].flatMap((protocol) => wrapped(protocol as NotificationProtocol)));
	assert.equal(query.execute.mock.callCount(), 0);
	for (const hints of [{ STY: "screen" }, { ZELLIJ: "zellij" }]) for (const sequences of ["auto", ["osc9"]] as const) {
		const out = output(), warnings: string[] = [];
		const channels = createTerminalNotificationChannels({ mode: "tui", settings: { sequences }, environment: { ...f.environment, ...hints }, output: out.stream, warn: (message) => { warnings.push(message); } });
		await send(channels, "terminal"); assert.deepEqual(out.writes, []); assert.equal(warnings.length, 1);
		await send(channels, "bell"); assert.deepEqual(out.writes, [Buffer.from([7])]);
	}
	assert.equal(query.execute.mock.callCount(), 0);
});

test("retirement at shutdown and replacement stops a background query before terminal write acceptance", { timeout: 3000 }, async (t) => {
	const f = scratch(t);
	for (const boundary of ["shutdown", "replacement"] as const) {
		const query = fakeQuery(t, "pending"), out = output(), timers = new Set<() => void>();
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const pi = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
		const ctx = { mode: "tui", cwd: "/folder", isIdle: () => true, hasPendingMessages: () => false, ui: { onTerminalInput: () => () => {} } } as unknown as ExtensionContext;
		const events = registerNotificationEvents(pi, { currentLifecycle: () => true, recovering: () => false,
			channels: createTerminalNotificationChannels({ mode: "tui", settings: { sequences: "auto" }, environment: f.environment, output: out.stream, warn: assert.fail }),
			schedule: (_delay, callback) => { timers.add(callback); return () => { timers.delete(callback); }; },
		});
		const config = {};
		// The dispatcher receives zero-delay settings through this bounded fixture.
		const start = t.mock.method(NotificationDispatcher.prototype, "dialog");
		const settings = resolveNotificationSettings({ minimumDelayMs: 0, cooldownMs: 0 }, undefined, assert.fail);
		bindNotificationSettings(config, settings, undefined, assert.fail);
		events.start(config, ctx);
		try {
			handlers.get("ui_prompt_start")!({}, ctx); assert.equal(start.mock.callCount(), 1);
			for (let round = 0; round < 2; round++) { for (const callback of [...timers]) { timers.delete(callback); callback(); } await flush(); }
			await query.started;
			assert.deepEqual(out.writes, [], "all channels await the common admission decision");
			if (boundary === "shutdown") events.retire(); else handlers.get("session_before_switch")!({}, ctx);
			assert.deepEqual(query.killed, ["SIGKILL"], "retirement does not wait for the query");
			query.complete(); await flush(); assert.deepEqual(out.writes, []);
			query.execute.mock.restore(); start.mock.restore();
			const successor = output(), dispatcher = new NotificationDispatcher({ mode: "tui", cwd: "/folder", settings,
				channels: createTerminalNotificationChannels({ mode: "tui", settings: { sequences: ["osc9"] }, environment: f.environment, output: successor.stream, warn: assert.fail }),
				current: () => true, idle: () => true, queued: () => false, recovering: () => false,
				schedule: (_delay, callback) => { timers.add(callback); return () => { timers.delete(callback); }; },
			});
			try {
				dispatcher.dialog(true);
				for (let round = 0; round < 2; round++) { for (const callback of [...timers]) { timers.delete(callback); callback(); } await flush(); }
				assert.equal(successor.writes.length, 2, "settled retired work releases module-level channel slots");
			} finally { dispatcher.retire(); await flush(); }
		} finally { events.retire(); await flush(); query.execute.mock.restore(); start.mock.restore(); }
	}
});

test("resolution timeout and cancellation at final access cannot start a late helper", { timeout: 4000 }, async (t) => {
	const query = fakeQuery(t, framed("Konsole")), original = fs.access;
	for (const cause of ["abort", "timeout"] as const) {
		const f = scratch(t);
		let release!: () => void, entered!: () => void;
		const entering = new Promise<void>((resolve) => { entered = resolve; });
		const access = t.mock.method(fs, "access", async (...args: Parameters<typeof fs.access>) => {
			await original(...args);
			if (args[0] === f.executable) { entered(); await new Promise<void>((resolve) => { release = resolve; }); }
		});
		const controller = new AbortController(), keepAlive = setTimeout(() => {}, TMUX_QUERY_TIMEOUT_MS + 1500);
		try {
			const pending = queryTmuxClients(f.environment, controller.signal), rejected = assert.rejects(pending);
			await entering; if (cause === "abort") controller.abort(); await rejected;
			release(); await new Promise((resolve) => setImmediate(resolve)); await flush();
			assert.equal(query.execute.mock.callCount(), 0);
		} finally { release?.(); clearTimeout(keepAlive); access.mock.restore(); }
	}
});

test("resolver rejects cancellation after its final executable access", { timeout: 1000 }, async (t) => {
	const f = scratch(t), original = fs.access, controller = new AbortController();
	let release!: () => void, entered!: () => void;
	const entering = new Promise<void>((resolve) => { entered = resolve; });
	t.mock.method(fs, "access", async (...args: Parameters<typeof fs.access>) => {
		await original(...args);
		if (args[0] === f.executable) { entered(); await new Promise<void>((resolve) => { release = resolve; }); }
	});
	const result = resolveTmuxExecutable(f.environment, controller.signal), rejected = assert.rejects(result, /cancelled/);
	try { await entering; controller.abort(); release(); await rejected; }
	finally { release?.(); await result.catch(() => {}); }
});

test("query settlement guard blocks spawning after an already resolved cached lookup", { timeout: 1000 }, async (t) => {
	const f = scratch(t), query = fakeQuery(t, framed("kitty")), controller = new AbortController();
	await resolveTmuxExecutable(f.environment, controller.signal);
	const result = queryTmuxClients(f.environment, controller.signal), rejected = assert.rejects(result, /cancelled/);
	controller.abort(); await rejected; await flush();
	assert.equal(query.execute.mock.callCount(), 0, "resolver completed before abort, so the query guard must prevent spawning");
});

test("real execFile bounds stdout and stderr and returns successful framed bytes", { timeout: 3000 }, async (t) => {
	const f = scratch(t), signal = new AbortController().signal;
	const keepAlive = setTimeout(() => {}, 2500);
	try {
		for (const stream of ["stdout", "stderr"]) {
			writeFileSync(f.executable, `#!${process.execPath}\nprocess.${stream}.write('x'.repeat(${TMUX_QUERY_MAX_BYTES + 1}));\n`);
			await assert.rejects(queryTmuxClients(f.environment, signal), /failed/);
		}
		writeFileSync(f.executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(framed("Konsole 24.08.0").toString())});\n`);
		assert.deepEqual(await queryTmuxClients(f.environment, signal), ["Konsole"]);
		const execute = t.mock.method(childProcess, "execFile", () => { throw new Error("PRIVATE spawn failure"); });
		await assert.rejects(queryTmuxClients(f.environment, signal), /query failed/); execute.mock.restore();
	} finally { clearTimeout(keepAlive); }
});

test("factory outside tmux uses the environment table without starting a query", { timeout: 1000 }, async (t) => {
	const query = fakeQuery(t, framed("Konsole")), out = output();
	await send(createTerminalNotificationChannels({ mode: "tui", settings: { sequences: "auto" }, environment: { TERM_PROGRAM: "iTerm.app" }, output: out.stream, warn: assert.fail }), "terminal");
	assert.deepEqual(bytes(out.writes), [`${ESC}]9;Slate: ${text.title}: ${text.body}\x07`]);
	assert.equal(query.execute.mock.callCount(), 0);
});

test("query timer is unreferenced immediately", { timeout: 1000 }, async (t) => {
	const f = scratch(t), query = fakeQuery(t, "pending"), original = globalThis.setTimeout;
	const timers: ReturnType<typeof setTimeout>[] = [];
	t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
		const timer = original(...args); if (args[1] === TMUX_QUERY_TIMEOUT_MS) timers.push(timer); return timer;
	});
	const controller = new AbortController();
	const result = queryTmuxClients(f.environment, controller.signal), rejected = assert.rejects(result);
	try {
		assert.equal(timers.length, 1); assert.equal(timers[0]!.hasRef(), false);
		await query.started;
	} finally { controller.abort(); await rejected; }
});

test("kill throws and error events cannot lose timeout fallback or abort suppression", { timeout: 6000 }, async (t) => {
	const f = scratch(t);
	for (const cause of ["timeout", "abort"] as const) for (const failure of ["throw", "error"] as const) {
		const query = fakeQuery(t, "pending"), controller = new AbortController(), out = output();
		query.child.kill = (signal) => {
			query.killed.push(signal);
			if (failure === "throw") throw new Error("kill EINVAL");
			query.child.emit("error", new Error("kill EPERM")); return false;
		};
		const channels = createTerminalNotificationChannels({ mode: "tui", settings: { sequences: "auto" }, environment: { ...f.environment, TERM_PROGRAM: "iTerm.app" }, output: out.stream, warn: assert.fail });
		const keepAlive = setTimeout(() => {}, 2500);
		try {
			const result = send(channels, "terminal", controller.signal);
			await query.started; if (cause === "abort") assert.doesNotThrow(() => controller.abort());
			await result;
			assert.deepEqual(bytes(out.writes), cause === "timeout" ? wrapped("osc9") : []);
			assert.deepEqual(query.killed, ["SIGKILL"]);
			assert.doesNotThrow(() => query.child.emit("error", new Error("late error")));
			query.complete(); await flush();
		} finally { controller.abort(); clearTimeout(keepAlive); query.execute.mock.restore(); }
	}
});

test("validated tmux target and socket are captured before helper resolution", { timeout: 1000 }, async (t) => {
	const f = scratch(t), query = fakeQuery(t, framed("kitty")), original = fs.access;
	t.mock.method(fs, "access", async (...args: Parameters<typeof fs.access>) => {
		f.environment.TMUX = "OTHER socket"; f.environment.TMUX_PANE = "-t OTHER"; return original(...args);
	});
	assert.deepEqual(await queryTmuxClients(f.environment, new AbortController().signal), ["kitty"]);
	assert.deepEqual(query.execute.mock.calls[0]!.arguments[1]!.slice(0, 3), ["list-clients", "-t", "%42"]);
	assert.deepEqual((query.execute.mock.calls[0]!.arguments[2] as childProcess.ExecFileOptions).env, { TMUX: "/tmp/private-socket,42,1", TMUX_PANE: "%42", LC_ALL: "C" });
});

test("stalled helper resolution cannot accumulate shared-pool work across notifications", { timeout: 3000 }, async (t) => {
	const f = scratch(t), query = fakeQuery(t, framed("kitty")), original = fs.realpath;
	let release!: (path: string) => void, entered!: () => void, searches = 0;
	const entering = new Promise<void>((resolve) => { entered = resolve; });
	t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
		if (args[0] === process.cwd()) { searches++; entered(); return new Promise<string>((resolve) => { release = resolve; }); }
		return original(...args);
	});
	const channels = () => createTerminalNotificationChannels({ mode: "tui", settings: { sequences: "auto" }, environment: { ...f.environment, TERM_PROGRAM: "iTerm.app" }, output: output().stream, warn: assert.fail });
	const keepAlive = setTimeout(() => {}, 2500);
	try {
		const first = send(channels(), "terminal"); await entering; await first;
		for (let i = 0; i < 8; i++) await send(channels(), "terminal");
		const changed = { ...f.environment, PATH: "/different" };
		await assert.rejects(queryTmuxClients(changed, new AbortController().signal));
		assert.equal(searches, 1); assert.equal(query.execute.mock.callCount(), 0);
	} finally { release(process.cwd()); clearTimeout(keepAlive); await flush(); }
});

test("successful helper search is reused only for the same PATH and project", { timeout: 1000 }, async (t) => {
	const f = scratch(t), realpath = t.mock.method(fs, "realpath"), signal = new AbortController().signal;
	assert.equal(await resolveTmuxExecutable(f.environment, signal), f.executable);
	const count = realpath.mock.callCount();
	assert.equal(await resolveTmuxExecutable(f.environment, signal), f.executable); assert.equal(realpath.mock.callCount(), count);
	await assert.rejects(resolveTmuxExecutable(f.environment, signal, f.directory)); assert.ok(realpath.mock.callCount() > count);
});

test("cached helper remains available during an unrelated in-flight search", { timeout: 1000 }, async (t) => {
	const cached = scratch(t), searching = scratch(t), signal = new AbortController().signal;
	await resolveTmuxExecutable(cached.environment, signal);
	const original = fs.realpath;
	let release!: (path: string) => void, entered!: () => void;
	const entering = new Promise<void>((resolve) => { entered = resolve; });
	t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
		if (args[0] === process.cwd()) { entered(); return new Promise<string>((resolve) => { release = resolve; }); }
		return original(...args);
	});
	const pending = resolveTmuxExecutable(searching.environment, signal);
	try {
		await entering;
		assert.equal(await resolveTmuxExecutable(cached.environment, signal), cached.executable);
		await assert.rejects(resolveTmuxExecutable({ PATH: "/another" }, signal), /search pending/);
	} finally { release(process.cwd()); await pending; }
});

test("spawn exceptions and child errors invalidate the cached helper", { timeout: 2000 }, async (t) => {
	for (const kind of ["throw", "event"] as const) for (const code of ["ENOENT", "EACCES", "EIO"]) {
		const f = scratch(t), signal = new AbortController().signal;
		await resolveTmuxExecutable(f.environment, signal);
		const realpath = t.mock.method(fs, "realpath"), error = Object.assign(new Error("PRIVATE spawn error"), { code });
		const query = fakeQuery(t, "pending");
		if (kind === "throw") query.execute.mock.mockImplementation((() => { throw error; }) as unknown as typeof childProcess.execFile);
		try {
			const result = queryTmuxClients(f.environment, signal), rejected = assert.rejects(result, /query failed/);
			if (kind === "event") { await query.started; query.child.emit("error", error); }
			await rejected;
			const count = realpath.mock.callCount();
			assert.equal(await resolveTmuxExecutable(f.environment, signal), f.executable);
			assert.ok(realpath.mock.callCount() > count, `${kind} ${code} must invalidate the cache`);
		} finally { query.execute.mock.restore(); realpath.mock.restore(); }
	}
});

test("deleted or nonexecutable cached helpers permit a fresh PATH search", { timeout: 3000 }, async (t) => {
	for (const failure of ["deleted", "permission"] as const) {
		const f = scratch(t), fallback = join(f.directory, "fallback"), signal = new AbortController().signal;
		mkdirSync(fallback);
		writeFileSync(join(fallback, "tmux"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(framed("kitty").toString())});\n`);
		chmodSync(join(fallback, "tmux"), 0o755);
		const environment = { ...f.environment, PATH: [f.directory, fallback].join(delimiter) };
		assert.equal(await resolveTmuxExecutable(environment, signal), f.executable);
		if (failure === "deleted") rmSync(f.executable); else chmodSync(f.executable, 0o644);
		const keepAlive = setTimeout(() => {}, 2000);
		try {
			await assert.rejects(queryTmuxClients(environment, signal), /query failed/);
			assert.deepEqual(await queryTmuxClients(environment, signal), ["kitty"], `${failure} starts the fallback helper after cache invalidation`);
		} finally { clearTimeout(keepAlive); }
	}
});

test("helper resolution excludes dependency directories and their aliases", { timeout: 1000 }, async (t) => {
	const f = scratch(t), dependency = join(f.directory, "node_modules", ".bin"), alias = join(f.directory, "dependency-alias");
	mkdirSync(dependency, { recursive: true }); symlinkSync(f.executable, join(dependency, "tmux")); symlinkSync(dependency, alias);
	assert.equal(await resolveTmuxExecutable({ PATH: [dependency, alias, f.directory].join(delimiter) }, new AbortController().signal), f.executable);
	await assert.rejects(resolveTmuxExecutable({ PATH: alias }, new AbortController().signal));
});

test("bell waits for bounded tmux preparation before the common admission", { timeout: 3000 }, async (t) => {
	const f = scratch(t), query = fakeQuery(t, "pending"), out = output();
	const callbacks = new Set<() => void>();
	assert.equal(TMUX_QUERY_TIMEOUT_MS, 1000, "common admission waits at most one second for the query");
	let expire!: () => void;
	const original = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
		if (args[1] === TMUX_QUERY_TIMEOUT_MS) expire = args[0] as () => void;
		return original(...args);
	});
	const dispatcher = new NotificationDispatcher({ mode: "tui", cwd: "/folder", settings: resolveNotificationSettings({ minimumDelayMs: 0, cooldownMs: 0 }, undefined, assert.fail),
		channels: createTerminalNotificationChannels({ mode: "tui", settings: { sequences: "auto" }, environment: f.environment, output: out.stream, warn: assert.fail }),
		current: () => true, idle: () => true, queued: () => false, recovering: () => false,
		schedule: (_delay, callback) => { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
	});
	try {
		dispatcher.dialog(true);
		for (let i = 0; i < 2; i++) { for (const callback of [...callbacks]) { callbacks.delete(callback); callback(); } await flush(); }
		await query.started; assert.deepEqual(out.writes, []);
		expire(); await flush(); assert.deepEqual(out.writes, [Buffer.from([7])], "the 1000 ms deadline releases bell admission");
		assert.deepEqual(query.killed, ["SIGKILL"]);
	} finally { dispatcher.retire(); await flush(); }
});

test("activity, dialog close and new run cancel a real pending query without consuming cooldown", { timeout: 3000 }, async (t) => {
	const f = scratch(t);
	for (const boundary of ["activity", "close", "new-run", "unchanged"] as const) {
		const query = fakeQuery(t, "pending"), out = output();
		let now = 0;
		const timers = new Set<{ at: number; callback: () => void }>();
		const dispatcher = new NotificationDispatcher({ mode: "tui", cwd: "/folder",
			settings: resolveNotificationSettings({ minimumDelayMs: 100, cooldownMs: 1000 }, undefined, assert.fail),
			channels: createTerminalNotificationChannels({ mode: "tui", settings: { sequences: "auto" }, environment: f.environment, output: out.stream, warn: assert.fail }),
			current: () => true, idle: () => true, queued: () => false, recovering: () => false, now: () => now,
			schedule: (delay, callback) => { const timer = { at: now + delay, callback }; timers.add(timer); return () => { timers.delete(timer); }; },
		});
		const advance = async (delay: number) => { now += delay; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.callback(); } await flush(); };
		const runWait = () => { dispatcher.runStart(); dispatcher.settled(); };
		try {
			if (boundary === "close") dispatcher.dialog(true); else runWait();
			await advance(100); await advance(0); await query.started; assert.deepEqual(out.writes, []);
			if (boundary === "activity") dispatcher.activity();
			if (boundary === "close") dispatcher.dialog(false);
			if (boundary === "new-run") dispatcher.runStart();
			assert.deepEqual(query.killed, boundary === "unchanged" ? [] : ["SIGKILL"]);
			query.complete(); await flush(); assert.equal(out.writes.length, boundary === "unchanged" ? 2 : 0);
			query.execute.mock.restore();
			const successor = fakeQuery(t, framed("Konsole"));
			runWait(); await advance(100); await advance(0);
			if (boundary !== "unchanged") { await successor.started; await flush(); }
			assert.equal(out.writes.length, 2, "cancelled query consumed no cooldown, but admitted control did");
			successor.execute.mock.restore();
		} finally { dispatcher.retire(); await flush(); query.execute.mock.restore(); }
	}
});

test("format classification leaves hostile names unidentified without changing neighboring clients", () => {
	const expressions = [...TMUX_CLIENT_FORMAT.matchAll(/#\{m\/r:([^,]+),#\{client_termtype\}\}/g)].map((match) => new RegExp(match[1]!));
	assert.equal(expressions.length, 7);
	const classify = (name: Buffer, pid: number) => `${pid}\t${expressions.map((expression) => {
		const value = name.toString("latin1"), match = expression.exec(value); return Number(match?.[0] === value);
	}).join("")}\n`;
	for (const hostile of [Buffer.from("\x1b".repeat(4) + "\n2\t7\tKonsole"), Buffer.from("\\033".repeat(4) + "\n2\t7\tKonsole"), Buffer.from("\ufeffkitty"), Buffer.from([255]), Buffer.from("kitty\n"), Buffer.from("#{client_termtype}"), Buffer.from("#(touch PRIVATE)")]) {
		for (const first of ["iTerm2", "Konsole"] as const) {
			const reply = Buffer.from(classify(Buffer.from(first), 1) + classify(Buffer.from("kitty"), 2) + classify(hostile, 3));
			assert.deepEqual(parseTmuxClients(reply), [first, "kitty"]);
			assert.deepEqual(selectTmuxNotificationProtocols(parseTmuxClients(reply)), first === "iTerm2" ? ["osc9"] : ["osc777"]);
		}
	}
	for (const terminal of Object.keys(support)) for (const name of [terminal, `${terminal} 1.2-test+4`, `${terminal}(1.2.3)`, `${terminal}\n`, `${terminal}(x)`, `${terminal} 1,2`, `${terminal} 1é`]) {
		assert.deepEqual(parseTmuxClients(Buffer.from(classify(Buffer.from(name), 1))), identifyNotificationTerminal(name) ? [terminal] : []);
	}
});

test("tmux query processes and timers do not hold the parent process open", { timeout: 3000 }, async (t) => {
	const f = scratch(t);
	writeFileSync(f.executable, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`);
	const module = new URL("../extension/notification-tmux.ts", import.meta.url).href;
	const child = childProcess.spawn(process.execPath, ["--input-type=module", "-e", `
		import { queryTmuxClients } from ${JSON.stringify(module)};
		import childProcess from 'node:child_process';
		const real = childProcess.execFile;
		childProcess.execFile = (...args) => {
			const child = real(...args);
			child.on('spawn', () => process.stdout.write(String(child.pid)));
			return child;
		};
		void queryTmuxClients(${JSON.stringify(f.environment)}, new AbortController().signal).catch(() => {});
	`], { env: { PATH: f.directory, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
	const deadline = setTimeout(() => child.kill("SIGKILL"), 1500);
	try {
		const status = await new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
		assert.equal(status, 0, stderr); assert.match(stdout, /^[0-9]+$/);
	} finally {
		clearTimeout(deadline); child.kill("SIGKILL");
		if (/^[0-9]+$/.test(stdout)) { try { process.kill(Number(stdout), "SIGKILL"); } catch { /* The fixture may already have exited. */ } }
	}
});
