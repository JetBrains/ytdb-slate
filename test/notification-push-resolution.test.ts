import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import http from "node:http";
import net, { type Socket } from "node:net";
import type { LookupOptions } from "node:dns";
import { resolveNotificationSettings } from "../extension/notification-config.ts";
import { NotificationDispatcher } from "../extension/notification-dispatcher.ts";
import { createPushNotificationChannel, PUSH_ATTEMPT_TIMEOUT_MS } from "../extension/notification-push.ts";
import { isPushLoopback, pinnedPushLookup, PUSH_RESOLVER_SCRIPT, resolvePushAddresses, selectPushAddress, type PushResolverOptions } from "../extension/notification-push-resolution.ts";

const text = { title: "T", body: "B" };
const slots = () => (globalThis as unknown as Record<symbol, Map<string, unknown>>)[Symbol.for("ytdb-slate.notification-channel-slots.v1")]!;
function keepAlive(t: test.TestContext) {
	const timer = setInterval(() => {}, 1000);
	t.after(() => clearInterval(timer));
}
async function until(condition: () => boolean) {
	for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
	assert.ok(condition(), "condition must become true within one second");
}
function settings(server = "http://localhost") {
	return resolveNotificationSettings({ minimumDelayMs: 0, cooldownMs: 0, push: { enabled: true, server, topic: "topic", token: "private" } }, undefined, () => {});
}
function resolver(t: test.TestContext, script: string) {
	const children: ChildProcess[] = [];
	const options: PushResolverOptions = { script, start(executable, args, options) {
		const child = spawn(executable, args, options);
		children.push(child);
		return child;
	} };
	t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	return { options, children };
}
function gone(child: ChildProcess) {
	assert.ok(child.pid);
	assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" }, "resolver child must be gone before settlement");
}
async function send(options: PushResolverOptions, signal = new AbortController().signal, server = "http://localhost") {
	return (await createPushNotificationChannel({ mode: "tui", settings: settings(server), resolver: options }).prepare(text, signal))();
}

const stall = "setInterval(() => {}, 1000)";
test("stalled resolution ends at the attempt bound and on abort with no child left", { timeout: 8000 }, async (t) => {
	keepAlive(t);
	let requests = 0;
	t.mock.method(http, "request", () => { requests++; throw new Error("unexpected connection"); });
	for (const abort of [false, true]) {
		const f = resolver(t, stall), controller = new AbortController();
		const started = performance.now();
		const pending = send(f.options, controller.signal);
		await until(() => f.children.length === 1);
		assert.equal(f.children[0]!.exitCode, null);
		if (abort) controller.abort();
		await pending;
		gone(f.children[0]!);
		const elapsed = performance.now() - started;
		assert.ok(elapsed < (abort ? 1000 : PUSH_ATTEMPT_TIMEOUT_MS + 1000));
		if (!abort) assert.ok(elapsed >= PUSH_ATTEMPT_TIMEOUT_MS - 100, "the full attempt bound must be exercised");
	}
	assert.equal(requests, 0);
});

test("stalled child worker pool leaves four host filesystem operations and events prompt", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	const f = resolver(t, `const { pbkdf2 } = require('node:crypto');
		for (let i=0;i<4;i++) pbkdf2('p','s',1e9,32,'sha256',()=>{});
		console.log('ready'); ${stall}`);
	const controller = new AbortController();
	const pending = send(f.options, controller.signal);
	t.after(() => controller.abort());
	await until(() => f.children.length === 1);
	let ready = false;
	f.children[0]!.stdout!.on("data", () => { ready = true; });
	await until(() => ready);
	assert.equal(f.children[0]!.exitCode, null);
	const started = performance.now();
	let event = false;
	setImmediate(() => { event = true; });
	await Promise.race([
		Promise.all(Array.from({ length: 4 }, () => readFile(new URL(import.meta.url)))),
		delay(500).then(() => { throw new Error("host worker pool was held by resolution"); }),
	]);
	await delay(5);
	assert.equal(event, true);
	assert.ok(performance.now() - started < 500);
	controller.abort(); await pending; gone(f.children[0]!);
});

