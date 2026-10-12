import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkoutRoot, gitEnvironment, registerMainWorktreeCheck, runProcess,
  type ProcessRequest, type ProcessResult, type ProcessRunner } from "../.pi/extensions/require-main-worktree.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
class FakeApi {
  readonly handlers = new Map<string, Handler>();
  tools: Array<{ name: string; sourceInfo: { path: string } }> = [];
  commands: Array<{ name: string; source: string; sourceInfo: { path: string } }> = [];
  on(name: string, handler: Handler): void { this.handlers.set(name, handler); }
  getAllTools() { return this.tools; }
  getCommands() { return this.commands; }
  async emit(name: string, ctx: ExtensionContext) { await this.handlers.get(name)?.({}, ctx); }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "slate-main-worktree-"));
  const main = join(directory, "main");
  const root = join(directory, "checkout");
  const origin = join(directory, "origin");
  const env = { ...gitEnvironment(), HOME: directory, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8", timeout: 1000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  };
  mkdirSync(main);
  git(main, "init", "-b", "main");
  mkdirSync(join(main, "extension"));
  writeFileSync(join(main, "extension/index.ts"), "export default () => {};\n");
  writeFileSync(join(main, "package.json"), '{"name":"ytdb-slate"}\n');
  git(main, "add", ".");
  git(main, "commit", "-m", "fixture");
  git(main, "worktree", "add", "-b", "feature", root);
  git(directory, "clone", "--no-local", main, origin);
  git(main, "remote", "add", "origin", origin);
  const commit = (cwd: string, name: string) => {
    writeFileSync(join(cwd, name), name);
    git(cwd, "add", name);
    git(cwd, "commit", "-m", name);
    return git(cwd, "rev-parse", "HEAD");
  };
  return { directory, main, root, origin, git, commit,
    dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

type Fixture = ReturnType<typeof fixture>;

async function awaitBackground<T>(operation: () => Promise<T>): Promise<T> {
  // The test caller owns the lifetime while it awaits an unreferenced query.
  const keepAlive = setInterval(() => {}, 1000);
  try { return await operation(); }
  finally { clearInterval(keepAlive); }
}

function harness(f: Fixture, run: ProcessRunner = runProcess, mode: ExtensionContext["mode"] = "tui", root = f.root) {
  const api = new FakeApi();
  api.tools = [{ name: "thread", sourceInfo: { path: join(f.main, "extension/index.ts") } }];
  api.commands = [{ name: "slate", source: "extension", sourceInfo: { path: join(f.main, "extension/index.ts") } }];
  const notifications: Array<{ message: string; level: string }> = [];
  const errors: string[] = [];
  let ended = false;
  let contextReads = 0;
  const ctx = {
    get mode() { contextReads++; assert.equal(ended, false, "context read after shutdown"); return mode; },
    get ui() {
      contextReads++;
      assert.equal(ended, false, "context read after shutdown");
      return { notify: (message: string, level: string) => {
        assert.equal(ended, false, "notification after shutdown");
        notifications.push({ message, level });
      } };
    },
  } as unknown as ExtensionContext;
  const monitor = registerMainWorktreeCheck(api as unknown as ExtensionAPI, {
    root, run: (request) => run({ ...request, env: { ...request.env, HOME: f.directory,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }), stderr: (message) => errors.push(message),
  });
  return { api, ctx, notifications, errors, idle: () => awaitBackground(monitor.idle),
    reads: () => contextReads,
    start: () => api.emit("session_start", ctx),
    stop: async () => { await api.emit("session_shutdown", ctx); ended = true; } };
}

const success: ProcessResult = { code: 0, stdout: "", stderr: "" };
const remoteFailure: ProcessResult = { code: 128, stdout: "", stderr: "authentication failed" };
const remoteRunner: ProcessRunner = (request) => request.args.includes("ls-remote")
  ? Promise.resolve(remoteFailure) : runProcess(request);

for (const condition of ["sibling directory", "slate package", "shared Git repository", "main branch", "slate registration"]) {
  test(`local ${condition} passes in a valid layout`, { timeout: 1000 }, async (t) => {
    const f = fixture(); t.after(f.dispose);
    const h = harness(f, remoteRunner);
    await h.start(); await h.idle();
    assert.equal(h.notifications.filter((item) => item.level === "error").length, 0);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0]!.message, /Remote main query failed: authentication failed/);
  });
}

const failures: Array<{ name: string; condition: string; mutate: (f: Fixture, api: FakeApi) => void }> = [
  { name: "missing sibling", condition: "sibling directory", mutate: (f) => renameSync(f.main, join(f.directory, "moved")) },
  { name: "sibling is a file", condition: "sibling directory", mutate: (f) => {
    renameSync(f.main, join(f.directory, "moved")); writeFileSync(f.main, "not a directory");
  } },
  { name: "missing entry", condition: "slate package", mutate: (f) => rmSync(join(f.main, "extension/index.ts")) },
  { name: "wrong package", condition: "slate package", mutate: (f) => writeFileSync(join(f.main, "package.json"), '{"name":"other"}') },
  { name: "malformed manifest", condition: "slate package", mutate: (f) => writeFileSync(join(f.main, "package.json"), "{") },
  { name: "different repository", condition: "shared Git repository", mutate: (f) => {
    rmSync(join(f.root, ".git")); f.git(f.root, "init", "-b", "feature");
  } },
  { name: "wrong branch", condition: "main branch", mutate: (f) => { f.git(f.main, "switch", "-c", "other"); } },
  { name: "detached branch", condition: "main branch", mutate: (f) => { f.git(f.main, "checkout", "--detach"); } },
  { name: "missing thread", condition: "slate registration", mutate: (_f, api) => { api.tools = []; } },
  { name: "foreign thread source", condition: "slate registration", mutate: (f, api) => {
    api.tools[0]!.sourceInfo.path = join(f.root, "extension/index.ts");
  } },
  { name: "missing command", condition: "slate registration", mutate: (_f, api) => { api.commands = []; } },
  { name: "wrong command source", condition: "slate registration", mutate: (f, api) => {
    api.commands[0]!.sourceInfo.path = join(f.root, "extension/index.ts");
  } },
];
for (const failure of failures) {
  test(`local failure reports ${failure.name}`, { timeout: 1000 }, async (t) => {
    const f = fixture(); t.after(f.dispose);
    const calls: ProcessRequest[] = [];
    const h = harness(f, (request) => { calls.push(request); return remoteRunner(request); });
    failure.mutate(f, h.api);
    await h.start(); await h.idle();
    assert.match(h.notifications[0]!.message, new RegExp(`check failed: ${failure.condition}\\.`));
    assert.match(h.notifications[0]!.message, /Remedy:/);
    assert.equal(h.notifications[0]!.level, "error");
    if (failure.condition !== "slate registration") assert.equal(calls.some((call) => call.args.includes("ls-remote")), false);
    if (failure.condition === "sibling directory" || failure.condition === "slate package") assert.equal(calls.length, 0);
  });
}

test("registration still runs after the first local failure", { timeout: 1000 }, async (t) => {
  const f = fixture(); t.after(f.dispose);
  const h = harness(f, remoteRunner);
  rmSync(join(f.main, "extension/index.ts")); h.api.tools = [];
  await h.start();
  assert.equal(h.notifications.length, 2);
  assert.match(h.notifications[0]!.message, /slate package/);
  assert.match(h.notifications[1]!.message, /slate registration/);
});

test("relative common directory and real source paths pass in main itself", { timeout: 1000 }, async (t) => {
  const f = fixture(); t.after(f.dispose);
  assert.equal(f.git(f.main, "rev-parse", "--git-common-dir"), ".git");
  const alias = join(f.directory, "alias"); symlinkSync(f.main, alias);
  const h = harness(f, remoteRunner, "tui", f.main);
  h.api.tools[0]!.sourceInfo.path = join(alias, "extension/index.ts");
  h.api.commands[0]!.sourceInfo.path = join(alias, "extension/index.ts");
  await h.start(); await h.idle();
  assert.equal(h.notifications.filter((item) => item.level === "error").length, 0);
});

test("root comes from the module location", () => {
  assert.equal(checkoutRoot(pathToFileURL("/tmp/checkout/.pi/extensions/check.ts").href), "/tmp/checkout");
});

for (const mode of ["print", "json"] as const) {
  test(`${mode} errors also reach stderr`, { timeout: 1000 }, async (t) => {
    const f = fixture(); t.after(f.dispose);
    const h = harness(f, remoteRunner, mode); h.api.tools = [];
    await h.start(); await h.idle();
    assert.match(h.errors.join(""), /Main worktree check failed: slate registration/);
    assert.match(h.errors.join(""), /Remote main query failed/);
  });
}

for (const error of ["git missing", "unexpected throw", "killed success"]) {
  test(`${error} becomes a failed local condition`, { timeout: 1000 }, async (t) => {
    const f = fixture(); t.after(f.dispose);
    const h = harness(f, async () => {
      if (error === "unexpected throw") throw new Error("unexpected throw");
      if (error === "killed success") return { ...success, killed: true, timedOut: true };
      return { ...success, code: null, error: "spawn git ENOENT" };
    });
    await h.start();
    assert.match(h.notifications[0]!.message, /check failed: shared Git repository/);
    assert.equal(h.notifications[0]!.level, "error");
  });
}

for (const outcome of ["current", "local ahead", "behind", "behind present", "diverged", "query failure"]) {
  test(`remote outcome: ${outcome}`, { timeout: 1000 }, async (t) => {
    const f = fixture(); t.after(f.dispose);
    if (outcome === "local ahead") f.commit(f.main, "local");
    if (outcome === "behind") f.commit(f.origin, "remote");
    if (outcome === "diverged" || outcome === "behind present") {
      f.git(f.main, "switch", "-c", "remote-side");
      const sha = f.commit(f.main, "side");
      f.git(f.origin, "checkout", "--detach");
      f.git(f.main, "push", "origin", `${sha}:refs/heads/main`);
      f.git(f.main, "switch", "main");
      if (outcome === "diverged") f.commit(f.main, "local-side");
    }
    if (outcome === "query failure") f.git(f.main, "remote", "set-url", "origin", join(f.directory, "absent"));
    const h = harness(f);
    await h.start(); await h.idle();
    if (outcome === "current" || outcome === "local ahead") assert.deepEqual(h.notifications, []);
    else {
      assert.equal(h.notifications.length, 1);
      assert.equal(h.notifications[0]!.level, "warning");
      const expected = outcome === "behind" ? /behind remote main.*count is unknown.*pull/
        : outcome === "behind present" ? /behind remote main by 1 commit\(s\).*pull/
        : outcome === "diverged" ? /diverged.*before pulling/ : /Remote main query failed:.*not appear to be a git repository/s;
      assert.match(h.notifications[0]!.message, expected);
      if (outcome === "behind present") {
        assert.ok(h.notifications[0]!.message.includes(`git -C ${JSON.stringify(f.main)} pull`));
      }
    }
  });
}

test("remote failures and malformed responses cannot appear current", { timeout: 1000 }, async (t) => {
  const f = fixture(); t.after(f.dispose);
  for (const result of [{ ...success, stdout: "malformed" }, { ...success, killed: true, timedOut: true, error: "time limit" }]) {
    const h = harness(f, (request) => request.args.includes("ls-remote") ? Promise.resolve(result) : runProcess(request));
    await h.start(); await h.idle();
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0]!.message, /Remote main query failed/);
  }
});

