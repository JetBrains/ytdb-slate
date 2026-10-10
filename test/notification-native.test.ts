import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createNativeNotificationChannel, NATIVE_ATTEMPT_TIMEOUT_MS, NATIVE_PREPARE_TIMEOUT_MS, NATIVE_TEXT_MAX_BYTES } from "../extension/notification-native.ts";
import { NotificationDispatcher } from "../extension/notification-dispatcher.ts";
import { NOTIFICATION_DEFAULTS } from "../extension/notification-config.ts";
import { notificationText, sanitizeNotificationText, truncateNotificationUtf8 } from "../extension/notification-protocols.ts";

const spawnRealChild = childProcess.spawn;
let sequence = 0;
const hostile = '-option --version -e --wait "quotes" \' $(touch /tmp/PRIVATE) `code` <a href="x">&\nline\u202e';
function fixture(t: test.TestContext, platform: NodeJS.Platform = "linux") {
	const projectDirectory = `/native-project-${++sequence}`;
	const environment: Record<string, string> = { PATH: "/trusted/bin", DISPLAY: ":1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/bus", WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/1", HOME: "/home/user", SystemRoot: "/Windows", WINDIR: "/Windows", USERPROFILE: "/Users/user", APPDATA: "/Users/user/AppData/Roaming", LOCALAPPDATA: "/Users/user/AppData/Local", SECRET: "private", NODE_OPTIONS: "private", DYLD_INSERT_LIBRARIES: "private", PSModulePath: "/project/module" };
	const children: Array<EventEmitter & { kills: string[]; unrefs: number; kill: (signal: string) => boolean; unref: () => void }> = [];
	const calls: Array<{ executable: string; args: string[]; options: childProcess.SpawnOptions }> = [];
	const searches: string[] = [];
	const executables = () => platform === "darwin" ? ["/usr/bin/osascript"] : platform === "win32" ? ["/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"] : environment.PATH!.split(":").filter((path) => path.startsWith("/")).map((path) => resolve(path, "notify-send"));
	t.mock.method(fs, "realpath", async (path: string) => {
		searches.push(path);
		if (path !== projectDirectory && !executables().some((executable) => path === executable || path === dirname(executable))) throw new Error("unknown fixture path");
		return path;
	});
	t.mock.method(fs, "stat", async (path: string) => ({ isFile: () => executables().includes(path) }));
	t.mock.method(fs, "access", async (path: string, mode: number) => {
		assert.equal(mode, constants.X_OK, "helper access must request executable permission");
		assert.ok(executables().includes(path), "only the exact platform helper is executable");
	});
	t.mock.method(childProcess, "spawn", (executable: string, args: string[], options: childProcess.SpawnOptions) => {
		calls.push({ executable, args, options });
		const child = Object.assign(new EventEmitter(), { kills: [] as string[], unrefs: 0, kill(this: EventEmitter & { kills: string[] }, signal: string) { this.kills.push(signal); queueMicrotask(() => this.emit("exit", null, signal)); return true; }, unref() { this.unrefs++; } });
		children.push(child); return child;
	});
	const channel = createNativeNotificationChannel({ mode: "tui", projectDirectory, platform, environment });
	t.after(() => { for (const child of children) child.emit("exit", 0); });
	return { channel, environment, children, calls, searches, projectDirectory };
}

test("every native parser receives sanitized text as data and only its minimal environment", { timeout: 2000 }, async (t) => {
	for (const platform of ["linux", "darwin", "win32"] as const) {
		const f = fixture(t, platform), signal = new AbortController().signal;
		const send = await f.channel.prepare({ title: hostile, body: hostile }, signal);
		assert.equal(f.calls.length, 0, "preparation never accepts delivery");
		const pending = send(); const call = f.calls[0]!;
		assert.equal(call.options.shell, false); assert.equal(call.options.cwd, "/");
		assert.equal(call.options.stdio, "ignore"); assert.equal(call.options.windowsHide, true);
		assert.ok(call.executable.startsWith("/")); assert.equal(f.children[0]!.unrefs, 1);
		const literal = sanitizeNotificationText(hostile);
		if (platform === "linux") {
			assert.equal(call.executable, "/trusted/bin/notify-send");
			assert.deepEqual(call.args, ["--app-name=Slate", "--", literal, literal.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")]);
			assert.deepEqual(call.options.env, { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/bus", XDG_RUNTIME_DIR: "/run/user/1" });
		} else if (platform === "darwin") {
			assert.equal(call.executable, "/usr/bin/osascript");
			assert.deepEqual(call.args, ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", literal, literal]);
			assert.deepEqual(call.options.env, { HOME: "/home/user" });
		} else {
			assert.equal(call.options.env!.SLATE_NOTIFICATION_TITLE, literal);
			assert.equal(call.options.env!.SLATE_NOTIFICATION_BODY, literal);
			assert.ok(!call.args.some((arg) => arg.includes(literal)));
			assert.equal(call.executable, "/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
			assert.deepEqual(call.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
			assert.equal(call.args.length, 5, "no trailing interpreter code arguments");
			const script = Buffer.from(call.args[4]!, "base64").toString("utf16le");
			assert.match(script, /Get-StartApps -Name 'Windows PowerShell'/);
			assert.match(script, /CreateToastNotifier\(\$app.AppID\)\.Show\(\$toast\)/);
			assert.match(script, /CreateTextNode\(\$env:SLATE_NOTIFICATION_TITLE\)/);
			assert.match(script, /CreateTextNode\(\$env:SLATE_NOTIFICATION_BODY\)/);
			assert.match(script, /LoadXml\('<toast>.*<text\/><text\/>/);
			assert.ok(!script.includes(hostile));
			assert.deepEqual(Object.keys(call.options.env!).sort(), ["APPDATA", "LOCALAPPDATA", "SLATE_NOTIFICATION_BODY", "SLATE_NOTIFICATION_TITLE", "SystemRoot", "USERPROFILE", "WINDIR"]);
		}
		f.children[0]!.emit("spawn"); f.children[0]!.emit("exit", 0); await pending;
		const long = notificationText("error", "message", "/" + "é".repeat(700), "NEWEST");
		const more = await f.channel.prepare(long, signal), result = more();
		const last = f.calls.at(-1)!;
		assert.equal(platform === "win32" ? last.options.env!.SLATE_NOTIFICATION_BODY : last.args.at(-1), truncateNotificationUtf8(long.body, NATIVE_TEXT_MAX_BYTES));
		assert.equal(f.searches.filter((path) => path === f.projectDirectory).length, 1, "successful helper resolution is cached");
		f.children.at(-1)!.emit("exit", 0); await result;
		t.mock.restoreAll();
	}
});

test("macOS keeps option-shaped fields separate and truncates Unicode text in trailing arguments", { timeout: 2000 }, async (t) => {
	const f = fixture(t, "darwin"), signal = new AbortController().signal;
	const values = ["--", "-e", "-l", "-s", "-i", ""];
	const texts = values.map((title, index) => ({ title, body: values[(index + 1) % values.length]! }));
	texts.push({ title: "\u0000" + "é".repeat(513) + "尾", body: "\u001b" + "😀".repeat(257) + "尾" });
	for (const text of texts) {
		const pending = (await f.channel.prepare(text, signal))();
		const call = f.calls.at(-1)!;
		const title = truncateNotificationUtf8(sanitizeNotificationText(text.title), NATIVE_TEXT_MAX_BYTES);
		const body = truncateNotificationUtf8(sanitizeNotificationText(text.body), NATIVE_TEXT_MAX_BYTES);
		assert.deepEqual(call.args, ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body]);
		assert.equal(call.args[6], "--");
		assert.deepEqual(call.args.slice(-2), [title, body]);
		assert.deepEqual(call.options.env, { HOME: "/home/user" });
		assert.ok(Buffer.byteLength(title, "utf8") <= NATIVE_TEXT_MAX_BYTES);
		assert.ok(Buffer.byteLength(body, "utf8") <= NATIVE_TEXT_MAX_BYTES);
		if (text.title.startsWith("\u0000")) {
			assert.equal(title, "é".repeat(512));
			assert.equal(body, "😀".repeat(256));
		}
		f.children.at(-1)!.emit("exit", 0); await pending;
	}
});

test("Linux encodes literal backslashes before the notify-send escape parser", { timeout: 2000 }, async (t) => {
	const f = fixture(t), signal = new AbortController().signal;
	for (const body of [String.raw`C:\new\file`, String.raw`\074b\076`, String.raw`\033`, String.raw`\000`, String.raw`\377`]) {
		const pending = (await f.channel.prepare({ title: body, body }, signal))();
		assert.deepEqual(f.calls.at(-1)!.args, ["--app-name=Slate", "--", body, body.replaceAll("\\", "\\\\")]);
		f.children.at(-1)!.emit("exit", 0); await pending;
	}
});

test("native preparation stops for missing desktop, unsupported platform, invalid helper path and noninteractive mode", { timeout: 2000 }, async (t) => {
	for (const platform of ["linux", "win32", "freebsd"] as const) {
		const f = fixture(t, platform); delete f.environment.DISPLAY; delete f.environment.WAYLAND_DISPLAY; delete f.environment.SystemRoot;
		await (await f.channel.prepare({ title: hostile, body: hostile }, new AbortController().signal))();
		assert.deepEqual(f.calls, []); assert.deepEqual(f.searches, []); t.mock.restoreAll();
	}
	const f = fixture(t);
	for (const environment of [{ ...f.environment, DBUS_SESSION_BUS_ADDRESS: "", XDG_RUNTIME_DIR: "" }, { ...f.environment, PATH: "x".repeat(16385) }]) {
		await (await createNativeNotificationChannel({ mode: "tui", projectDirectory: f.projectDirectory, environment }).prepare({ title: "T", body: "" }, new AbortController().signal))();
	}
	for (const mode of ["rpc", "print"]) await (await createNativeNotificationChannel({ mode, projectDirectory: f.projectDirectory }).prepare({ title: "T", body: "" }, new AbortController().signal))();
	assert.deepEqual(f.calls, []); assert.deepEqual(f.searches, []);
});

test("search rejects project helpers, dependency aliases, nonfiles and denied executable access", { timeout: 2000 }, async (t) => {
	const f = fixture(t);
	f.environment.PATH = `relative:${f.projectDirectory}/bin:/outside/node_modules/bin:/alias:/bad:/nonfile:/denied:/trusted/bin`;
	t.mock.method(fs, "realpath", async (path: string) => path === "/alias" ? `${f.projectDirectory}/bin` : path === "/bad/notify-send" ? "/dependency/node_modules/notify-send" : path);
	t.mock.method(fs, "stat", async (path: string) => ({ isFile: () => !path.startsWith("/nonfile/") }));
	t.mock.method(fs, "access", async (path: string, mode: number) => {
		assert.equal(mode, constants.X_OK);
		if (path.startsWith("/denied/")) throw new Error("PRIVATE denied");
		assert.equal(path, "/trusted/bin/notify-send");
	});
	const send = await f.channel.prepare({ title: "T", body: "" }, new AbortController().signal), pending = send();
	assert.equal(f.calls[0]!.executable, "/trusted/bin/notify-send"); f.children[0]!.emit("exit", 1); await pending;
	f.environment.PATH = "relative";
	await (await f.channel.prepare({ title: "T", body: "" }, new AbortController().signal))(); assert.equal(f.calls.length, 1);
});

test("prepare abort settles promptly, holds the filesystem guard and blocks late spawn", { timeout: 3000 }, async (t) => {
	const f = fixture(t); let release!: (path: string) => void;
	t.mock.method(fs, "realpath", (path: string) => new Promise<string>((done) => { release = () => done(path); }));
	const controller = new AbortController(), pending = f.channel.prepare({ title: "T", body: "" }, controller.signal);
	controller.abort(); await (await pending)();
	for (let i = 0; i < 5; i++) await (await createNativeNotificationChannel({ mode: "tui", projectDirectory: `/another-${i}`, environment: f.environment }).prepare({ title: "T", body: "" }, new AbortController().signal))();
	assert.equal(f.calls.length, 0); release("ignored"); await delay(10); assert.equal(f.calls.length, 0);
	const already = new AbortController(); already.abort(); await (await f.channel.prepare({ title: "T", body: "" }, already.signal))();
	t.mock.method(fs, "realpath", async (path: string) => path);
	const fresh = createNativeNotificationChannel({ mode: "tui", projectDirectory: f.projectDirectory, environment: f.environment });
	const resumed = (await fresh.prepare({ title: "T", body: "" }, new AbortController().signal))();
	assert.equal(f.calls.length, 1, "the resolver can search after the cancelled owner settles");
	f.children[0]!.emit("spawn"); f.children[0]!.emit("exit", 0); await resumed;
	const cached = (await fresh.prepare({ title: "T", body: "" }, new AbortController().signal))();
	assert.equal(f.calls.length, 2); f.children[1]!.emit("exit", 0); await cached;
});

test("prepare deadline releases same-type preparation without accumulating blocked filesystem calls", { timeout: 3000 }, async (t) => {
	const f = fixture(t); let release!: () => void, searches = 0;
	t.mock.method(fs, "realpath", (path: string) => { searches++; return new Promise<string>((done) => { release = () => done(path); }); });
	const pending = f.channel.prepare({ title: "T", body: "" }, new AbortController().signal);
	await delay(NATIVE_PREPARE_TIMEOUT_MS + 30); await (await pending)();
	for (let i = 0; i < 5; i++) await (await f.channel.prepare({ title: "T", body: "" }, new AbortController().signal))();
	assert.equal(searches, 1); assert.equal(f.calls.length, 0); release(); await delay(10); assert.equal(f.calls.length, 0);
});

test("abort before helper acceptance kills it, accepted work ignores abort and stops at its own deadline", { timeout: 8000 }, async (t) => {
	const f = fixture(t), first = new AbortController();
	const keepAlive = setInterval(() => {}, 10_000);
	t.after(() => clearInterval(keepAlive));
	const pending = (await f.channel.prepare({ title: "T", body: "" }, first.signal))(); first.abort(); await pending;
	assert.deepEqual(f.children[0]!.kills, ["SIGKILL"]); f.children[0]!.emit("spawn");
	const second = new AbortController(), accepted = (await f.channel.prepare({ title: "T", body: "" }, second.signal))();
	f.children[1]!.emit("spawn"); second.abort(); await delay(20); assert.deepEqual(f.children[1]!.kills, []);
	await accepted; assert.deepEqual(f.children[1]!.kills, ["SIGKILL"]);
});

test("cancelled native preparation promptly releases a deferred same-type dialog and blocks a prepared start", { timeout: 2000 }, async (t) => {
	const f = fixture(t), controller = new AbortController();
	const prepared = await f.channel.prepare({ title: "T", body: "" }, controller.signal); controller.abort(); await prepared(); assert.equal(f.calls.length, 0);
	let release!: () => void;
	t.mock.method(fs, "access", () => new Promise<void>((done) => { release = done; }));
	// A new search key forces final-access preparation rather than the successful cache.
	f.environment.PATH = "/different/bin";
	let bells = 0;
	const d = new NotificationDispatcher({ mode: "tui", cwd: f.projectDirectory, settings: { ...NOTIFICATION_DEFAULTS, minimumDelayMs: 0, cooldownMs: 0 }, channels: [f.channel, { name: "bell", prepare: async () => () => { bells++; } }], current: () => true, idle: () => true, queued: () => false, recovering: () => false });
	t.after(() => { d.retire(); release?.(); });
	d.runStart(); d.settled(); await delay(30); assert.ok(release);
	d.dialog(true); await delay(10); d.runStart(); await delay(20);
	assert.equal(f.calls.length, 0, "aborted preparation cannot start a helper");
	assert.equal(bells, 1, "prepare abort promptly releases the same-type owner for the deferred dialog");
	release(); await delay(10); t.mock.method(fs, "access", async () => {});
	// The deferred dialog has already failed its search while the old lookup remains pending.
	d.dialog(false); d.dialog(true); await delay(30); assert.equal(f.calls.length, 1);
	f.children[0]!.emit("spawn"); f.children[0]!.emit("exit", 0); await delay(10);
});

test("native termination exceptions and late child errors cannot escape cancellation", { timeout: 2000 }, async (t) => {
	const f = fixture(t), controller = new AbortController();
	const pending = (await f.channel.prepare({ title: "T", body: "" }, controller.signal))();
	f.children[0]!.kill = () => { throw new Error("PRIVATE termination failure"); };
	let settled = false; void Promise.resolve(pending).then(() => { settled = true; });
	controller.abort(); await delay(10); assert.equal(settled, false, "a thrown kill does not release delivery");
	f.children[0]!.emit("error", new Error("PRIVATE late process error"));
	await delay(10); assert.equal(settled, false, "an error event does not confirm termination");
	f.children[0]!.emit("exit", 1); await pending;
	assert.equal(f.calls.length, 1);
	const missing = fixture(t, "darwin"); delete missing.environment.HOME;
	t.mock.method(fs, "realpath", async () => { throw new Error("PRIVATE missing utility"); });
	await (await missing.channel.prepare({ title: "T", body: "" }, new AbortController().signal))();
	assert.deepEqual(missing.calls, []);
});

test("native spawn failures and exit codes stay local and invalidated cache can resolve again", { timeout: 2000 }, async (t) => {
	const f = fixture(t), signal = new AbortController().signal;
	for (const code of [0, 1]) { const pending = (await f.channel.prepare({ title: hostile, body: hostile }, signal))(); f.children.at(-1)!.emit("exit", code); await pending; }
	const pending = (await f.channel.prepare({ title: "T", body: "" }, signal))(); f.children.at(-1)!.emit("error", new Error("PRIVATE spawn error")); f.children.at(-1)!.emit("close", -2); await pending;
	const count = f.searches.length;
	t.mock.method(childProcess, "spawn", () => { throw new Error("PRIVATE spawn exception"); });
	await (await f.channel.prepare({ title: "T", body: "" }, signal))(); assert.ok(f.searches.length > count);
	await (await f.channel.prepare({ title: "T", body: "" }, signal))();
});

test("real failed kills retain the native slot until the helper exits", { timeout: 10000 }, async (t) => {
	const f = fixture(t), children: childProcess.ChildProcess[] = [];
	t.mock.method(childProcess, "spawn", (() => {
		const child = spawnRealChild(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
		children.push(child); return child;
	}) as typeof childProcess.spawn);
	const options = { mode: "tui", cwd: f.projectDirectory, settings: { ...NOTIFICATION_DEFAULTS, minimumDelayMs: 0, cooldownMs: 0 }, channels: [f.channel], current: () => true, idle: () => true, queued: () => false, recovering: () => false };
	const first = new NotificationDispatcher(options), replacement = new NotificationDispatcher(options);
	const admit = async (dispatcher: NotificationDispatcher) => { dispatcher.runStart(); dispatcher.settled(); await delay(30); };
	t.after(async () => {
		first.retire(); replacement.retire();
		for (const child of children) if (child.exitCode === null && child.signalCode === null) {
			const exit = new Promise<void>((done) => child.once("exit", () => done()));
			childProcess.ChildProcess.prototype.kill.call(child, "SIGKILL"); await exit;
		}
	});
	const keepAlive = setInterval(() => {}, 10_000);
	t.after(() => clearInterval(keepAlive));
	await admit(first); assert.equal(children.length, 1);
	const child = children[0]!;
	if (child.pid === undefined) await once(child, "spawn");
	let attempted = false;
	const killed = new Promise<void>((done) => {
		child.kill = () => { attempted = true; child.emit("error", new Error("injected EPERM")); done(); return false; };
	});
	first.retire(); await admit(replacement); assert.equal(attempted, false, "replacement does not retract accepted work");
	await killed; process.kill(child.pid!, 0);
	assert.equal(child.exitCode, null); assert.equal(child.signalCode, null, "the real helper remains alive after a failed deadline kill");
	await admit(replacement); assert.equal(children.length, 1, "the accepted helper still owns the native slot");
	const exit = once(child, "exit");
	childProcess.ChildProcess.prototype.kill.call(child, "SIGKILL"); await exit; await delay(0);
	await admit(replacement); assert.equal(children.length, 2, "confirmed exit releases the slot");
});

test("replacement and reload skip accepted native work until its limit releases the slot, shutdown never waits", { timeout: 8000 }, async (t) => {
	const f = fixture(t), second = await import(`../extension/notification-dispatcher.ts?reload=${sequence}`);
	const options = { mode: "tui", cwd: f.projectDirectory, settings: { ...NOTIFICATION_DEFAULTS, minimumDelayMs: 0, cooldownMs: 0 }, channels: [f.channel], current: () => true, idle: () => true, queued: () => false, recovering: () => false };
	const a = new NotificationDispatcher(options), b = new second.NotificationDispatcher(options);
	t.after(() => { a.retire(); b.retire(); });
	a.runStart(); a.settled(); await delay(30); assert.equal(f.calls.length, 1); f.children[0]!.emit("spawn");
	a.retire(); b.runStart(); b.settled(); await delay(30); assert.equal(f.calls.length, 1); assert.deepEqual(f.children[0]!.kills, []);
	await delay(NATIVE_ATTEMPT_TIMEOUT_MS); assert.deepEqual(f.children[0]!.kills, ["SIGKILL"]);
	b.runStart(); b.settled(); await delay(30); assert.equal(f.calls.length, 2);
	b.retire(); await delay(10); assert.deepEqual(f.children[1]!.kills, ["SIGKILL"]);
});

test("separately evaluated native modules share one blocked filesystem search", { timeout: 5000 }, () => {
	const url = new URL("../extension/notification-native.ts", import.meta.url).href;
	// An explicit undefined prevents Node from restoring inherited coverage.
	const environment = { ...process.env, NODE_V8_COVERAGE: undefined };
	const result = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", `
		import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import cp from 'node:child_process'; import { EventEmitter } from 'node:events';
		assert.equal(process.env.NODE_V8_COVERAGE, undefined, 'multi-copy probe gets no coverage credit');
		const a = await import(${JSON.stringify(url)}), b = await import(${JSON.stringify(url + "?reload=search")});
		assert.notEqual(a.createNativeNotificationChannel, b.createNativeNotificationChannel);
		let searches = 0, release; fs.realpath = path => { searches++; return new Promise(done => { release = () => done(path); }); };
		cp.spawn = () => { throw new Error('unexpected spawn'); };
		const deadline = setTimeout(() => { throw new Error('prepare did not settle'); }, 2000);
		const options = {mode:'tui', projectDirectory:'/project', environment:{PATH:'/trusted', DISPLAY:':1', DBUS_SESSION_BUS_ADDRESS:'unix:path=/bus'}};
		const controller = new AbortController(); const pending = a.createNativeNotificationChannel(options).prepare({title:'T', body:''}, controller.signal);
		controller.abort(); await (await pending)();
		for (let i = 0; i < 5; i++) await (await b.createNativeNotificationChannel({...options, projectDirectory:'/other-'+i}).prepare({title:'T', body:''}, new AbortController().signal))();
		assert.equal(searches, 1); release(); await new Promise(done => setTimeout(done, 10));
		fs.realpath = async path => path; fs.stat = async () => ({isFile: () => true}); fs.access = async () => {};
		const calls = []; cp.spawn = (executable, args, settings) => {
			calls.push({executable, args, settings}); const child = Object.assign(new EventEmitter(), {unref() {}, kill() {return true;}});
			queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0); }); return child;
		};
		for (const platform of ['linux', 'darwin', 'win32']) {
			const channel = b.createNativeNotificationChannel({...options, platform, environment:{...options.environment, HOME:'/home/user', SystemRoot:'/Windows'}});
			await (await channel.prepare({title:'-option', body:'<&> $(code)'}, new AbortController().signal))();
			const call = calls.at(-1); assert.equal(call.settings.shell, false); assert.equal(call.settings.cwd, '/');
			if (platform === 'linux') assert.deepEqual(call.args.slice(-3), ['--', '-option', '&lt;&amp;&gt; $(code)']);
			else if (platform === 'darwin') {
				assert.deepEqual(call.args, ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', '--', '-option', '<&> $(code)']);
				assert.deepEqual(call.settings.env, {HOME:'/home/user'});
			} else { assert.equal(call.settings.env.SLATE_NOTIFICATION_TITLE, '-option'); assert.equal(call.settings.env.SLATE_NOTIFICATION_BODY, '<&> $(code)'); }
		}
		assert.equal(calls.length, 3, 'reload retains all three native routes after search settlement');
		for (const extra of [{mode:'rpc'}, {platform:'freebsd'}, {platform:'win32', environment:{}}, {environment:{}}])
			await (await b.createNativeNotificationChannel({...options, ...extra}).prepare({title:'T', body:''}, new AbortController().signal))();
		assert.equal(calls.length, 3, 'reload retains route suppression');
		let child, kills = 0;
		cp.spawn = () => { child = Object.assign(new EventEmitter(), {unref() {}, kill(signal) {assert.equal(signal, 'SIGKILL'); kills++; return true;}}); return child; };
		const send = await a.createNativeNotificationChannel(options).prepare({title:'T', body:''}, new AbortController().signal);
		const pendingDelivery = send(); child.emit('spawn'); b.stopNativeNotificationHelpers();
		assert.equal(kills, 1, 'a reloaded native module stops the earlier runtime helper at quit');
		child.emit('exit', null, 'SIGKILL'); await pendingDelivery; clearTimeout(deadline);
	`], { timeout: 3000, encoding: "utf8", env: environment });
	assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
});

test("real native timers and helper handles are unreferenced and accepted work does not delay process exit", { timeout: 5000 }, (t) => {
	const result = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", `
		import cp from 'node:child_process'; import fs from 'node:fs/promises';
		import { createNativeNotificationChannel } from ${JSON.stringify(new URL("../extension/notification-native.ts", import.meta.url).href)};
		fs.realpath = async p => p; fs.stat = async () => ({ isFile: () => true }); fs.access = async () => {};
		const originalSpawn = cp.spawn;
		cp.spawn = () => { const c = originalSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {stdio:'ignore'}); console.log(c.pid); return c; };
		const originalTimer = globalThis.setTimeout;
		globalThis.setTimeout = (...args) => { const timer = originalTimer(...args); const unref = timer.unref.bind(timer); timer.unref = () => { unref(); if (timer.hasRef()) throw new Error('referenced timer'); console.log('unref'); return timer; }; return timer; };
		const channel = createNativeNotificationChannel({ mode:'tui', projectDirectory:'/project', environment:{PATH:'/trusted', DISPLAY:':1', DBUS_SESSION_BUS_ADDRESS:'unix:path=/bus'} });
		const send = await channel.prepare({title:'T', body:''}, new AbortController().signal); void send();
	`], { timeout: 2500, encoding: "utf8" });
	const pid = Number(result.stdout.split("\n").find((line) => /^[0-9]+$/.test(line)));
	if (pid) t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
	assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.ok(pid > 0);
	assert.equal(result.stdout.split("\n").filter((line) => line === "unref").length, 2);
	assert.equal(NATIVE_ATTEMPT_TIMEOUT_MS, 5000);
});
