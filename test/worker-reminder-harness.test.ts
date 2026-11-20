import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const harness = readFileSync(new URL("../verification/run-worker-reminder-check.sh", import.meta.url), "utf8");
const windows = process.platform === "win32";

test("worker reminder RPC requires settlement and a clean exit", { skip: windows }, (t) => {
	const controller = harness.match(/<<'RPC'\n([\s\S]+?)\nRPC\n/)?.[1];
	assert.ok(controller, "RPC controller must be present");
	const scratch = mkdtempSync(join(tmpdir(), "slate-reminder-controller-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const input = join(scratch, "input");
	writeFileSync(input, '{"id":"turn","type":"prompt"}\n');
	writeFileSync(join(scratch, "timeout"), `#!/usr/bin/env node
const mode = process.env.CANARY_EXIT;
console.log(JSON.stringify({ id: "turn", type: "response", success: true }));
if (mode === "unsettled") process.exit(0);
console.log(JSON.stringify({ type: "agent_settled" }));
process.stdin.resume();
process.stdin.on("end", () => {
  console.error("stdin closed after settlement");
  if (mode !== "clean") process.kill(process.pid, mode);
});
`, { mode: 0o700 });

	for (const [mode, status] of [["clean", 0], ["unsettled", 1], ["SIGTERM", 143], ["SIGKILL", 137]] as const) {
		const run: SpawnSyncReturns<string> = spawnSync(process.execPath, ["-", input, "fake-pi", "repo", "canary"], {
			input: controller,
			encoding: "utf8",
			timeout: 5_000,
			env: { ...process.env, PATH: scratch + delimiter + process.env.PATH, CANARY_EXIT: mode },
		});
		assert.ifError(run.error);
		assert.equal(run.signal, null);
		assert.equal(run.status, status, mode + ": " + run.stderr);
		if (mode === "unsettled") assert.doesNotMatch(run.stdout, /agent_settled/);
		else {
			assert.match(run.stdout, /agent_settled/);
			assert.match(run.stderr, /stdin closed after settlement/);
		}
		if (mode.startsWith("SIG")) assert.ok(run.stderr.includes("terminated by " + mode));
	}
});

test("worker reminder driver stops after a case or driver receives TERM", { skip: windows }, () => {
	const driver = harness.split("\n)\n\n").at(-1);
	assert.ok(driver?.includes("run_case "), "case driver must be present");
	for (const target of ["case", "driver"]) {
		const run: SpawnSyncReturns<string> = spawnSync("bash", ["-s", "--", target], {
			input: `run_case() (
  echo "$2:$1"
  if [ "$1" = 20 ] && [ "$2" = normal ]; then
    trap 'exit 130' INT TERM
    if [ "$target" = case ]; then kill -TERM "$BASHPID"; else kill -TERM "$$"; fi
  fi
)
target="$1"
${driver}
`,
			encoding: "utf8",
			timeout: 5_000,
		});
		assert.ifError(run.error);
		assert.equal(run.signal, null);
		assert.equal(run.status, 130, target + ": " + run.stderr);
		assert.equal(run.stdout, "normal:20\n", "cancellation must not start another case");
	}
});
