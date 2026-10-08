import assert from "node:assert/strict";
import test from "node:test";
import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import net, { type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { bindNotificationSettings, notificationSettings } from "../extension/notification-config.ts";
import { NotificationDispatcher } from "../extension/notification-dispatcher.ts";
import { sanitizeNotificationText, truncateNotificationUtf8 } from "../extension/notification-protocols.ts";
import { createPushNotificationChannel, PUSH_ATTEMPT_TIMEOUT_MS, PUSH_TEXT_MAX_BYTES } from "../extension/notification-push.ts";

const slots = () => (globalThis as unknown as Record<symbol, Map<string, unknown>>)[Symbol.for("ytdb-slate.notification-channel-slots.v1")]!;
function keepAlive(t: test.TestContext) {
	const timer = setInterval(() => {}, 1000);
	t.after(() => clearInterval(timer));
}
async function until(condition: () => boolean) {
	for (let i = 0; i < 200; i++) { if (condition()) return; await delay(5); }
	assert.ok(condition(), "condition must become true within one second");
}
function policy(server: string, extra: object = {}, project?: object) {
	const config = {};
	const warnings: string[] = [];
	bindNotificationSettings(config, { terminal: false, native: false, bell: false, minimumDelayMs: 0, cooldownMs: 0, push: { enabled: true, server, topic: "home_topic" }, ...extra }, project, (warning) => warnings.push(warning));
	return { config, settings: notificationSettings(config), warnings };
}
interface Received { url: string | undefined; headers: http.IncomingHttpHeaders; raw: string; json: Record<string, unknown> }
async function server(t: test.TestContext, reply: (response: ServerResponse) => void = (response) => response.end("ok")) {
	keepAlive(t);
	const requests: Received[] = [];
	const service = http.createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => { raw += chunk; });
		request.on("end", () => { requests.push({ url: request.url, headers: request.headers, raw, json: JSON.parse(raw) as Record<string, unknown> }); reply(response); });
	});
	await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
	t.after(async () => {
		service.closeAllConnections();
		await new Promise<void>((done, reject) => service.close((error) => error ? reject(error) : done()));
	});
	const address = service.address();
	assert.ok(address && typeof address !== "string");
	return { service, requests, url: `http://127.0.0.1:${address.port}/prefix/` };
}
function dispatcher(t: test.TestContext, settings: ReturnType<typeof notificationSettings>) {
	const scheduled = new Set<() => void>();
	const warnings: string[] = [];
	const channel = createPushNotificationChannel({ mode: "tui", settings });
	const instance = new NotificationDispatcher({ mode: "tui", cwd: "/private/project", settings, channels: [channel], current: () => true, idle: () => true, queued: () => false, recovering: () => false, warn: (warning) => warnings.push(warning), schedule: (_delay, callback) => { scheduled.add(callback); return () => { scheduled.delete(callback); }; } });
	t.after(() => instance.retire());
	return { instance, warnings, async admit(reason = "stop", content = "agent", errorMessage?: string) {
		instance.runStart(); instance.message({ role: "assistant", stopReason: reason, content, errorMessage }); instance.settled();
		for (let i = 0; i < 4; i++) {
			for (const callback of [...scheduled]) { scheduled.delete(callback); callback(); }
			await Promise.resolve();
		}
	} };
}
function fakeTransport(t: test.TestContext, secure = false) {
	keepAlive(t);
	let unrefs = 0, socketDestroys = 0, requestDestroys = 0;
	const connection = Object.assign(new EventEmitter(), { unref() { unrefs++; }, destroy() { socketDestroys++; return this; } });
	const request = Object.assign(new EventEmitter(), { destroy() { requestDestroys++; return this; }, end(_payload: string) { return this; } });
	let respond!: (incoming: IncomingMessage) => void;
	const calls: Array<{ url: URL; options: http.RequestOptions }> = [];
	t.mock.method(secure ? https : http, "request", (url: URL, options: http.RequestOptions, callback: (incoming: IncomingMessage) => void) => {
		calls.push({ url, options }); respond = callback;
		return request as unknown as ClientRequest;
	});
	const close = () => { connection.emit("close"); request.emit("close"); };
	t.after(async () => { close(); await until(() => !slots()?.has("push")); });
	return { request, connection, calls, respond: () => {
		const response = Object.assign(new EventEmitter(), { destroy() { responseDestroyed = true; return this; } });
		let responseDestroyed = false;
		respond(response as unknown as IncomingMessage);
		return responseDestroyed;
	}, attach: () => request.emit("socket", connection as unknown as Socket), close, get unrefs() { return unrefs; }, get socketDestroys() { return socketDestroys; }, get requestDestroys() { return requestDestroys; } };
}

