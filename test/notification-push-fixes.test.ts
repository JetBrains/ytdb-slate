import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ADDRCONFIG, getDefaultResultOrder, setDefaultResultOrder } from "node:dns";
import { Worker } from "node:worker_threads";
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import http from "node:http";
import { resolveNotificationSettings } from "../extension/notification-config.ts";
import { createPushNotificationChannel } from "../extension/notification-push.ts";
import { NotificationDispatcher } from "../extension/notification-dispatcher.ts";
import { canSpawnPushResolver, isPushLoopback, pushResolverRuntime, PUSH_DNS_WORKER_SCRIPT, PUSH_RESOLVER_SCRIPT, resolvePushAddresses, selectPushAddress, type PushResolverRuntime } from "../extension/notification-push-resolution.ts";

const plain: PushResolverRuntime = { releaseName: "node", bun: false, sea: false };
const fallback = { ...plain, bun: true };
function keepAlive(t: test.TestContext) {
	const timer = setInterval(() => {}, 1000);
	t.after(() => clearInterval(timer));
}

async function stalledServer(t: test.TestContext) {
	const server = createSocket("udp4");
	await new Promise<void>((done) => server.bind(0, "127.0.0.1", done));
	t.after(() => new Promise<void>((done) => server.close(done)));
	let packets = 0;
	const families = new Set<number>();
	server.on("message", (packet) => { packets++; families.add(packet.readUInt16BE(packet.length - 4)); });
	return { dnsServers: [`127.0.0.1:${server.address().port}`], get packets() { return packets; }, families };
}

test("runtime evidence routes Bun and SEA to query-free localhost fallback", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	assert.equal(canSpawnPushResolver(plain), true);
	assert.deepEqual(pushResolverRuntime(), plain);
	for (const runtime of [{ ...plain, bun: true }, { ...plain, sea: true },
		{ ...plain, bun: true, sea: true }, { ...plain, releaseName: "other" }]) {
		assert.equal(canSpawnPushResolver(runtime), false);
		for (const host of ["localhost", "a.localhost", "LOCALHOST."]) {
			const addresses = await resolvePushAddresses(host, new AbortController().signal, 100, {
				runtime, start: () => assert.fail("standalone runtime must not spawn pi"),
				startWorker: () => assert.fail("localhost must not query DNS"),
			});
			assert.ok(selectPushAddress(addresses, true));
		}
	}
});

test("plain Node bundle launchers and renamed executables use the child resolver", { timeout: 5000 }, async (t) => {
	keepAlive(t);
	const originalEntry = process.argv[1], originalExecutable = process.execPath;
	t.after(() => { process.argv[1] = originalEntry!; process.execPath = originalExecutable; });
	for (const entry of ["cli.js", "cli-runtime.js", "rpc-entry.js"]) {
		process.argv[1] = `/opt/pi/dist/bundle/${entry}`;
		assert.equal(canSpawnPushResolver(pushResolverRuntime()), true, `${entry} must use the Node CLI`);
		for (const executable of ["/usr/bin/nodejs", "C:\\Program Files\\nodejs\\node.exe", "/opt/renamed-runtime"]) {
			process.execPath = executable;
			assert.equal(canSpawnPushResolver(pushResolverRuntime()), true, `${executable} must use the Node CLI`);
			let spawned = false;
			const addresses = await resolvePushAddresses("localhost", new AbortController().signal, 1000, {
				start(exe, args, options) {
					assert.equal(exe, executable);
					spawned = true;
					return spawn(originalExecutable, args, options);
				},
				startWorker: () => assert.fail("plain Node must use system resolution"),
			});
			assert.equal(spawned, true);
			assert.ok(selectPushAddress(addresses, true));
		}
	}
});