test("start does not await remote, shutdown discards completion and rejection", { timeout: 1000 }, async (t) => {
  const f = fixture(); t.after(f.dispose);
  for (const rejectQuery of [false, true]) {
    let finish!: (result: ProcessResult) => void;
    let fail!: (error: Error) => void;
    let remoteSignal: AbortSignal | undefined;
    const pending = new Promise<ProcessResult>((resolveResult, reject) => { finish = resolveResult; fail = reject; });
    const h = harness(f, (request) => {
      if (!request.args.includes("ls-remote")) return runProcess(request);
      remoteSignal = request.signal;
      return pending;
    });
    await h.start();
    assert.ok(remoteSignal);
    assert.deepEqual(h.notifications, []);
    await h.stop();
    const reads = h.reads();
    assert.equal(remoteSignal.aborted, true);
    if (rejectQuery) fail(new Error("late failure")); else finish(remoteFailure);
    await h.idle(); await delay(0);
    assert.equal(h.reads(), reads);
    assert.deepEqual(h.notifications, []);
    assert.deepEqual(h.errors, []);
  }
});

for (const cause of ["shutdown", "restart"] as const) {
  test(`${cause} during a local check stops the old session checks`, { timeout: 2000 }, async (t) => {
    const f = fixture(); t.after(f.dispose);
    let ready!: () => void;
    let finish!: (result: ProcessResult) => void;
    let oldSignal: AbortSignal | undefined;
    const entered = new Promise<void>((resolveReady) => { ready = resolveReady; });
    const pending = new Promise<ProcessResult>((resolveResult) => { finish = resolveResult; });
    const calls: ProcessRequest[] = [];
    const h = harness(f, (request) => {
      calls.push(request);
      if (!oldSignal && request.cwd === f.main && request.args.includes("rev-parse")) {
        oldSignal = request.signal;
        ready();
        return pending;
      }
      return remoteRunner(request);
    });
    const starting = h.start();
    await entered;
    if (cause === "shutdown") await h.stop();
    else { await h.start(); await h.idle(); }
    assert.equal(oldSignal!.aborted, true);
    const oldCalls = calls.filter((call) => call.signal === oldSignal).length;
    const reads = h.reads();
    const notices = [...h.notifications];
    const errors = [...h.errors];
    // The injected runner completes successfully even after its signal aborts.
    finish({ ...success, stdout: ".git" });
    await starting;
    assert.equal(calls.filter((call) => call.signal === oldSignal).length, oldCalls);
    assert.equal(h.reads(), reads);
    assert.deepEqual(h.notifications, notices);
    assert.deepEqual(h.errors, errors);
  });
}

