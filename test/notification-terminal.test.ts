import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { automaticNotificationProtocols, createTerminalNotificationChannels } from "../extension/notification-terminal.ts";
import { NotificationDispatcher } from "../extension/notification-dispatcher.ts";
import { notificationText, notificationSequences } from "../extension/notification-protocols.ts";
import { resolveNotificationSettings, type NotificationProtocol } from "../extension/notification-config.ts";

const ESC = "\x1b", ST = `${ESC}\\`, BEL = "\x07";
const text = { title: "Input needed", body: "folder: …newest" };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function output(tty: boolean | undefined = true) {
	const writes: Buffer[] = [], callbacks: Array<(error?: Error | null) => void> = [];
	let held = false, fail = false;
	const stream = Object.assign(new EventEmitter(), { isTTY: tty,
		write(data: Buffer, callback: (error?: Error | null) => void) {
			writes.push(Buffer.from(data));
			if (held) callbacks.push(callback);
			else if (fail) { callback(new Error("PRIVATE output failure")); stream.emit("error", new Error("PRIVATE output failure")); }
			else callback();
			return !held;
		},
	});
	return { stream: stream as unknown as NodeJS.WriteStream, writes, callbacks,
		hold: () => { held = true; }, fail: () => { fail = true; },
		release: () => { held = false; for (const callback of callbacks.splice(0)) callback(); } };
}
function channels(sequences: "auto" | readonly NotificationProtocol[], environment: Record<string, string | undefined> = {}, mode = "tui", tty: boolean | undefined = true) {
	const out = output(tty), warnings: string[] = [];
	const options = { mode, settings: { sequences }, environment, output: out.stream, warn: (message: string) => { warnings.push(message); } };
	return { ...out, warnings, options, channels: createTerminalNotificationChannels(options) };
}
async function deliver(f: ReturnType<typeof channels>, name: "terminal" | "bell", signal = new AbortController().signal) {
	const send = await f.channels.find((channel) => channel.name === name)!.prepare(text, signal);
	await send();
}
function expected(protocol: NotificationProtocol, body = text.body, title = text.title): string[] {
	if (protocol === "osc9") return [`${ESC}]9;Slate: ${title}: ${body}${BEL}`];
	if (protocol === "osc777") return [`${ESC}]777;notify;${title};${body}${BEL}`];
	return [`${ESC}]99;i=ID:d=0;${title}${ST}`, `${ESC}]99;i=ID:p=body:d=1;${body}${ST}`];
}
function normalized(buffers: readonly Buffer[]): string[] {
	return buffers.map((buffer) => buffer.toString().replace(/i=[a-zA-Z0-9_+.-]+:/g, "i=ID:"));
}
function reconstructScreen(buffer: Buffer): Buffer {
	const chunks: Buffer[] = [];
	for (let offset = 0; offset < buffer.length;) {
		assert.deepEqual(buffer.subarray(offset, offset + 2), Buffer.from(`${ESC}P`));
		const end = buffer.indexOf(Buffer.from(ST), offset + 2);
		assert.ok(end >= 0 && end + 2 - offset <= 256);
		chunks.push(buffer.subarray(offset + 2, end)); offset = end + 2;
	}
	return Buffer.concat(chunks);
}

