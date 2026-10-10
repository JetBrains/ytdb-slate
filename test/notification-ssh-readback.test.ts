import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Python owns both terminal ends and enforces a deadline for each SSH case.
test("Linux SSH client receives sanitized terminal requests and bell, but no headless bytes", { timeout: 90000 }, (t) => {
	if (process.platform !== "linux") { t.skip("SSH terminal read-back requires Linux"); return; }
	const unavailable = (message: string) => {
		if (/^(true|1|yes|on)$/i.test(process.env.CI?.trim() ?? "")) assert.fail(`${message} in CI`);
		t.skip(message);
	};
	if (process.getuid?.() === 0) { unavailable("SSH terminal read-back requires an unprivileged user"); return; }
	const tools: Record<string, string> = {};
	for (const tool of ["sshd", "ssh", "ssh-keygen", "python3"]) {
		const result = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8", timeout: 2000 });
		if (result.status !== 0) { unavailable(`SSH terminal read-back requires ${tool}`); return; }
		tools[tool] = result.stdout.trim();
	}
	const result = spawnSync(tools.python3!, [
		fileURLToPath(new URL("./fixtures/notification-ssh.py", import.meta.url)), process.execPath,
		fileURLToPath(new URL("./fixtures/notification-ssh.ts", import.meta.url)),
		tools.sshd!, tools.ssh!, tools["ssh-keygen"]!, fileURLToPath(new URL("..", import.meta.url)),
	], {
		encoding: "utf8", timeout: 80000, killSignal: "SIGTERM", maxBuffer: 1024 * 1024,
		env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp" },
	});
	assert.equal(result.error, undefined, result.stderr);
	assert.equal(result.status, 0, result.stderr);
	const measured = JSON.parse(result.stdout) as { cases_ms: Record<string, number>; wall_ms: number };
	assert.equal(Object.keys(measured.cases_ms).length, 19, "every explicit protocol, payload shape, envelope and headless case ran");
	for (const [name, milliseconds] of Object.entries(measured.cases_ms)) {
		assert.ok(milliseconds < 15000, `${name} exceeded its per-case bound`);
		t.diagnostic(`${name}: ${milliseconds} ms`);
	}
	t.diagnostic(`SSH read-back added wall time on ${process.version}: ${measured.wall_ms} ms`);
});