test("active notification failure is contained and reaches stderr", { timeout: 1000 }, async (t) => {
  const f = fixture(); t.after(f.dispose);
  const h = harness(f, remoteRunner);
  const ctx = { mode: "tui", ui: { notify: () => { throw new Error("notify broken"); } } } as unknown as ExtensionContext;
  await h.api.emit("session_start", ctx); await h.idle();
  assert.match(h.errors.join(""), /Notification failed: notify broken/);
});

test("every Git request disables helpers and uses fixed read-only arguments", { timeout: 1000 }, async (t) => {
  const f = fixture(); t.after(f.dispose);
  const requests: ProcessRequest[] = [];
  const h = harness(f, (request) => { requests.push(request); return runProcess(request); });
  await h.start(); await h.idle();
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(requests.map((request) => request.args[4]),
    ["rev-parse", "rev-parse", "symbolic-ref", "ls-remote", "cat-file", "merge-base"]);
  for (const request of requests) {
    assert.equal(request.command, "git");
    assert.deepEqual(request.args.slice(0, 4), ["-c", "credential.helper=", "-c", "credential.interactive=false"]);
    assert.equal(request.env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(request.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(request.timeoutMs, request.args.includes("ls-remote") ? 10_000 : 1000);
    assert.equal(request.background, !["rev-parse", "symbolic-ref"].includes(request.args[4]!));
  }
});

test("active remote rejection reports its error", { timeout: 1000 }, async (t) => {
  const f = fixture(); t.after(f.dispose);
  const h = harness(f, (request) => request.args.includes("ls-remote")
    ? Promise.reject(new Error("query threw")) : runProcess(request));
  await h.start(); await h.idle();
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0]!.message, /Remote main query failed: query threw/);
});