test("resolution and request share one deadline and one global slot through child close", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	const f = resolver(t, stall), policy = settings();
	const callbacks = new Set<() => void>();
	let requests = 0;
	t.mock.method(http, "request", () => { requests++; throw new Error("unexpected request"); });
	const make = () => new NotificationDispatcher({ mode: "tui", cwd: "/tmp", settings: policy,
		channels: [createPushNotificationChannel({ mode: "tui", settings: policy, resolver: f.options })],
		current: () => true, idle: () => true, queued: () => false, recovering: () => false,
		warn: () => assert.fail("delivery must stay silent"),
		schedule: (_ms, callback) => { callbacks.add(callback); return () => { callbacks.delete(callback); }; } });
	const first = make(), next = make();
	t.after(() => { first.retire(); next.retire(); });
	const admit = async (d: NotificationDispatcher) => {
		d.runStart(); d.message({ role: "assistant", stopReason: "stop", content: "" }); d.settled();
		for (let i = 0; i < 6; i++) {
			for (const cb of [...callbacks]) { callbacks.delete(cb); cb(); }
			await Promise.resolve();
		}
	};
	await admit(first); await until(() => f.children.length === 1);
	assert.ok(slots().has("push"));
	await admit(next); assert.equal(f.children.length, 1);
	first.retire();
	for (let i = 0; i < 6; i++) await Promise.resolve();
	assert.ok(slots().has("push"), "abort must not release before child close");
	await until(() => !slots().has("push")); gone(f.children[0]!);
	assert.equal(requests, 0);
	await admit(next); await until(() => f.children.length === 2);
	next.retire(); await until(() => !slots().has("push")); gone(f.children[1]!);
});

test("resolution time is not refunded when the request starts", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	let requests = 0;
	const server = http.createServer((request) => { requests++; request.resume(); });
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const f = resolver(t, `setTimeout(()=>console.log('[{"address":"127.0.0.1","family":4}]'),200)`);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let settled = false;
	const pending = send(f.options, new AbortController().signal, `http://localhost:${address.port}`).then(() => { settled = true; });
	await until(() => f.children.length === 1);
	t.mock.timers.tick(4000);
	await until(() => requests === 1);
	assert.equal(settled, false);
	t.mock.timers.tick(999); await delay(10); assert.equal(settled, false);
	t.mock.timers.tick(1); await pending;
	assert.equal(settled, true); gone(f.children[0]!);
});

test("resolution and a stalled request share the five-second wall-clock bound", { timeout: 8000 }, async (t) => {
	keepAlive(t);
	let requests = 0;
	const server = http.createServer((request) => { requests++; request.resume(); });
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const f = resolver(t, `setTimeout(()=>console.log('[{"address":"127.0.0.1","family":4}]'),1400)`);
	const started = performance.now();
	let settled = false;
	const pending = send(f.options, new AbortController().signal, `http://localhost:${address.port}`).then(() => { settled = true; });
	await delay(1500); await until(() => requests === 1);
	assert.equal(settled, false, "the request must stall after resolution succeeds");
	await pending;
	const elapsed = performance.now() - started;
	assert.ok(elapsed >= PUSH_ATTEMPT_TIMEOUT_MS - 100);
	assert.ok(elapsed < PUSH_ATTEMPT_TIMEOUT_MS + 600, "resolution must not restart the request allowance");
	assert.equal(requests, 1); gone(f.children[0]!);
});

test("system resolution keeps hosts-file entries and gives the child only a minimal environment", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	const controller = new AbortController();
	const f = resolver(t, PUSH_RESOLVER_SCRIPT);
	let checked = false;
	const start = f.options.start!;
	const options: PushResolverOptions = { start(executable, args, options) {
		assert.equal(executable, process.execPath);
		assert.equal(args.at(-3), "localhost");
		assert.ok(["ipv4first", "ipv6first", "verbatim"].includes(args.at(-1)!));
		assert.equal(options.shell, undefined);
		assert.deepEqual(Object.keys(options.env!).filter((key) => key !== "SystemRoot"), []);
		assert.equal(options.stdio?.[0], "ignore");
		checked = true;
		return start(executable, args, options);
	} };
	const addresses = await resolvePushAddresses("localhost", controller.signal, 1000, options);
	assert.ok(selectPushAddress(addresses, true));
	assert.equal(checked, true); gone(f.children[0]!);
	if (process.platform === "linux") assert.match(readFileSync("/etc/hosts", "utf8"), /localhost/);
	const oldRoot = process.env.SystemRoot;
	process.env.SystemRoot = "resolution-test-root";
	t.after(() => { if (oldRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = oldRoot; });
	const literalArgument = resolver(t, `console.log(JSON.stringify(process.argv[1]))`);
	assert.equal(await resolvePushAddresses("--inspect", controller.signal, 1000, {
		script: literalArgument.options.script,
		start(exe, args, options) {
			assert.deepEqual(options.env, { SystemRoot: "resolution-test-root" });
			return literalArgument.options.start!(exe, args, options);
		},
	}), "--inspect", "host names must not become Node command options");
	gone(literalArgument.children[0]!);
});