test("worker fallback queries both families and terminates stalled UDP work on abort or deadline", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	const server = await stalledServer(t);
	for (const abort of [true, false]) {
		const controller = new AbortController(), start = performance.now(), before = server.packets;
		let worker!: Worker, exits = 0, terminations = 0;
		const pending = resolvePushAddresses("stalled.example", controller.signal, 300, { runtime: fallback, dnsServers: server.dnsServers,
			startWorker(script, options) {
				assert.equal(options.eval, true); assert.deepEqual(options.execArgv, []); assert.deepEqual(options.env, {});
				assert.equal(options.stdout, true); assert.equal(options.stderr, true);
				worker = new Worker(script, options);
				t.after(() => { void worker.terminate(); });
				worker.once("exit", () => { exits++; });
				const terminate = worker.terminate.bind(worker);
				worker.terminate = () => { terminations++; return terminate(); };
				return worker;
			} });
		await Promise.all(Array.from({ length: 4 }, () => readFile(new URL(import.meta.url))));
		for (let i = 0; i < 100 && server.packets < before + 2; i++) await delay(2);
		assert.ok(server.packets >= before + 2, "both worker queries must start before cancellation");
		if (abort) controller.abort();
		assert.equal(await pending, undefined);
		assert.equal(exits, 1); assert.equal(worker.threadId, -1); assert.equal(terminations, 1);
		assert.ok(performance.now() - start < 800);
		if (!abort) assert.ok(performance.now() - start >= 250);
	}
	assert.deepEqual([...server.families].sort((a, b) => a - b), [1, 28]);
	const aborted = new AbortController(); aborted.abort();
	assert.equal(await resolvePushAddresses("other.example", aborted.signal, 100, { runtime: fallback,
		startWorker: () => assert.fail("pre-aborted lookup must not start") }), undefined);
	assert.equal(await resolvePushAddresses("other.example", new AbortController().signal, 100, { runtime: fallback,
		startWorker: () => { throw new Error("private"); } }), undefined);
});

test("worker stdio options isolate Node and SEA without unsupported Bun options", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	for (const runtime of [fallback, { ...plain, sea: true }, { ...plain, releaseName: "other" }]) {
		let started = 0, workerOptions: import("node:worker_threads").WorkerOptions | undefined;
		const result = await resolvePushAddresses("example.test", new AbortController().signal, 1000, {
			runtime, workerScript: "require('node:worker_threads').parentPort.close()",
			startWorker(script, options) {
				started++; workerOptions = options;
				return new Worker(script, options);
			},
		});
		assert.equal(started, 1); assert.equal(result, undefined);
		assert.ok(workerOptions);
		for (const stream of ["stdout", "stderr"] as const) {
			assert.equal(Object.hasOwn(workerOptions, stream), !process.versions.bun);
			assert.equal(workerOptions[stream], process.versions.bun ? undefined : true);
		}
	}
});