test("Git environment disables interactive paths and lazy fetching", () => {
  const env = gitEnvironment({ PATH: "/bin", HOME: "/tmp", DISPLAY: ":0", SSH_ASKPASS: "evil", GIT_ASKPASS: "evil",
    GIT_CONFIG_COUNT: "1", GIT_SSH_COMMAND: "evil", SSH_AUTH_SOCK: "/tmp/agent" });
  assert.equal(env.DISPLAY, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_ASKPASS, ""); assert.equal(env.SSH_ASKPASS, "");
  assert.equal(env.SSH_ASKPASS_REQUIRE, "never"); assert.equal(env.GIT_NO_LAZY_FETCH, "1");
  assert.match(env.GIT_SSH_COMMAND!, /BatchMode=yes.*ConnectTimeout=5/);
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent");
});

async function groupFixture(directory: string) {
  const pids = join(directory, "pids");
  const descendant = join(directory, "descendant.cjs");
  const leader = join(directory, "leader.cjs");
  writeFileSync(descendant, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  writeFileSync(leader, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
const child=spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));
process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
  return { pids, leader };
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A killed orphan can remain as a zombie until the system reaps it.
    return !readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2]?.includes("Z");
  } catch { return false; }
}

for (const cause of ["timeout", "shutdown"] as const) {
  test(`${cause} stops the whole query process group`, { timeout: 1000 }, async (t) => {
    const f = fixture(); t.after(f.dispose);
    const group = await groupFixture(f.directory);
    const h = harness(f, (request) => request.args.includes("ls-remote")
      ? runProcess({ ...request, command: process.execPath, args: [group.leader], timeoutMs: cause === "timeout" ? 350 : 5000 })
      : runProcess(request));
    await h.start();
    while (!existsSync(group.pids)) await delay(5);
    const pids: number[] = JSON.parse(readFileSync(group.pids, "utf8"));
    t.after(() => { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} } });
    if (cause === "shutdown") await h.stop();
    await h.idle();
    while (pids.some(running)) await delay(5);
    if (cause === "timeout") assert.match(h.notifications[0]!.message, /Remote main query failed: time limit/);
    else assert.deepEqual(h.notifications, []);
  });
}