test("HTTP rejects remote answers and selects only validated loopback forms", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	const calls: http.RequestOptions[] = [];
	t.mock.method(http, "request", (_url: URL, options: http.RequestOptions) => { calls.push(options); throw new Error("stop at connection"); });
	await send(resolver(t, `console.log('[{"address":"192.0.2.1","family":4}]')`).options);
	assert.equal(calls.length, 0, "remote HTTP answer must never reach request");
	for (const address of ["127.0.0.1", "127.200.1.2", "::1", "::ffff:127.1.2.3", "::ffff:7fff:ffff"]) {
		const family = address.includes(":") ? 6 : 4;
		await send(resolver(t, `console.log(${JSON.stringify(JSON.stringify([{ address: "192.0.2.1", family: 4 }, { address, family }]))})`).options);
		assert.equal(calls.at(-1)!.family, family);
		assert.equal((calls.at(-1)! as http.RequestOptions & { autoSelectFamily: boolean }).autoSelectFamily, false);
		assert.equal(isPushLoopback(address), true);
	}
	assert.equal(calls.length, 5);
	for (const address of ["192.0.2.1", "128.0.0.1", "::", "::2", "::ffff:128.0.0.1", "not-an-ip"]) assert.equal(isPushLoopback(address), false);
	assert.equal(selectPushAddress([null, 1, {}, { address: "127.0.0.1", family: 6 }, { address: "bad", family: 4 }], true), undefined);
	assert.equal(selectPushAddress({}, true), undefined);
	assert.deepEqual(selectPushAddress([{ address: "192.0.2.1", family: 4 }], false), { address: "192.0.2.1", family: 4 });
});

test("pinned lookup handles both callback shapes with exactly one candidate", () => {
	const address = { address: "127.0.0.1", family: 4 };
	const lookup = pinnedPushLookup(address);
	for (const options of [{ all: true }, { all: false }, 4]) {
		let calls = 0;
		lookup("original.example", options as unknown as LookupOptions, (...args: unknown[]) => {
			calls++;
			assert.deepEqual(args, typeof options === "object" && options.all ? [null, [address]] : [null, address.address, 4]);
		});
		assert.equal(calls, 1);
	}
});

test("one resolution and one connection keep the original Host and IP literals skip resolution", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	const connections: Socket[] = [], hosts: string[] = [];
	const server = http.createServer((request, response) => { hosts.push(request.headers.host!); request.resume(); response.end(); });
	server.on("connection", (socket) => connections.push(socket));
	await new Promise<void>((done) => server.listen(0, "127.0.0.2", done));
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const f = resolver(t, `console.log('[{"address":"127.0.0.2","family":4},{"address":"127.0.0.1","family":4}]')`);
	const channel = createPushNotificationChannel({ mode: "tui", settings: settings(`http://localhost:${address.port}`), resolver: f.options });
	const prepared = await channel.prepare(text, new AbortController().signal);
	assert.equal(f.children.length, 0, "prepare must not resolve");
	await prepared();
	assert.equal(f.children.length, 1); assert.equal(connections.length, 1);
	assert.deepEqual(hosts, [`localhost:${address.port}`]); gone(f.children[0]!);
	await send(f.options, new AbortController().signal, `http://127.0.0.2:${address.port}`);
	assert.equal(f.children.length, 1); assert.equal(connections.length, 2);
});

test("resolution failures remain silent and abort before resolution starts spawns nothing", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	let calls = 0;
	t.mock.method(http, "request", () => { calls++; throw new Error("must not connect"); });
	for (const script of ["console.log('bad json')", "process.exit(1)", "process.stdout.write('x'.repeat(70000)); setInterval(()=>{},1000)"]) {
		const f = resolver(t, script); assert.equal(await send(f.options), undefined); gone(f.children[0]!);
	}
	assert.equal(await send({ start: () => { throw new Error("private"); } }), undefined);
	assert.equal(await send({ start: (_exe, _args, options) => spawn("/does-not-exist/slate", [], options) }), undefined);
	const during = new AbortController(), interrupted = resolver(t, stall);
	assert.equal(await resolvePushAddresses("localhost", during.signal, 1000, {
		script: stall, start(exe, args, options) {
			const child = interrupted.options.start!(exe, args, options);
			during.abort(); return child;
		},
	}), undefined);
	gone(interrupted.children[0]!);
	let ignored!: ChildProcess;
	assert.equal(await resolvePushAddresses("localhost", new AbortController().signal, 1000, {
		script: "process.exit(0)", start(exe, args, options) {
			ignored = spawn(exe, args, { ...options, stdio: "ignore" }); return ignored;
		},
	}), undefined);
	gone(ignored);
	const pipeError = resolver(t, stall);
	assert.equal(await resolvePushAddresses("localhost", new AbortController().signal, 1000, {
		script: stall, start(exe, args, options) {
			const child = pipeError.options.start!(exe, args, options);
			setImmediate(() => child.stdout!.emit("error", new Error("private pipe failure")));
			return child;
		},
	}), undefined);
	gone(pipeError.children[0]!);
	const controller = new AbortController(); controller.abort();
	const f = resolver(t, stall);
	assert.equal(await resolvePushAddresses("localhost", controller.signal, 1000, f.options), undefined);
	assert.equal(f.children.length, 0); assert.equal(calls, 0);
});