test("fallback push writes nothing to host stdout or stderr on answers, failures or abort", { timeout: 8000 }, async (t) => {
	const moduleUrl = new URL("../extension/notification-push.ts", import.meta.url).href;
	const configUrl = new URL("../extension/notification-config.ts", import.meta.url).href;
	const source = `import assert from 'node:assert/strict';
		import { createPushNotificationChannel } from ${JSON.stringify(moduleUrl)};
		import { resolveNotificationSettings } from ${JSON.stringify(configUrl)};
		import { createSocket } from 'node:dgram'; import https from 'node:https';
		import { Worker } from 'node:worker_threads';
		import { PUSH_DNS_WORKER_SCRIPT } from ${JSON.stringify(new URL("../extension/notification-push-resolution.ts", import.meta.url).href)};
		const dns = createSocket('udp4');
		await new Promise(done => dns.bind(0, '127.0.0.1', done));
		let scenario, controller, queries = 0, requests = 0, workers = 0;
		dns.on('message', (query, sender) => {
			queries++;
			if (scenario === 'abort') { controller.abort(); return; }
			const family = query.readUInt16BE(query.length - 4);
			const answer = (scenario === 'answer' || scenario.endsWith('-answer')) && family === 1;
			const header = Buffer.from(query.subarray(0, 12));
			header.writeUInt16BE(answer ? 0x8180 : 0x8183, 2);
			header.writeUInt16BE(answer ? 1 : 0, 6);
			header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
			const record = Buffer.from('c00c000100010000000a00047f000001', 'hex');
			dns.send(Buffer.concat([header, query.subarray(12), ...(answer ? [record] : [])]), sender.port, sender.address);
		});
		https.request = () => { requests++; throw new Error('private connection failure'); };
		const settings = resolveNotificationSettings({push:{enabled:true,server:'https://example.test',topic:'t'}},undefined,()=>assert.fail('config warning'));
		try {
			for (const runtime of [${JSON.stringify(fallback)}, ${JSON.stringify({ ...plain, sea: true })}]) {
				for (scenario of ['answer', 'dns-failure', 'abort', 'setup-error', 'worker-error',
					'stdout-answer', 'stdout-failure', 'stderr-answer', 'stderr-failure', 'warning-answer', 'warning-failure']) {
					controller = new AbortController();
					const beforeQueries = queries, beforeRequests = requests, beforeWorkers = workers;
					const output = scenario.startsWith('stdout-') ? "process.stdout.write('private worker stdout');"
						: scenario.startsWith('stderr-') ? "process.stderr.write('private worker stderr');"
						: scenario.startsWith('warning-') ? "process.emitWarning('private worker warning'); process.emit('warning', new Error('private warning event'));" : '';
					const resolver = {runtime, dnsServers: scenario === 'setup-error' ? ['invalid server'] : ['127.0.0.1:' + dns.address().port],
						...(scenario === 'worker-error' ? {workerScript: "throw new Error('private worker failure')"}
							: output ? {workerScript: output + PUSH_DNS_WORKER_SCRIPT} : {}),
						startWorker(script, options) { workers++; return new Worker(script, options); }};
					await (await createPushNotificationChannel({mode:'tui',settings,resolver}).prepare({title:'T',body:'B'},controller.signal))();
					assert.equal(workers - beforeWorkers, 1, 'fallback worker must run');
					assert.equal(requests - beforeRequests, scenario === 'answer' || scenario.endsWith('-answer') ? 1 : 0);
					if (!['setup-error', 'worker-error'].includes(scenario)) assert.ok(queries > beforeQueries, 'real DNS must run');
				}
			}
		} finally { await new Promise(done => dns.close(done)); }`;
	const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", source], {
		env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
	let output = "", errors = "";
	child.stdout!.on("data", (chunk: Buffer) => { output += chunk; });
	child.stderr!.on("data", (chunk: Buffer) => { errors += chunk; });
	const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
	assert.equal(code, 0, errors);
	assert.equal(output, "", "fallback push must not write to host stdout");
	assert.equal(errors, "", "fallback push must not write to host stderr");
});

test("stalled fallback DNS does not keep an otherwise idle host alive", { timeout: 4000 }, async (t) => {
	const server = await stalledServer(t);
	const moduleUrl = new URL("../extension/notification-push.ts", import.meta.url).href;
	const configUrl = new URL("../extension/notification-config.ts", import.meta.url).href;
	const source = `import { createPushNotificationChannel } from ${JSON.stringify(moduleUrl)};
		import { resolveNotificationSettings } from ${JSON.stringify(configUrl)};
		const keep = setInterval(() => {}, 1000);
		process.stdin.once('data', () => { process.stdin.destroy(); clearInterval(keep); });
		const settings = resolveNotificationSettings({push:{enabled:true,server:'https://stalled.example',topic:'t'}},undefined,()=>{});
		void (await createPushNotificationChannel({mode:'tui',settings,resolver:{runtime:${JSON.stringify(fallback)},dnsServers:${JSON.stringify(server.dnsServers)}}}).prepare({title:'T',body:'B'},new AbortController().signal))();`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
	t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
	let errors = "";
	child.stderr.on("data", (chunk: Buffer) => { errors += chunk; });
	const exited = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
	for (let i = 0; i < 200 && server.packets < 2; i++) await delay(5);
	assert.ok(server.packets >= 2, "natural exit must exercise active A and AAAA queries");
	const start = performance.now();
	child.stdin.end("release");
	const code = await Promise.race([exited, delay(1000).then(() => { throw new Error("stalled fallback must not hold host exit"); })]);
	assert.equal(code, 0, errors); assert.ok(performance.now() - start < 1000);
});

