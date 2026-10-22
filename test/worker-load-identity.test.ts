import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

for (const cache of ["empty", "populated"]) {
  test(`real host concurrent worker load identity: ${cache} cache`, { timeout: 100000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "slate-load-identity-"));
    try {
      for (const dir of ["home", "agent", "project", "tmp/jiti"]) mkdirSync(join(root, dir), { recursive: true });
      const env = {
        // Jiti byte offsets do not match native TypeScript coverage.
        NODE_V8_COVERAGE: undefined,
        HOME: join(root, "home"), PATH: `${resolve("node_modules/.bin")}:${process.env.PATH}`,
        TMPDIR: join(root, "tmp"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1",
        PI_CODEMODE_MAX_WORKERS: "2", JITI_FS_CACHE: "true", JITI_REBUILD_FS_CACHE: "false",
        SLATE_IDENTITY_RESULT: join(root, "result.json"),
      };
      const run = () => {
        const child = spawnSync(process.execPath, [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
          "--no-extensions", "-e", resolve("test/fixtures/worker-load-identity.ts"),
          "--provider", "load-probe", "--model", "worker", "--no-session", "-p", "exit"],
        { cwd: join(root, "project"), env, encoding: "utf8", timeout: 40000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
        assert.equal(child.error, undefined, String(child.error));
        assert.equal(child.status, 0, child.stdout + child.stderr);
        return JSON.parse(readFileSync(env.SLATE_IDENTITY_RESULT, "utf8"));
      };
      assert.deepEqual(readdirSync(join(root, "tmp/jiti")), []);
      if (cache === "populated") {
        run();
        assert.ok(readdirSync(join(root, "tmp/jiti")).length > 0, "preparation must generate cache entries");
      }
      const result = run();
      assert.equal(result.results.length, 3, JSON.stringify(result));
      assert.deepEqual(result.cleanup, ["fulfilled", "fulfilled", "fulfilled"], JSON.stringify(result));
      for (const worker of result.results) {
        assert.equal(worker.path, "<inline:slate-worker-codemode>", JSON.stringify(result));
        assert.equal(worker.active, true, JSON.stringify(worker));
        assert.notEqual(worker.hook?.block, true, JSON.stringify(worker));
        assert.equal(worker.messages.length, 1, JSON.stringify(worker));
        assert.notEqual(worker.messages[0].isError, true, JSON.stringify(worker));
        assert.match(JSON.stringify(worker.messages[0].content), /identity-ok/);
      }
      assert.deepEqual(result.warnings, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
