import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { getDefaultResultOrder, setDefaultResultOrder } from "node:dns";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { resolveNotificationSettings } from "../extension/notification-config.ts";
import { createPushNotificationChannel } from "../extension/notification-push.ts";
import { canSpawnPushResolver, pushResolverRuntime, PUSH_RESOLVER_SCRIPT, selectPushAddress } from "../extension/notification-push-resolution.ts";

const pushCase = "portable push sends exactly one ntfy request through the real localhost lookup child";
const deadlineCase = "lookup child self-deadline closes a stalled lookup and leaves no process";
const completedCases = new Set<string>();
after(() => {
	for (const name of [pushCase, deadlineCase]) {
		assert.ok(completedCases.has(name), `${name} must complete without skip or todo`);
	}
});

function requiredCase(name: string, options: test.TestOptions, run: (t: test.TestContext) => Promise<void>) {
	assert.ok(!options.skip && !options.todo, `${name} must not use skip or todo options`);
	test(name, options, async (t) => {
		t.skip = () => { assert.fail(`${name} must not call t.skip()`); };
		t.todo = () => { assert.fail(`${name} must not call t.todo()`); };
		await run(t);
		completedCases.add(name);
	});
}

function assertGone(child: ChildProcess) {
	assert.ok(child.pid, "the resolver must have started");
	assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" }, "the resolver must be gone after close");
}

function guardChild(t: test.TestContext, child: ChildProcess) {
	const kill = () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	};
	const timer = setTimeout(kill, 6000);
	timer.unref();
	child.once("close", () => clearTimeout(timer));
	t.after(() => { clearTimeout(timer); kill(); });
}

requiredCase(pushCase, { timeout: 12000 }, async (t) => {
	assert.equal(canSpawnPushResolver(pushResolverRuntime()), true, "this check requires a plain Node CLI");
	if (process.platform === "win32") assert.ok(process.env.SystemRoot ?? process.env.SYSTEMROOT, "Windows requires SystemRoot");
	// The real child receives this order. IPv4 loopback avoids an unavailable IPv6 listener.
	const originalOrder = getDefaultResultOrder();
	setDefaultResultOrder("ipv4first");
	t.after(() => setDefaultResultOrder(originalOrder));
	const requests: { method?: string; path?: string; headers: http.IncomingHttpHeaders; body: string; ended: boolean }[] = [];
	const server = http.createServer((request, response) => {
		const record = { method: request.method, path: request.url, headers: request.headers, body: "", ended: false };
		requests.push(record);
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => { record.body += chunk; });
		request.on("end", () => { record.ended = true; response.end("accepted"); });
	});
	t.after(async () => {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((done) => server.close(() => done()));
	});
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); done(); });
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const settings = resolveNotificationSettings({ push: {
		enabled: true, server: `http://localhost:${address.port}`, topic: "slate-portable-check",
	} }, undefined, (message) => assert.fail(message));
	const starts: { executable: string; args: string[]; options: SpawnOptions }[] = [];
	const children: ChildProcess[] = [];
	let workerStarts = 0, childOutput = "", closes = 0;
	const controller = new AbortController();
	t.after(() => controller.abort());
	const channel = createPushNotificationChannel({ mode: "tui", settings, resolver: {
		start(executable, args, options) {
			// Node coverage can mutate the environment passed to spawn. Observe it first.
			starts.push({ executable, args: [...args], options: { ...options, env: { ...options.env } } });
			const child = spawn(executable, args, options);
			children.push(child);
			guardChild(t, child);
			child.stdout!.on("data", (chunk: Buffer) => { childOutput += chunk.toString("utf8"); });
			child.once("close", () => { closes++; });
			return child;
		},
		startWorker() { workerStarts++; throw new Error("the worker fallback must not run"); },
	} });
	const text = { title: "Input needed", body: "Portable push check — ready" };
	const send = await channel.prepare(text, controller.signal);
	assert.equal(starts.length, 0, "preparation must not resolve a host");
	await send();
	assert.equal(starts.length, 1, "delivery must spawn exactly one real resolver");
	assert.equal(workerStarts, 0);
	assert.equal(closes, 1, "delivery must wait for resolver close");
	assert.equal(children[0]!.exitCode, 0);
	assertGone(children[0]!);
	const started = starts[0]!;
	assert.equal(started.executable, process.execPath);
	assert.deepEqual(started.args, ["--input-type=commonjs", "-e", PUSH_RESOLVER_SCRIPT, "--", "localhost", "5000", "ipv4first"]);
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	assert.deepEqual(started.options.env, systemRoot === undefined ? {} : { SystemRoot: systemRoot });
	assert.equal(started.options.shell, undefined);
	assert.equal(started.options.windowsHide, true);
	assert.deepEqual(started.options.stdio, ["ignore", "pipe", "ignore"]);
	assert.deepEqual(selectPushAddress(JSON.parse(childOutput), true), { address: "127.0.0.1", family: 4 });
	assert.equal(requests.length, 1);
	const received = requests[0]!;
	assert.equal(received.ended, true);
	assert.equal(received.method, "POST");
	assert.equal(received.path, "/");
	assert.equal(received.headers.host, `localhost:${address.port}`);
	assert.equal(received.headers.connection, "close");
	assert.equal(received.headers["content-type"], "application/json");
	assert.equal(received.headers["content-length"], String(Buffer.byteLength(received.body)));
	assert.deepEqual(JSON.parse(received.body), { topic: "slate-portable-check", title: text.title, message: text.body, markdown: false });
	// Keep accepting connections so a delayed duplicate remains observable.
	await delay(250);
	assert.equal(requests.length, 1, "no extra request may arrive during the 250 ms quiet window");
	assert.equal(starts.length, 1, "no extra resolver may start during the quiet window");
});