test("worker fallback validates results and waits for exit after an answer", { timeout: 4000 }, async (t) => {
	keepAlive(t);
	for (const workerScript of ["throw new Error('private')", "require('node:worker_threads').parentPort.close()",
		"require('node:worker_threads').parentPort.postMessage({address:'127.0.0.1',family:4})",
		"require('node:worker_threads').parentPort.postMessage([{address:'::1%lo',family:6}])",
		"require('node:worker_threads').parentPort.postMessage(Array(1025).fill({address:'127.0.0.1',family:4}))"]) {
		assert.equal(await resolvePushAddresses("example.test", new AbortController().signal, 500, { runtime: fallback, workerScript }), undefined);
	}
	let settled = false, worker!: Worker;
	const workerScript = `const { parentPort } = require('node:worker_threads');
		parentPort.postMessage([{address:'127.0.0.1',family:4}]);
		setTimeout(() => parentPort.close(), 200);`;
	const pending = resolvePushAddresses("example.test", new AbortController().signal, 1000, { runtime: fallback, workerScript,
		startWorker(script, options) { worker = new Worker(script, options); return worker; },
	}).then((result) => { settled = true; return result; });
	await new Promise<void>((done) => worker.once("message", () => done()));
	assert.equal(settled, false, "a DNS answer must not release a live worker's slot");
	assert.deepEqual(await pending, [{ address: "127.0.0.1", family: 4 }]);
	assert.equal(worker.threadId, -1);
	const controller = new AbortController();
	assert.equal(await resolvePushAddresses("example.test", controller.signal, 500, { runtime: fallback,
		startWorker(script, options) { const during = new Worker(script, options); controller.abort(); return during; },
	}), undefined);
	assert.match(PUSH_DNS_WORKER_SCRIPT, /tries: 1/);
});

test("child preserves parent address order and Node connect hints, and fallback uses the same order", { timeout: 5000 }, async (t) => {
	keepAlive(t);
	const original = getDefaultResultOrder();
	t.after(() => setDefaultResultOrder(original));
	const probe = http.createServer();
	const ipv6 = await new Promise<boolean>((done, reject) => {
		probe.once("error", (error: NodeJS.ErrnoException) => {
			if (["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT"].includes(error.code ?? "")) done(false);
			else reject(error);
		});
		probe.listen(0, "::1", () => probe.close(() => done(true)));
	});
	for (const [order, family] of [["ipv4first", 4], ["ipv6first", 6]] as const) {
		if (family === 6 && !ipv6) {
			await t.test("IPv6 address-order connection", { skip: "IPv6 loopback ::1 is unavailable" }, () => {});
			continue;
		}
		setDefaultResultOrder(order);
		const child = await resolvePushAddresses("localhost", new AbortController().signal, 1000, { runtime: plain });
		assert.equal(selectPushAddress(child, true)?.family, family);
		const addresses = await resolvePushAddresses("localhost", new AbortController().signal, 100, { runtime: fallback });
		assert.equal(selectPushAddress(addresses, true)?.family, family);
		const script = `const dns=require('node:dns'); dns.lookup=(host,options,cb)=>{console.log(JSON.stringify(options)); process.exit(0);}; ${PUSH_RESOLVER_SCRIPT}`;
		const lookupOptions = await resolvePushAddresses("example.test", new AbortController().signal, 1000, {
			runtime: plain, script: script.replace("const dns = require('node:dns');", ""),
		});
		assert.deepEqual(lookupOptions, { all: true, order, hints: process.platform === "win32" ? 0 : ADDRCONFIG });
		// Exercise a real connection without alternate-address fallback.
		const server = http.createServer((_request, response) => { requests++; response.end(); });
		let requests = 0;
		await new Promise<void>((done) => server.listen(0, family === 4 ? "127.0.0.1" : "::1", done));
		try {
			const port = (server.address() as { port: number }).port;
			const settings = resolveNotificationSettings({ push: { enabled: true, server: `http://localhost:${port}`, topic: "t" } }, undefined, () => {});
			await (await createPushNotificationChannel({ mode: "tui", settings, resolver: { runtime: plain } }).prepare({ title: "T", body: "B" }, new AbortController().signal))();
			assert.equal(requests, 1);
		} finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
	}
});