test("push publishes fixed JSON and only authentication headers contain credentials", { timeout: 3000 }, async (t) => {
	const f = await server(t);
	const hostile = '"},"actions":[{"url":"https://evil.test"}],"message":" <b>&;` $() \\ é\n\u202e';
	for (const credentials of [{ token: "PRIVATE-token" }, { username: "name-é", password: "PRIVATE-pass" }, {}]) {
		const p = policy(f.url, { push: { enabled: true, server: f.url, topic: "home_topic", ...credentials } });
		assert.deepEqual((p.config as { notifications: { push: object } }).notifications.push, { enabled: true });
		const channel = createPushNotificationChannel({ mode: "tui", settings: p.settings });
		const text = { title: hostile, body: hostile, actions: [{ url: "https://evil.test" }], token: "injected", topic: "injected" };
		const previous = f.requests.length;
		const send = await channel.prepare(text, new AbortController().signal);
		await delay(10);
		assert.equal(f.requests.length, previous, "prepare never starts a request");
		await send();
		assert.equal(f.requests.length, previous + 1);
		const received = f.requests.at(-1)!;
		assert.equal(received.url, "/prefix/");
		assert.deepEqual(received.json, { topic: "home_topic", title: sanitizeNotificationText(hostile), message: sanitizeNotificationText(hostile), markdown: false });
		assert.deepEqual(Object.keys(received.json).sort(), ["markdown", "message", "title", "topic"]);
		assert.equal(received.headers["content-type"], "application/json");
		assert.equal(Number(received.headers["content-length"]), Buffer.byteLength(received.raw));
		assert.equal(received.headers.connection, "close");
		assert.equal(received.headers.authorization, "token" in credentials ? "Bearer PRIVATE-token" : "username" in credentials ? `Basic ${Buffer.from("name-é:PRIVATE-pass").toString("base64")}` : undefined);
		assert.ok(!JSON.stringify(received.headers).includes(sanitizeNotificationText(hostile)));
		assert.ok(!received.raw.includes("PRIVATE"));
		assert.deepEqual(p.warnings, []);
	}
});

test("root and proxy-prefix URLs use JSON publishing and topic-like paths never publish elsewhere", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	const paths: string[] = [], published: Array<{ topic: string; message: string }> = [];
	const service = http.createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => { raw += chunk; });
		request.on("end", () => {
			const path = request.url!;
			paths.push(path);
			// The proxy maps its base path to the ntfy root. Other paths use ntfy routing.
			const routed = path.startsWith("/base/") ? path.slice("/base".length) : path;
			if (request.method === "POST" && routed === "/") {
				const body = JSON.parse(raw) as { topic: string; message: string };
				published.push({ topic: body.topic, message: body.message });
				response.end("ok");
			} else if (request.method === "POST" && /^\/[a-zA-Z0-9_-]+$/.test(routed)) {
				published.push({ topic: routed.slice(1), message: raw });
				response.end("ok");
			} else { response.writeHead(404); response.end(); }
		});
	});
	await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
	t.after(async () => { service.closeAllConnections(); await new Promise<void>((done) => service.close(() => done())); });
	const address = service.address(); assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	for (const [configured, expected, delivers] of [
		["", "/", true], ["/", "/", true], ["/base", "/base/", true], ["/base/", "/base/", true],
		["/other_topic", "/other_topic/", false], ["/other_topic/", "/other_topic/", false], ["/a/", "/a/", false],
	] as const) {
		const p = policy(origin + configured), before = published.length;
		const channel = createPushNotificationChannel({ mode: "tui", settings: p.settings });
		await (await channel.prepare({ title: "T", body: "intended message" }, new AbortController().signal))();
		assert.equal(paths.at(-1), expected);
		assert.deepEqual(published.slice(before), delivers ? [{ topic: "home_topic", message: "intended message" }] : []);
		assert.deepEqual(p.warnings, []);
	}
	assert.equal(paths.length, 7);
	assert.equal(published.length, 4);
	assert.ok(published.every((message) => message.topic === "home_topic"));
});