test("pending localhost and stalled resolution do not delay host exit and orphan child self-ends", { timeout: 9000 }, async (t) => {
	keepAlive(t);
	const dir = mkdtempSync(join(tmpdir(), "slate-push-exit-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const moduleUrl = new URL("../extension/notification-push.ts", import.meta.url).href;
	const configUrl = new URL("../extension/notification-config.ts", import.meta.url).href;
	const connections: Socket[] = [];
	let handshakes = 0;
	const server = net.createServer((socket) => {
		connections.push(socket);
		socket.on("data", () => { handshakes++; });
		socket.on("error", () => {});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise<void>((done) => server.close(() => done())); });
	const address = server.address(); assert.ok(address && typeof address !== "string");
	for (const stalled of [true, false]) {
		const pidFile = join(dir, stalled ? "stalled-pid" : "pending-pid");
		const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
			${PUSH_RESOLVER_SCRIPT.replace("dns.lookup", "((host, options, callback) => { setInterval(()=>{},1000); })")}`;
		const source = `import { createPushNotificationChannel } from ${JSON.stringify(moduleUrl)};
			import { resolveNotificationSettings } from ${JSON.stringify(configUrl)};
			import transport from 'node:https'; import { existsSync } from 'node:fs';
			import assert from 'node:assert/strict'; import dns from 'node:dns';
			// Force the failed IPv6-first path that replaces a socket handle.
			dns.lookup=(host,options,callback)=>{assert.equal(host,'localhost'); callback(null,[{address:'::1',family:6},{address:'127.0.0.1',family:4}]);};
			const keep = setInterval(()=>{},10);
			${stalled ? `const poll=setInterval(()=>{if(existsSync(${JSON.stringify(pidFile)})){console.log('resolving'); clearInterval(poll); clearInterval(keep);}},10);` : `const original=transport.request; transport.request=(...args)=>{const req=original(...args); req.once('socket',socket=>socket.once('connect',()=>setImmediate(()=>{assert.equal(req.writableFinished,false);console.log('pending');clearInterval(keep);})));return req;};`}
			const settings=resolveNotificationSettings({push:{enabled:true,server:'https://localhost:${address.port}',topic:'topic'}},undefined,()=>{});
			void (await createPushNotificationChannel({mode:'tui',settings,${stalled ? `resolver:{script:${JSON.stringify(script)}}` : `resolver:{script:"console.log('[{\\\"address\\\":\\\"127.0.0.1\\\",\\\"family\\\":4},{\\\"address\\\":\\\"::1\\\",\\\"family\\\":6}]')"}`}}).prepare({title:'T',body:'B'},new AbortController().signal))();`;
		const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
		t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
		let output = "", errors = "";
		child.stdout!.on("data", (chunk: Buffer) => { output += chunk; }); child.stderr!.on("data", (chunk: Buffer) => { errors += chunk; });
		const started = performance.now();
		const exited = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
		const code = await Promise.race([exited, delay(2000).then(() => { throw new Error("pending push must not keep the host alive"); })]);
		assert.equal(code, 0, errors); assert.match(output, stalled ? /resolving/ : /pending/);
		assert.ok(performance.now() - started < 2000, "pending push must not keep the host alive");
		if (stalled) {
			assert.ok(existsSync(pidFile));
			const pid = Number(readFileSync(pidFile, "utf8"));
			t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
			await delay(PUSH_ATTEMPT_TIMEOUT_MS + 200);
			// An orphan can briefly remain a zombie until the operating system reaps it.
			if (process.platform === "linux" && existsSync(`/proc/${pid}/stat`)) assert.match(readFileSync(`/proc/${pid}/stat`, "utf8"), /^\d+ \(.+\) Z /);
			else assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		}
	}
	assert.equal(connections.length, 1, "localhost must use one connection, not address racing");
	assert.ok(handshakes > 0, "pending push must start a handshake the server never completes");
});