requiredCase(deadlineCase, { timeout: 8000 }, async (t) => {
	// Stall only the lookup callback. Keep the exact production timer and self-kill code.
	const prelude = `require('node:dns').lookup = (host, options, callback) => {
		process.stdout.write(JSON.stringify({ host, options }) + '\\n');
		setInterval(() => {}, 1000);
	};`;
	const deadlineMs = 300;
	// The hosted macOS and Windows baseline is at most 361 ms with startup and pipe close.
	// Allow 1000 ms for startup, scheduling and pipe close, but reject a 10x deadline.
	const startupAllowanceMs = 1000;
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	const start = performance.now();
	const child = spawn(process.execPath, ["--input-type=commonjs", "-e", prelude + PUSH_RESOLVER_SCRIPT,
		"--", "localhost", String(deadlineMs), "ipv4first"], {
		env: systemRoot === undefined ? {} : { SystemRoot: systemRoot },
		stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
	});
	guardChild(t, child);
	let output = "", errors = "";
	child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
	child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
	const closed = new Promise<void>((done, reject) => {
		child.once("error", reject);
		child.once("close", () => done());
	});
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([closed, new Promise<never>((_done, reject) => {
			closeTimer = setTimeout(() => reject(new Error("the child self-deadline must close within five seconds")), 5000);
		})]);
	} finally { clearTimeout(closeTimer); }
	const elapsed = performance.now() - start;
	assert.equal(errors, "");
	const observed = JSON.parse(output);
	assert.equal(observed.host, "localhost", "the child must reach the stalled lookup");
	assert.equal(observed.options.all, true);
	assert.equal(observed.options.order, "ipv4first");
	assert.ok(elapsed >= deadlineMs - 20, "the child must wait for its own deadline");
	assert.ok(elapsed < deadlineMs + startupAllowanceMs,
		`the child must close within ${deadlineMs} ms plus ${startupAllowanceMs} ms for startup and scheduling (observed ${Math.round(elapsed)} ms)`);
	assert.equal(child.killed, false, "the parent must not terminate the child");
	// Windows termination does not require a particular signalCode representation.
	assertGone(child);
});
