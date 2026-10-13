import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

// This test-only certificate names original.example. It is valid from 2020 through 2120.
const certUrl = new URL("./fixtures/notification-push-cert.pem", import.meta.url);
const keyUrl = new URL("./fixtures/notification-push-key.pem", import.meta.url);

test("real TLS verifies the original hostname rather than the pinned loopback address", { timeout: 3000 }, async (t) => {
	const sockets = new Set<Duplex>(), requests: string[] = [], servernames: string[] = [];
	const server = https.createServer({ cert: readFileSync(certUrl), key: readFileSync(keyUrl) }, (request, response) => {
		requests.push(request.headers.host!);
		request.resume(); response.end();
	});
	server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	server.on("secureConnection", (socket) => { servernames.push((socket as typeof socket & { servername: string }).servername); });
	server.on("tlsClientError", () => {});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((done) => server.close(() => done())); });
	const port = (server.address() as { port: number }).port;
	const moduleUrl = new URL("../extension/notification-push.ts", import.meta.url).href;
	const configUrl = new URL("../extension/notification-config.ts", import.meta.url).href;
	for (const host of ["original.example", "different.example"]) {
		const before = requests.length;
		const source = `import { createPushNotificationChannel } from ${JSON.stringify(moduleUrl)};
			import { resolveNotificationSettings } from ${JSON.stringify(configUrl)};
			const keep = setInterval(() => {}, 1000);
			const settings=resolveNotificationSettings({push:{enabled:true,server:'https://${host}:${port}',topic:'t'}},undefined,()=>{});
			const resolver={script:"console.log('[{\\\"address\\\":\\\"127.0.0.1\\\",\\\"family\\\":4}]')"};
			await (await createPushNotificationChannel({mode:'tui',settings,resolver}).prepare({title:'T',body:'B'},new AbortController().signal))();
			clearInterval(keep); console.log('complete');`;
		// Only this disposable child trusts the test certificate. Production requests use the system trust store.
		const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", source], {
			env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(certUrl) }, stdio: ["ignore", "pipe", "pipe"],
		});
		t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
		let output = "", errors = "";
		child.stdout.on("data", (chunk: Buffer) => { output += chunk; });
		child.stderr.on("data", (chunk: Buffer) => { errors += chunk; });
		const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
		assert.equal(code, 0, errors); assert.match(output, /complete/);
		assert.equal(requests.length - before, host === "original.example" ? 1 : 0, "a trusted wrong-host certificate must not receive a POST");
	}
	assert.deepEqual(requests, [`original.example:${port}`]);
	assert.deepEqual(servernames, ["original.example"]);
});