test("push text fields have a UTF-8 byte limit and never split a character", { timeout: 3000 }, async (t) => {
	const f = await server(t), p = policy(f.url);
	const value = "😀".repeat(400) + "newest";
	await (await createPushNotificationChannel({ mode: "tui", settings: p.settings }).prepare({ title: value, body: value }, new AbortController().signal))();
	assert.equal(f.requests.length, 1);
	for (const key of ["title", "message"]) {
		assert.equal(f.requests[0]!.json[key], truncateNotificationUtf8(value, PUSH_TEXT_MAX_BYTES));
		assert.equal(Buffer.byteLength(f.requests[0]!.json[key] as string), PUSH_TEXT_MAX_BYTES);
		assert.ok(!(f.requests[0]!.json[key] as string).includes("\ufffd"));
	}
});

test("dispatcher keeps push detail independent and respects home authority and project lowering", { timeout: 4000 }, async (t) => {
	const f = await server(t);
	for (const [home, project, expected] of [
		[{ detail: "message" }, undefined, ""],
		[{ pushDetail: "project" }, undefined, "project"],
		[{ pushDetail: "message" }, undefined, "project: …agent"],
		[{}, { pushDetail: "message" }, ""],
		[{ pushDetail: "message" }, { pushDetail: "generic" }, ""],
	] as const) {
		const p = policy(f.url, home, project), d = dispatcher(t, p.settings);
		await d.admit();
		await until(() => !slots().has("push"));
		assert.equal(f.requests.at(-1)!.json.title, "Input needed");
		assert.equal(f.requests.at(-1)!.json.message, expected);
		assert.deepEqual(d.warnings, []); d.instance.retire();
	}
	for (const [detail, expected] of [["generic", ""], ["message", "project: …PRIVATE provider"]] as const) {
		const d = dispatcher(t, policy(f.url, { pushDetail: detail }).settings);
		await d.admit("error", "", "PRIVATE provider"); await until(() => !slots().has("push"));
		assert.equal(f.requests.at(-1)!.json.title, "Error"); assert.equal(f.requests.at(-1)!.json.message, expected); d.instance.retire();
	}
	assert.equal(f.requests.length, 7);
});

test("disabled push, noninteractive modes and aborted preparation make zero requests", { timeout: 3000 }, async (t) => {
	const f = await server(t);
	for (const [mode, enabled, abort] of [["tui", false, false], ["rpc", true, false], ["print", true, false], ["tui", true, true]] as const) {
		const p = policy(f.url, { push: { enabled, server: f.url, topic: "home_topic" } }), controller = new AbortController();
		if (abort) controller.abort();
		await (await createPushNotificationChannel({ mode, settings: p.settings }).prepare({ title: "T", body: "B" }, controller.signal))();
	}
	const d = dispatcher(t, policy(f.url, {}, { push: { enabled: false } }).settings);
	await d.admit(); await delay(20);
	assert.equal(f.requests.length, 0); assert.deepEqual(d.warnings, []);
});

test("redirects never forward credentials and failed statuses remain silent without retries", { timeout: 4000 }, async (t) => {
	const target = await server(t);
	let status = 301;
	const origin = await server(t, (response) => { response.writeHead(status, { Location: target.url }); response.end("PRIVATE server error"); });
	const p = policy(origin.url, { push: { enabled: true, server: origin.url, topic: "home_topic", token: "PRIVATE-token" } });
	const d = dispatcher(t, p.settings);
	for (status of [301, 302, 303, 307, 308, 401, 500]) {
		await d.admit(); await until(() => !slots().has("push"));
	}
	await delay(20);
	assert.equal(origin.requests.length, 7); assert.equal(target.requests.length, 0); assert.deepEqual(d.warnings, []);
});

test("response work ends at headers without waiting for an endless body", { timeout: 3000 }, async (t) => {
	const f = await server(t, (response) => { response.writeHead(200); response.flushHeaders(); });
	const channel = createPushNotificationChannel({ mode: "tui", settings: policy(f.url).settings });
	await (await channel.prepare({ title: "T", body: "B" }, new AbortController().signal))();
	assert.equal(f.requests.length, 1);
});

test("a never-answering server keeps its deadline after acceptance and abort", { timeout: 3000 }, async (t) => {
	const f = await server(t, () => {}), controller = new AbortController();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const channel = createPushNotificationChannel({ mode: "tui", settings: policy(f.url).settings });
	let settled = false;
	const pending = Promise.resolve((await channel.prepare({ title: "T", body: "B" }, controller.signal))()).then(() => { settled = true; });
	await until(() => f.requests.length === 1);
	controller.abort(); await delay(20);
	assert.equal(settled, false, "accepted request is not recalled by retirement");
	t.mock.timers.tick(PUSH_ATTEMPT_TIMEOUT_MS - 1); await delay(10); assert.equal(settled, false);
	t.mock.timers.tick(1); await pending;
	assert.equal(settled, true); assert.equal(f.requests.length, 1);
});

