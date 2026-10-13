import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Python captures attached clients through private pseudoterminals, not pane history.
test("Linux tmux clients receive selected terminal requests through the real pane device", { timeout: 90000 }, (t) => {
	if (process.platform !== "linux") { t.skip("tmux terminal read-back requires Linux"); return; }
	const ci = /^(true|1|yes|on)$/i.test(process.env.CI?.trim() ?? "");
	const tools: Record<string, string> = {};
	for (const tool of ["tmux", "python3"]) {
		const result = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8", timeout: 2000 });
		if (result.status !== 0) {
			if (ci) assert.fail(`tmux terminal read-back requires ${tool} in CI`);
			t.skip(`tmux terminal read-back requires ${tool}`); return;
		}
		tools[tool] = result.stdout.trim();
	}
	const version = spawnSync(tools.tmux!, ["-V"], { encoding: "utf8", timeout: 2000 });
	assert.equal(version.status, 0, version.stderr);
	if (ci) assert.match(version.stdout.trim(), /^tmux 3\.4[^\r\n]*$/, "ubuntu-24.04 must supply the pinned tmux 3.4 series");
	t.diagnostic(`tmux client-stream version: ${version.stdout.trim()}`);
	const result = spawnSync(tools.python3!, [
		fileURLToPath(new URL("./fixtures/notification-tmux.py", import.meta.url)), process.execPath,
		fileURLToPath(new URL("./fixtures/notification-tmux.ts", import.meta.url)), tools.tmux!,
		fileURLToPath(new URL("..", import.meta.url)),
	], {
		encoding: "utf8", timeout: 80000, killSignal: "SIGTERM", maxBuffer: 1024 * 1024,
		env: { PATH: process.env.PATH, LANG: "C.UTF-8", TMPDIR: process.env.TMPDIR ?? "/tmp" },
	});
	assert.equal(result.error, undefined, result.stderr);
	assert.equal(result.status, 0, result.stderr);
	const measured = JSON.parse(result.stdout) as { cases_ms: Record<string, number>; wall_ms: number };
	assert.deepEqual(Object.keys(measured.cases_ms), [
		"single-iTerm2", "single-WezTerm", "single-ghostty", "single-kitty", "single-foot", "single-Konsole", "single-vscode",
		"protocol-tie", "two-protocols", "maximum-coverage", "fewer-protocols", "unidentified", "osc99-before-osc9",
		"fixed-explicit-order", "inactive-all", "inactive-on-silent", "delayed-inactive-on-silent", "default-bell-both", "real-query-failure",
		"unexpected-csi-rejected", "cleanup-command-failure", "cleanup-stopped-server", "cleanup-launch-error",
	], "all terminal and negative-control cases ran once in order");
	for (const [name, milliseconds] of Object.entries(measured.cases_ms)) {
		assert.ok(milliseconds < 10000, `${name} exceeded its per-case bound`);
		t.diagnostic(`${name}: ${milliseconds} ms`);
	}
	t.diagnostic(`tmux read-back added wall time on ${process.version}: ${measured.wall_ms} ms`);
});