test("automatic environment selection covers every identity row and first-match precedence", { timeout: 1000 }, async () => {
	const cases: Array<[Record<string, string | undefined>, NotificationProtocol | undefined]> = [
		[{ TERM: "xterm-ghostty" }, "osc777"], [{ TERM: "xterm-kitty" }, "osc99"],
		[{ TERM: "foot" }, "osc99"], [{ TERM: "foot-extra" }, "osc99"], [{ TERM: "alacritty" }, undefined],
		[{ TERM_PROGRAM: "iTerm.app" }, "osc9"], [{ TERM_PROGRAM: "WezTerm" }, "osc777"],
		[{ TERM_PROGRAM: "ghostty" }, "osc777"], [{ TERM_PROGRAM: "vscode" }, "osc99"],
		[{ TERM_PROGRAM: "Alacritty" }, undefined], [{ TERM_PROGRAM: "Apple_Terminal" }, undefined],
		[{ LC_TERMINAL: "iTerm2" }, "osc9"], [{ KITTY_WINDOW_ID: "1" }, "osc99"],
		[{ KONSOLE_VERSION: "1" }, "osc777"], [{ WT_SESSION: "1" }, undefined],
		[{ VTE_VERSION: "1" }, undefined], [{ GNOME_TERMINAL_SCREEN: "1" }, undefined],
		[{}, undefined], [{ TERM: "xterm-256color", TERM_PROGRAM: "tmux" }, undefined],
		[{ TERM: "xterm-ghostty", TERM_PROGRAM: "iTerm.app" }, "osc777"],
		[{ TERM: "xterm-kitty", TERM_PROGRAM: "WezTerm" }, "osc99"],
		[{ TERM: "alacritty", TERM_PROGRAM: "vscode", KITTY_WINDOW_ID: "1" }, undefined],
		[{ TERM_PROGRAM: "vscode", KITTY_WINDOW_ID: "1", WT_SESSION: "1" }, "osc99"],
		[{ TERM_PROGRAM: "Apple_Terminal", LC_TERMINAL: "iTerm2" }, undefined],
		[{ LC_TERMINAL: "iTerm2", KITTY_WINDOW_ID: "1", KONSOLE_VERSION: "1" }, "osc9"],
		[{ KITTY_WINDOW_ID: "1", KONSOLE_VERSION: "1", WT_SESSION: "1" }, "osc99"],
		[{ KONSOLE_VERSION: "1", WT_SESSION: "1", VTE_VERSION: "1" }, "osc777"],
		[{ KITTY_WINDOW_ID: "", KONSOLE_VERSION: "", WT_SESSION: "", VTE_VERSION: "" }, undefined],
	];
	for (const [env, protocol] of cases) {
		assert.deepEqual(automaticNotificationProtocols(env), protocol ? [protocol] : [], JSON.stringify(env));
		const f = channels("auto", env); await deliver(f, "terminal");
		assert.deepEqual(normalized(f.writes), protocol ? expected(protocol) : []);
		await deliver(f, "bell"); assert.deepEqual(f.writes.at(-1), Buffer.from([7]));
		assert.deepEqual(f.warnings, []);
	}
});

test("explicit lists send exact complete bytes once in list order through every wrapper", { timeout: 1000 }, async () => {
	const order = ["osc99", "osc9", "osc777"] as const;
	for (const env of [{}, { TMUX: "1" }, { STY: "1" }, { ZELLIJ: "1" }]) {
		const f = channels(order, { TERM_PROGRAM: "Apple_Terminal", ...env });
		let queries = 0;
		f.channels = createTerminalNotificationChannels({ ...f.options, selectAutomatic: async () => { queries++; return ["osc777"]; } });
		await deliver(f, "terminal"); assert.equal(queries, 0); assert.equal(f.writes.length, 4);
		const unwrapped = f.writes.map((buffer) => {
			if ("TMUX" in env) {
				assert.ok(buffer.toString().startsWith(`${ESC}Ptmux;`)); assert.ok(buffer.toString().endsWith(ST));
				return Buffer.from(buffer.toString().slice(7, -2).replaceAll(ESC + ESC, ESC));
			}
			return "STY" in env ? reconstructScreen(buffer) : buffer;
		});
		assert.deepEqual(normalized(unwrapped), order.flatMap((protocol) => expected(protocol)));
		const id = unwrapped[0]!.toString().match(/i=([^:]+):/)![1]!;
		assert.match(id, /^[a-zA-Z0-9_+.-]{1,36}$/); assert.notEqual(id, "0");
		assert.ok(unwrapped[1]!.toString().includes(`i=${id}:p=body:d=1;`));
		if ("TMUX" in env) assert.deepEqual(normalized(f.writes), order.flatMap((protocol) => expected(protocol)).map((s) => `${ESC}Ptmux;${s.replaceAll(ESC, ESC + ESC)}${ST}`));
		if ("STY" in env) {
			for (const i of [0, 1]) {
				const sequence = normalized(unwrapped)[i]!;
				assert.equal(normalized([f.writes[i]!])[0], `${ESC}P${sequence.slice(0, -1)}${ST}${ESC}P\\${ST}`);
			}
		}
		await deliver(f, "bell"); assert.deepEqual(f.writes.at(-1), Buffer.from([7]), "bell has no wrapper");
	}
});