test("prepare settles promptly and abort before sending cancels without a request", { timeout: 3000 }, async (t) => {
	const f = await server(t), controller = new AbortController();
	const channel = createPushNotificationChannel({ mode: "tui", settings: policy(f.url).settings });
	let preparedSettled = false;
	const prepared = channel.prepare({ title: "T", body: "B" }, controller.signal);
	void prepared.then(() => { preparedSettled = true; });
	controller.abort();
	await Promise.resolve();
	assert.equal(preparedSettled, true, "abort must not wait for background resource work");
	await (await prepared)();
	assert.equal(f.requests.length, 0);
	const during = new AbortController();
	const send = await channel.prepare({ title: "T", body: "B" }, during.signal);
	const pending = send(); during.abort(); await pending;
	await delay(20); assert.equal(f.requests.length, 0);
});

test("unaccepted push holds the global slot through destroy and close across retirement", { timeout: 3000 }, async (t) => {
	const f = fakeTransport(t), settings = policy("http://127.0.0.1").settings;
	const first = dispatcher(t, settings); await first.admit(); f.attach();
	assert.equal(f.calls.length, 1); assert.equal(f.unrefs, 1); assert.ok(slots().has("push"));
	first.instance.retire();
	assert.ok(f.requestDestroys > 0); assert.ok(f.socketDestroys > 0); assert.ok(slots().has("push"));
	const next = dispatcher(t, settings); await next.admit("error");
	assert.equal(f.calls.length, 1, "new session cannot acquire a closing socket's slot");
	f.request.emit("close"); await delay(5);
	assert.ok(slots().has("push"), "request close alone does not confirm socket close");
	f.close(); await until(() => !slots().has("push"));
	await next.admit(); assert.equal(f.calls.length, 2);
	f.attach(); f.request.emit("finish"); assert.equal(f.respond(), true); f.close();
	await until(() => !slots().has("push")); assert.deepEqual(first.warnings, []); assert.deepEqual(next.warnings, []);
});

test("accepted work survives session retirement but timeout retains the slot until socket close", { timeout: 3000 }, async (t) => {
	const f = fakeTransport(t), settings = policy("http://127.0.0.1").settings;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const first = dispatcher(t, settings); await first.admit(); f.attach(); f.request.emit("finish");
	first.instance.retire(); assert.equal(f.requestDestroys, 0); assert.equal(f.socketDestroys, 0);
	const next = dispatcher(t, settings); await next.admit("error"); assert.equal(f.calls.length, 1);
	t.mock.timers.tick(PUSH_ATTEMPT_TIMEOUT_MS); assert.equal(f.socketDestroys, 1); assert.ok(slots().has("push"));
	f.close(); await until(() => !slots().has("push"));
	assert.deepEqual(first.warnings, []); assert.deepEqual(next.warnings, []);
});

test("HTTPS uses the original host and a supplied lookup without pooling", { timeout: 3000 }, async (t) => {
	const f = fakeTransport(t, true);
	const lookup: NonNullable<http.RequestOptions["lookup"]> = (_hostname, _options, _callback) => {};
	const channel = createPushNotificationChannel({ mode: "tui", settings: policy("https://original.example/base").settings, lookup });
	const pending = (await channel.prepare({ title: "T", body: "B" }, new AbortController().signal))();
	assert.equal(f.calls[0]!.url.hostname, "original.example"); assert.equal(f.calls[0]!.options.lookup, lookup);
	assert.equal(f.calls[0]!.options.agent, false); assert.equal(f.calls[0]!.options.method, "POST");
	assert.equal((f.calls[0]!.options as https.RequestOptions).rejectUnauthorized, undefined, "Node TLS verification remains enabled by default");
	f.attach(); f.request.emit("finish"); assert.equal(f.respond(), true); f.close(); await pending;
});