test("awaited local child keeps its parent alive until completion", { timeout: 2000 }, (t) => {
  const f = fixture(); t.after(f.dispose);
  const script = join(f.directory, "local-parent.mjs");
  const moduleUrl = new URL("../.pi/extensions/require-main-worktree.ts", import.meta.url).href;
  writeFileSync(script, `import { runProcess, gitEnvironment } from ${JSON.stringify(moduleUrl)};
const result=await runProcess({command:process.execPath,
args:['-e','setTimeout(()=>{console.error("slow local failure");process.exit(128)},250)'],
cwd:${JSON.stringify(f.directory)},env:gitEnvironment(),timeoutMs:1000,signal:new AbortController().signal});
console.log(JSON.stringify(result));`);
  const parent = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 1500 });
  assert.equal(parent.status, 0, parent.stderr);
  const result: ProcessResult = JSON.parse(parent.stdout);
  assert.equal(result.code, 128);
  assert.equal(result.stderr.trim(), "slow local failure");
});

for (const abrupt of [false, true]) {
  test(abrupt ? "exit without shutdown stops the live query group"
    : "query child, pipes and timer do not keep their parent alive", { timeout: 3000 }, async (t) => {
    const f = fixture();
    // Stop children before removing the file that records their identifiers.
    t.after(() => {
      try {
        const path = join(f.directory, "pids");
        if (!existsSync(path)) return;
        const pids: number[] = JSON.parse(readFileSync(path, "utf8"));
        try { process.kill(-pids[0]!, "SIGKILL"); } catch {}
        for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
      } finally { f.dispose(); }
    });
    const group = await groupFixture(f.directory);
    const script = join(f.directory, "parent.mjs");
    const moduleUrl = new URL("../.pi/extensions/require-main-worktree.ts", import.meta.url).href;
    writeFileSync(script, `import { runProcess, gitEnvironment } from ${JSON.stringify(moduleUrl)};
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
runProcess({command:process.execPath,args:[${JSON.stringify(group.leader)}],cwd:${JSON.stringify(f.directory)},
env:gitEnvironment(),timeoutMs:10000,signal:new AbortController().signal,background:true});
while(!existsSync(${JSON.stringify(group.pids)})) await delay(5);
${abrupt ? "process.exit(7);" : ""}`);
    const parent = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 1500 });
    assert.equal(parent.status, abrupt ? 7 : 0, parent.stderr);
    assert.ok(existsSync(group.pids), "query leader started before parent exit");
    const pids: number[] = JSON.parse(readFileSync(group.pids, "utf8"));
    const deadline = Date.now() + 500;
    while (pids.some(running) && Date.now() < deadline) await delay(5);
    assert.ok(pids.every((pid) => !running(pid)), "parent exit stopped every query process");
  });
}

test("query exit listeners are removed on completion and abort", { timeout: 2000 }, async (t) => {
  const f = fixture(); t.after(f.dispose);
  const before = process.listenerCount("exit");
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const pending = runProcess({ command: process.execPath,
      args: ["-e", abort ? "setInterval(()=>{},1000)" : "process.exit(0)"],
      cwd: f.directory, env: gitEnvironment(), timeoutMs: 1000, signal: controller.signal, background: true });
    assert.equal(process.listenerCount("exit"), before + 1);
    if (abort) controller.abort();
    assert.equal((await awaitBackground(() => pending)).killed ?? false, abort);
    assert.equal(process.listenerCount("exit"), before);
  }
});

test("runner handles missing binaries and pre-aborted requests", { timeout: 1000 }, async (t) => {
  const f = fixture(); t.after(f.dispose);
  const controller = new AbortController();
  const request: ProcessRequest = { command: resolve(f.directory, "missing"), args: [], cwd: f.directory,
    env: gitEnvironment(), timeoutMs: 100, signal: controller.signal };
  assert.match((await runProcess(request)).error!, /ENOENT/);
  controller.abort();
  assert.equal((await runProcess(request)).killed, true);
});