test("terminal and bell reject noninteractive modes and captured output before any selection", { timeout: 1000 }, async () => {
	for (const mode of ["tui", "rpc", "print"]) for (const tty of [true, false, undefined]) {
		if (mode === "tui" && tty === true) continue;
		const f = channels("auto", { TERM_PROGRAM: "WezTerm" }, mode, tty); let queried = false;
		Object.defineProperty(f.stream, "isTTY", { value: tty });
		f.channels = createTerminalNotificationChannels({ ...f.options, selectAutomatic: async () => { queried = true; return ["osc777"]; } });
		await deliver(f, "terminal"); await deliver(f, "bell"); assert.deepEqual(f.writes, []); assert.equal(queried, false);
	}
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		delete process.env.TMUX; delete process.env.STY; delete process.env.ZELLIJ;
		import { createTerminalNotificationChannels } from ${JSON.stringify(new URL("../extension/notification-terminal.ts", import.meta.url).href)};
		const channels = createTerminalNotificationChannels({ mode: "tui", settings: { sequences: ["osc777"] }, warn() {} });
		for (const channel of channels) await (await channel.prepare({ title: "PRIVATE", body: "PRIVATE" }, new AbortController().signal))();
	`], { encoding: "utf8", timeout: 1000 });
	assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
});

test("ambiguous multiplexer suppression is visible, bounded, content-free and independent of bell", { timeout: 1000 }, async () => {
	for (const env of [{ TMUX: "PRIVATE", STY: "PRIVATE" }, { TMUX: "PRIVATE", ZELLIJ: "PRIVATE" }, { STY: "PRIVATE", ZELLIJ: "PRIVATE" }]) {
		const f = channels(["osc99", "osc777", "osc9"], env);
		await deliver(f, "terminal"); await deliver(f, "terminal"); assert.deepEqual(f.writes, []);
		assert.deepEqual(f.warnings, ["slate: terminal notification suppressed. Multiple multiplexer hints leave the route ambiguous."]);
		assert.doesNotMatch(f.warnings.join(), /PRIVATE|folder|newest|Input needed/);
		await deliver(f, "bell"); assert.deepEqual(f.writes, [Buffer.from([7])]);
	}
	const f = channels(["osc9"], { TMUX: "1", STY: "1" });
	f.channels = createTerminalNotificationChannels({ ...f.options, warn: () => { throw new Error("PRIVATE"); } });
	await deliver(f, "terminal"); await deliver(f, "bell"); assert.deepEqual(f.writes, [Buffer.from([7])]);
});

test("automatic selector extension point is cancellable and falls back on failure", { timeout: 1000 }, async () => {
	const f = channels("auto", { TMUX: "1", TERM_PROGRAM: "iTerm.app" });
	let release!: (protocols: readonly NotificationProtocol[]) => void, observed: AbortSignal | undefined;
	f.channels = createTerminalNotificationChannels({ ...f.options, selectAutomatic: async (_env, signal) => {
		observed = signal; return new Promise((resolve) => { release = resolve; });
	} });
	const controller = new AbortController(), pending = f.channels[0]!.prepare(text, controller.signal);
	controller.abort(); release(["osc777"]); await (await pending)();
	assert.equal(observed, controller.signal); assert.deepEqual(f.writes, []);
	f.channels = createTerminalNotificationChannels({ ...f.options, selectAutomatic: async () => { throw new Error("PRIVATE query"); } });
	await deliver(f, "terminal"); assert.deepEqual(normalized(f.writes), expected("osc9").map((s) => `${ESC}Ptmux;${s.replaceAll(ESC, ESC + ESC)}${ST}`));
});

test("terminal preparation snapshots identity and multiplexer hints before selection", { timeout: 1000 }, async () => {
	for (const failure of [false, true]) {
		const environment = { TMUX: "original", TMUX_PANE: "%42", PATH: "/original", TERM_PROGRAM: "iTerm.app", STY: "", ZELLIJ: "" };
		const f = channels("auto", environment);
		let release!: () => void, observed!: Readonly<Record<string, string | undefined>>;
		f.channels = createTerminalNotificationChannels({ ...f.options, selectAutomatic: async (env) => {
			observed = env; await new Promise<void>((resolve) => { release = resolve; });
			if (failure) throw new Error("selection failed");
			return ["osc777"];
		} });
		const pending = f.channels[0]!.prepare(text, new AbortController().signal);
		Object.assign(environment, { TMUX: "changed", TMUX_PANE: "%99", PATH: "/changed", TERM_PROGRAM: "vscode", STY: "screen", ZELLIJ: "zellij" });
		assert.notEqual(observed, environment); assert.equal(observed.TMUX, "original"); assert.equal(observed.TMUX_PANE, "%42");
		assert.equal(observed.PATH, "/original"); assert.equal(observed.TERM_PROGRAM, "iTerm.app"); assert.equal(observed.STY, "");
		release(); await (await pending)();
		assert.deepEqual(normalized(f.writes), expected(failure ? "osc9" : "osc777").map((s) => `${ESC}Ptmux;${s.replaceAll(ESC, ESC + ESC)}${ST}`));
		assert.deepEqual(f.warnings, []);
	}
});

function dispatcherFixture(f: ReturnType<typeof channels>, config: object = {}) {
	const timers = new Set<() => void>();
	const dispatcher = new NotificationDispatcher({ mode: "tui", cwd: "/folder",
		settings: resolveNotificationSettings({ minimumDelayMs: 0, cooldownMs: 0, ...config }, undefined, assert.fail),
		channels: f.channels, current: () => true, idle: () => true, queued: () => false, recovering: () => false,
		schedule: (_delay, callback) => { timers.add(callback); return () => { timers.delete(callback); }; },
	});
	const tick = async () => { for (const callback of [...timers]) { timers.delete(callback); callback(); } await flush(); };
	const arm = () => { dispatcher.runStart(); dispatcher.message({ role: "assistant", stopReason: "stop", content: "text" }); dispatcher.settled(); };
	return { dispatcher, arm, tick };
}

test("background writes follow frames, hold channel slots and never interleave bell inside a request", { timeout: 1000 }, async () => {
	const f = channels(["osc99", "osc9", "osc777"]), a = dispatcherFixture(f), b = dispatcherFixture(f);
	f.hold();
	try {
		f.stream.write(Buffer.from("frame-before"), () => {});
		a.arm(); assert.equal(f.writes.length, 1); await a.tick(); assert.equal(f.writes.length, 1, "admission issues no write");
		await a.tick(); assert.equal(f.writes.length, 6);
		f.stream.write(Buffer.from("frame-after"), () => {});
		assert.deepEqual(normalized(f.writes).map((s) => s.startsWith(`${ESC}]`) ? s.slice(0, s.indexOf(";")) : s),
			["frame-before", `${ESC}]99`, `${ESC}]99`, `${ESC}]9`, `${ESC}]777`, BEL, "frame-after"]);
		a.dispatcher.retire(); b.arm(); await b.tick(); await b.tick(); assert.equal(f.writes.length, 7, "retired started writes retain both slots");
		f.release(); await flush();
		b.arm(); await b.tick(); await b.tick(); assert.equal(f.writes.length, 12, "completion frees both slots");
	} finally { f.release(); await flush(); a.dispatcher.retire(); b.dispatcher.retire(); }
});

test("disabled terminal and bell stay independent and write failures release channel slots", { timeout: 1000 }, async () => {
	for (const config of [{ terminal: false }, { bell: false }, { terminal: false, bell: false }]) {
		const f = channels(["osc777"]), d = dispatcherFixture(f, config);
		try { d.arm(); await d.tick(); await d.tick();
			assert.deepEqual(normalized(f.writes), config.terminal === false ? config.bell === false ? [] : [BEL] : [`${ESC}]777;notify;Input needed;${BEL}`]);
		} finally { await flush(); d.dispatcher.retire(); }
	}
	const bad = channels(["osc9"]); bad.fail(); const a = dispatcherFixture(bad);
	const good = channels(["osc9"]), b = dispatcherFixture(good);
	try {
		a.arm(); await a.tick(); await a.tick(); assert.equal(bad.writes.length, 2); assert.equal(bad.stream.listenerCount("error"), 0);
		b.arm(); await b.tick(); await b.tick(); assert.equal(good.writes.length, 2);
	} finally { await flush(); a.dispatcher.retire(); b.dispatcher.retire(); }
});

test("one failed write does not release a terminal slot while other accepted writes remain pending", { timeout: 1000 }, async () => {
	const f = channels(["osc99", "osc9"]), a = dispatcherFixture(f), other = channels(["osc777"]), b = dispatcherFixture(other);
	f.hold();
	try {
		a.arm(); await a.tick(); await a.tick(); assert.equal(f.callbacks.length, 4);
		f.callbacks.shift()!(new Error("PRIVATE failed title"));
		f.callbacks.pop()!(); await flush(); // The separate bell finishes while terminal writes remain pending.
		b.arm(); await b.tick(); await b.tick(); assert.deepEqual(other.writes, [Buffer.from([7])]);
		a.dispatcher.retire(); f.release(); await flush();
		b.arm(); await b.tick(); await b.tick(); assert.equal(other.writes.length, 3);
	} finally { f.release(); await flush(); a.dispatcher.retire(); b.dispatcher.retire(); }
});

test("cancellation before write acceptance suppresses scheduled, prepared and replaced attempts", { timeout: 1000 }, async () => {
	for (const phase of ["wait", "scheduled", "prepared"] as const) {
		const f = channels(["osc777"]), d = dispatcherFixture(f);
		try {
			d.arm(); if (phase !== "wait") await d.tick();
			if (phase === "prepared") {
				const prepare = f.channels[0]!.prepare;
				f.channels[0]!.prepare = async (...args) => { const send = await prepare(...args); d.dispatcher.retire(); return send; };
				await d.tick();
			}
			d.dispatcher.retire(); await d.tick(); assert.deepEqual(f.writes, []);
		} finally { await flush(); d.dispatcher.retire(); }
	}
	const f = channels(["osc99"]), controller = new AbortController();
	const terminal = await f.channels[0]!.prepare(text, controller.signal), bell = await f.channels[1]!.prepare(text, controller.signal);
	controller.abort(); await terminal(); await bell(); assert.deepEqual(f.writes, []);
	const prior = channels(["osc9"]), aborted = new AbortController(); aborted.abort();
	await deliver(prior, "terminal", aborted.signal); await deliver(prior, "bell", aborted.signal); assert.deepEqual(prior.writes, []);
	const redirected = channels(["osc777"]); const pending = await redirected.channels[0]!.prepare(text, new AbortController().signal);
	Object.defineProperty(redirected.stream, "isTTY", { value: false }); await pending(); assert.deepEqual(redirected.writes, []);
});

test("channel bytes sanitize all fields and retain the newest copied Unicode text under every limit", { timeout: 1000 }, async () => {
	const hostile = "\x00\x07\x1b\x7f\u0085\u061c\u200f\u2028\u2029\u202a\u2069";
	for (const protocol of ["osc9", "osc777", "osc99"] as const) {
		const folderOnly = "é".repeat(300);
		const folderRequests = notificationSequences(protocol, { title: "Input needed", body: folderOnly }, "a".repeat(36));
		const folderHeader = protocol === "osc9" ? `${ESC}]9;Slate: Input needed: ` : protocol === "osc777" ? `${ESC}]777;notify;Input needed;` : `${ESC}]99;i=${"a".repeat(36)}:p=body:d=1;`;
		const ending = protocol === "osc99" ? ST : BEL;
		assert.equal(folderRequests.at(-1)!.toString(), folderHeader + "é".repeat(Math.floor((252 - Buffer.byteLength(folderHeader + ending)) / 2)) + ending);
		const f = channels([protocol]);
		const send = await f.channels[0]!.prepare({ title: `1;title${hostile}`, body: `body;:= ${hostile}` }, new AbortController().signal); await send();
		assert.deepEqual(normalized(f.writes), protocol === "osc99" ? expected(protocol, "body;:= ", "1;title") : expected(protocol, "body:= ", "1title"));
		const folder = "folder".repeat(20), message = "OLDEST" + "😀".repeat(46) + "NEWEST";
		const requests = notificationSequences(protocol, notificationText("input-needed", "message", `/private/${folder}`, message), "a".repeat(36));
		const budget = 252 - Buffer.byteLength(folderHeader + ending);
		const copied = "😀".repeat(Math.floor((budget - Buffer.byteLength(folder + ": …NEWEST")) / 4)) + "NEWEST";
		assert.deepEqual(requests.at(-1), Buffer.from(folderHeader + folder + ": …" + copied + ending));
		for (const request of requests) {
			assert.ok(request.length <= 252); assert.equal(new TextDecoder("utf8", { fatal: true }).decode(request), request.toString());
		}
	}
	const title = "project: …" + "é".repeat(200) + "NEWEST";
	for (const protocol of ["osc9", "osc777"] as const) {
		const titled = notificationSequences(protocol, { title, body: "" })[0]!;
		assert.ok(titled.toString().includes("project: …"));
		assert.ok(titled.toString().includes("NEWEST"));
		assert.ok(titled.length <= 252); assert.equal(new TextDecoder("utf8", { fatal: true }).decode(titled), titled.toString());
	}
	const noFolder = notificationSequences("osc99", notificationText("error", "message", "/", "é".repeat(100)), "a".repeat(36))[1]!;
	assert.ok(noFolder.toString().includes(";…")); assert.ok(noFolder.toString().endsWith(`é${ST}`));
	const titleRequest = notificationSequences("osc99", { title, body: "" }, "a".repeat(36))[0]!;
	assert.ok(titleRequest.toString().startsWith(`${ESC}]99;i=${"a".repeat(36)}:d=0;project: …`));
	assert.ok(titleRequest.toString().endsWith(`NEWEST${ST}`)); assert.ok(titleRequest.length <= 252);
	const longTitle = notificationSequences("osc99", { title: "é".repeat(200), body: "" }, "a".repeat(36))[0]!;
	const titleHeader = `${ESC}]99;i=${"a".repeat(36)}:d=0;`;
	assert.equal(longTitle.toString().slice(0, -2), titleHeader + "é".repeat(Math.floor((252 - Buffer.byteLength(titleHeader + ST)) / 2)));
});

const bodyFields = [
	{ protocol: "osc9", header: `${ESC}]9;Slate: Input needed: `, ending: BEL, budget: 226 },
	{ protocol: "osc777", header: `${ESC}]777;notify;Input needed;`, ending: BEL, budget: 225 },
	{ protocol: "osc99", header: `${ESC}]99;i=${"a".repeat(36)}:p=body:d=1;`, ending: ST, budget: 195 },
] as const;

test("every body and title field preserves folders below, at and above its folder-alone budget", () => {
	const fields = [...bodyFields.map((field) => ({ ...field, title: false })),
		{ protocol: "osc777", header: `${ESC}]777;notify;`, ending: `;${BEL}`, budget: 100, title: true },
		{ protocol: "osc99", header: `${ESC}]99;i=${"a".repeat(36)}:d=0;`, ending: ST, budget: 202, title: true },
	] as const;
	for (const { protocol, header, ending, budget, title } of fields) {
		const cases: Array<[string, string]> = [
			["f".repeat(budget - 11), "f".repeat(budget - 11) + ": …NEWEST"],
			["f".repeat(budget - 6), "f".repeat(budget - 6) + ": …T"],
			...[5, 3, 2, 1, 0].map((gap): [string, string] => ["f".repeat(budget - gap), "f".repeat(budget - gap)]),
			["f".repeat(budget + 1), "f".repeat(budget)],
			["f".repeat(budget - 1) + "é", "f".repeat(budget - 1)],
			["f".repeat(budget - 2) + "é", "f".repeat(budget - 2) + "é"],
		];
		for (const [folder, fitted] of cases) {
			const source = notificationText("input-needed", "message", `/private/${folder}`, "NEWEST");
			const requests = notificationSequences(protocol, title ? { title: source.body, body: "" } : source, "a".repeat(36));
			const request = title ? requests[0]! : requests.at(-1)!;
			assert.deepEqual(request, Buffer.from(header + fitted + ending), `${protocol} ${title ? "title" : "body"}, ${Buffer.byteLength(folder)} folder bytes`);
			assert.ok(request.length <= 252);
			assert.equal(new TextDecoder("utf8", { fatal: true }).decode(request), request.toString());
		}
		for (const [message, gap, suffix] of [["é", 6, ""], ["é", 7, ": …é"], ["😀", 8, ""], ["😀", 9, ": …😀"]] as const) {
			const folder = "f".repeat(budget - gap);
			const source = notificationText("input-needed", "message", `/private/${folder}`, message);
			const requests = notificationSequences(protocol, title ? { title: source.body, body: "" } : source, "a".repeat(36));
			assert.deepEqual(title ? requests[0] : requests.at(-1), Buffer.from(header + folder + suffix + ending));
		}
	}
});

test("production text keeps a sanitized 210-byte folder until the protocol budget is known", () => {
	const folder = "f".repeat(210), source = notificationText("input-needed", "message", `/private/${folder}\x1b\u200f`, "NEWEST");
	assert.equal(source.folder, folder);
	assert.equal(source.body, folder + ": …NEWEST");
	const requests = notificationSequences("osc777", source);
	assert.deepEqual(requests, [Buffer.from(`${ESC}]777;notify;Input needed;${folder}: …NEWEST${BEL}`)]);
	assert.equal(requests[0]!.length, 248);
});

test("copied and JSON-round-tripped text keeps explicit boundaries when folders contain the marker", () => {
	for (const { protocol, header, ending, budget } of bodyFields) {
		const folder = "prefix: …" + "f".repeat(budget - 17);
		const source = notificationText("input-needed", "message", `/private/${folder}`, "NEWEST");
		for (const copy of [source, { ...source }, JSON.parse(JSON.stringify(source))]) {
			assert.deepEqual(notificationSequences(protocol, copy, "a".repeat(36)).at(-1), Buffer.from(header + folder + ": …T" + ending));
		}
		const projectFolder = folder + "EXCESS!";
		const project = notificationText("input-needed", "project", `/private/${projectFolder}`, "PRIVATE");
		assert.deepEqual(notificationSequences(protocol, JSON.parse(JSON.stringify(project)), "a".repeat(36)).at(-1), Buffer.from(header + folder + "EXCESS" + ending));
	}
});