test("transport exceptions and errors never expose text or credentials in warnings or results", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	const privateValue = "PRIVATE-token-and-message";
	const settings = policy("http://127.0.0.1", { push: { enabled: true, server: "http://127.0.0.1", topic: "home_topic", token: privateValue } }).settings;
	t.mock.method(http, "request", () => { throw new Error(privateValue); });
	const d = dispatcher(t, settings); await d.admit("error", privateValue); await until(() => !slots().has("push"));
	assert.deepEqual(d.warnings, []);
	const channel = createPushNotificationChannel({ mode: "tui", settings });
	assert.equal(await (await channel.prepare({ title: privateValue, body: privateValue }, new AbortController().signal))(), undefined);
	t.mock.restoreAll();
	const f = fakeTransport(t), controller = new AbortController();
	const pending = (await channel.prepare({ title: privateValue, body: privateValue }, controller.signal))();
	f.attach(); f.request.emit("error", new Error(privateValue));
	assert.ok(f.socketDestroys > 0); f.close(); assert.equal(await pending, undefined);
	await delay(20); assert.equal(f.calls.length, 1, "a request error must not retry");
	const hostile = { get title(): string { throw new Error(privateValue); }, body: privateValue };
	assert.equal(await (await channel.prepare(hostile, controller.signal))(), undefined);
});

test("a refused local connection is silent and ends without retries", { timeout: 3000 }, async (t) => {
	keepAlive(t);
	const service = http.createServer();
	await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
	const address = service.address(); assert.ok(address && typeof address !== "string");
	await new Promise<void>((done) => service.close(() => done()));
	let attempts = 0;
	const original = http.request;
	t.mock.method(http, "request", (...args: Parameters<typeof original>) => { attempts++; return original(...args); });
	const d = dispatcher(t, policy(`http://127.0.0.1:${address.port}`).settings);
	await d.admit(); await until(() => !slots().has("push"));
	await delay(20); assert.equal(attempts, 1, "a refused connection must not retry");
	assert.deepEqual(d.warnings, []);
});

test("pending and accepted push sockets and deadlines do not keep a child process alive", { timeout: 6000 }, async (t) => {
	const f = await server(t, () => {}), connections = new Set<Socket>();
	let handshakes = 0;
	const stalledTls = net.createServer((socket) => {
		connections.add(socket);
		socket.on("data", () => { handshakes++; });
		socket.on("error", () => {});
		socket.on("close", () => connections.delete(socket));
	});
	await new Promise<void>((done) => stalledTls.listen(0, "127.0.0.1", done));
	t.after(async () => {
		for (const socket of connections) socket.destroy();
		await new Promise<void>((done) => stalledTls.close(() => done()));
	});
	const address = stalledTls.address(); assert.ok(address && typeof address !== "string");
	const moduleUrl = new URL("../extension/notification-push.ts", import.meta.url).href;
	const configUrl = new URL("../extension/notification-config.ts", import.meta.url).href;
	for (const accepted of [false, true]) {
		const url = accepted ? f.url : `https://127.0.0.1:${address.port}/`;
		const source = `import { createPushNotificationChannel } from ${JSON.stringify(moduleUrl)};
		import { resolveNotificationSettings } from ${JSON.stringify(configUrl)};
		import assert from 'node:assert/strict';
		import transport from ${JSON.stringify(accepted ? "node:http" : "node:https")};
		const keep = setInterval(() => {}, 1000);
		const original = transport.request;
		transport.request = (...args) => {
			const request = original(...args);
			${accepted ? `request.once('finish', () => { console.log('accepted'); clearInterval(keep); });` : `
			request.once('socket', (socket) => socket.once('connect', () => setImmediate(() => {
				assert.equal(request.socket, socket);
				assert.equal(request.writableFinished, false);
				console.log('pending: socket assigned, request unfinished'); clearInterval(keep);
			})));`}
			return request;
		};
		const settings = resolveNotificationSettings({push:{enabled:true,server:${JSON.stringify(url)},topic:'topic'}},undefined,()=>{});
		const send = await createPushNotificationChannel({mode:'tui',settings}).prepare({title:'T',body:'B'},new AbortController().signal);
		void send();`;
		const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
		t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
		let output = "", errors = "";
		child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); }); child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
		const start = performance.now();
		const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
		assert.equal(code, 0, errors); assert.match(output, accepted ? /accepted/ : /pending: socket assigned, request unfinished/);
		assert.ok(performance.now() - start < 2000, "exit must not wait for the five-second delivery deadline");
	}
	assert.ok(handshakes >= 1, "the pending child must start a handshake that the server never completes");
	assert.equal(f.requests.length, 1, "only the accepted child sends an HTTP request");
});