test("fallback orders real A and AAAA answers and tolerates a failed family", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	const original = getDefaultResultOrder();
	t.after(() => setDefaultResultOrder(original));
	const server = createSocket("udp4");
	await new Promise<void>((done) => server.bind(0, "127.0.0.1", done));
	t.after(() => new Promise<void>((done) => server.close(done)));
	let failV6 = false;
	server.on("message", (query, sender) => {
		let end = 12;
		while (query[end] !== 0) end += query[end]! + 1;
		end += 5;
		const family = query.readUInt16BE(end - 4);
		const header = Buffer.from(query.subarray(0, 12));
		header.writeUInt16BE(failV6 && family === 28 ? 0x8183 : 0x8180, 2);
		header.writeUInt16BE(failV6 && family === 28 ? 0 : 1, 6);
		header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
		const data = family === 1 ? Buffer.from([127, 0, 0, 2]) : Buffer.from("00000000000000000000000000000001", "hex");
		const answer = Buffer.alloc(12);
		answer.writeUInt16BE(0xc00c, 0); answer.writeUInt16BE(family, 2); answer.writeUInt16BE(1, 4);
		answer.writeUInt32BE(10, 6); answer.writeUInt16BE(data.length, 10);
		server.send(Buffer.concat([header, query.subarray(12, end), ...(failV6 && family === 28 ? [] : [answer, data])]), sender.port, sender.address);
	});
	const dnsServers = [`127.0.0.1:${server.address().port}`];
	for (const [order, family] of [["ipv4first", 4], ["ipv6first", 6], ["verbatim", 4]] as const) {
		setDefaultResultOrder(order);
		const result = await resolvePushAddresses("loopback.example", new AbortController().signal, 500, { runtime: fallback, dnsServers });
		assert.equal(selectPushAddress(result, true)?.family, family);
		assert.equal((result as unknown[]).length, 2);
	}
	failV6 = true;
	assert.deepEqual(await resolvePushAddresses("loopback.example", new AbortController().signal, 500, { runtime: fallback, dnsServers }), [{ address: "127.0.0.2", family: 4 }]);
});

test("child self-SIGKILL ends a real blocked filesystem worker without parent termination", { timeout: 3000 }, async (t) => {
	if (process.platform !== "linux") { t.skip("FIFO worker stall requires Linux and mkfifo"); return; }
	const dir = mkdtempSync(join(tmpdir(), "slate-push-fifo-")), fifo = join(dir, "blocked");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
	const script = PUSH_RESOLVER_SCRIPT.replace("dns.lookup", `((host, options, callback) => { require('node:fs').open(${JSON.stringify(fifo)}, 'r', () => {}); process.stdout.write('blocked'); })`);
	const child = spawn(process.execPath, ["--input-type=commonjs", "-e", script, "--", "localhost", "300", "verbatim"]);
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => { output += chunk; });
	const start = performance.now();
	const signal = await Promise.race([
		new Promise<NodeJS.Signals | null>((done, reject) => { child.once("error", reject); child.once("close", (_code, signal) => done(signal)); }),
		delay(1500).then(() => { throw new Error("self-deadline must not join a blocked worker"); }),
	]);
	assert.equal(output, "blocked"); assert.equal(signal, "SIGKILL");
	assert.ok(performance.now() - start < 1500);
});

test("scoped IPv6 answers are rejected without throwing or rejecting delivery", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	let calls = 0;
	t.mock.method(http, "request", () => { calls++; throw new Error("end request"); });
	for (const address of ["::1%lo", "fe80::1%lo0"]) {
		assert.equal(isPushLoopback(address), false);
		assert.equal(selectPushAddress([{ address, family: 6 }], false), undefined);
		const settings = resolveNotificationSettings({ push: { enabled: true, server: "http://localhost", topic: "t" } }, undefined, () => {});
		const resolver = { runtime: plain, script: `console.log(${JSON.stringify(JSON.stringify([{ address, family: 6 }]))})` };
		await (await createPushNotificationChannel({ mode: "tui", settings, resolver }).prepare({ title: "T", body: "B" }, new AbortController().signal))();
	}
	assert.equal(calls, 0);
	assert.equal(isPushLoopback("[::1]"), false);
	const hostile = [{ get address() { throw new Error("private"); }, family: 6 }];
	// A bad test resolver result must stay inside the connection failure boundary.
	const settings = resolveNotificationSettings({ push: { enabled: true, server: "http://localhost", topic: "t" } }, undefined, () => {});
	t.mock.method(JSON, "parse", () => hostile);
	await (await createPushNotificationChannel({ mode: "tui", settings, resolver: { runtime: plain, script: "console.log('[]')" } }).prepare({ title: "T", body: "B" }, new AbortController().signal))();
	assert.equal(calls, 0);
});

test("failed kill is idempotent and cannot settle before child close", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	for (const behavior of ["error", "false", "throw"] as const) {
		let kills = 0, settled = false;
		const stdout = Object.assign(new PassThrough(), { unref() {} });
		const child = Object.assign(new EventEmitter(), { stdout, unref() {}, kill() {
			kills++;
			if (behavior === "throw") throw new Error("private");
			if (behavior === "error") child.emit("error", new Error("EPERM"));
			return false;
		} });
		const controller = new AbortController();
		const pending = resolvePushAddresses("localhost", controller.signal, 1000, { runtime: plain, start: () => child as unknown as ChildProcess }).then((result) => { settled = true; return result; });
		controller.abort();
		await delay(180);
		assert.equal(kills, 1); assert.equal(settled, false); assert.equal(stdout.destroyed, false);
		stdout.destroy(); child.emit("close", null);
		assert.equal(await pending, undefined); assert.equal(settled, true); assert.equal(kills, 1);
	}
});

test("refused parent kill holds the shared push slot until the real child self-deadline closes it", { timeout: 4000 }, async (t) => {
	keepAlive(t);
	const slots = (globalThis as unknown as Record<symbol, Map<string, unknown>>)[Symbol.for("ytdb-slate.notification-channel-slots.v1")]!;
	const settings = resolveNotificationSettings({ minimumDelayMs: 0, cooldownMs: 0, push: { enabled: true, server: "http://localhost", topic: "t" } }, undefined, () => {});
	const children: ChildProcess[] = [], callbacks = new Set<() => void>();
	let kills = 0;
	const resolver = { runtime: plain, script: PUSH_RESOLVER_SCRIPT.replace("Number(process.argv[2])", "700").replace("dns.lookup", "((host, options, callback) => { setInterval(() => {}, 1000); })"),
		start(exe: string, args: string[], options: import("node:child_process").SpawnOptions) {
			const child = spawn(exe, args, options), kill = child.kill.bind(child);
			children.push(child); t.after(() => { kill("SIGKILL"); });
			child.kill = () => { kills++; child.emit("error", new Error("EPERM")); return false; };
			return child;
		} };
	const make = () => new NotificationDispatcher({ mode: "tui", cwd: "/tmp", settings,
		channels: [createPushNotificationChannel({ mode: "tui", settings, resolver })],
		current: () => true, idle: () => true, queued: () => false, recovering: () => false,
		warn: () => assert.fail("delivery warning"), schedule: (_ms, cb) => { callbacks.add(cb); return () => { callbacks.delete(cb); }; } });
	const first = make(), next = make();
	t.after(() => { first.retire(); next.retire(); });
	const admit = async (d: NotificationDispatcher) => {
		d.runStart(); d.message({ role: "assistant", stopReason: "stop", content: "" }); d.settled();
		for (let i = 0; i < 8; i++) {
			for (const cb of [...callbacks]) { callbacks.delete(cb); cb(); }
			await Promise.resolve();
		}
	};
	await admit(first); assert.equal(children.length, 1);
	first.retire(); await delay(180);
	assert.equal(kills, 1); assert.ok(slots.has("push"));
	assert.equal(children[0]!.exitCode, null); assert.equal(children[0]!.signalCode, null);
	await admit(next); assert.equal(children.length, 1, "a live resolver must exclude another push attempt");
	for (let i = 0; i < 200 && slots.has("push"); i++) await delay(5);
	assert.equal(slots.has("push"), false); assert.equal(children[0]!.signalCode, "SIGKILL");
	await admit(next); assert.equal(children.length, 2, "child close must release the slot");
	next.retire();
	for (let i = 0; i < 200 && slots.has("push"); i++) await delay(5);
	assert.equal(slots.has("push"), false);
});
