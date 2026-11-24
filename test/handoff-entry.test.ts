import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSlateHandoff, type HandoffPurpose } from "../extension/handoff.ts";
import { SlateStore } from "../extension/state.ts";
import { createBaseModelTracker } from "../extension/base-model.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SAVED_DEFAULT_RESOURCE_KEY } from "../extension/failover.ts";

function fixture(manager = SessionManager.inMemory("/tmp"), allowed = true, shared = false, identity = true) {
  const handlers = new Map<string, any>();
  const messages: any[] = [];
  const warnings: string[] = [];
  let effort = "max";
  const model = { provider: "openai", id: "gpt-6-luna" };
  const pi = {
    on(name: string, fn: any) { handlers.set(name, fn); },
    appendEntry(name: string, data: any) { manager.appendCustomEntry(name, data); },
    getThinkingLevel: () => effort,
    setThinkingLevel(value: string) { effort = value; },
    setModel: async () => true,
    sendMessage(message: any) {
      messages.push(message);
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  } as unknown as ExtensionAPI;
  const store = new SlateStore(pi);
  store.orchestratorMode = true;
  const runtime = createLogicalRuntime({ trusted: true, projectConfig: shared ? { router: { models: { add: [{ model: "shared-alias", capabilityRating: 45, costRating: 11, effort: "max", preferredProvider: "openai", providers: { openai: "gpt-6-luna" }, guidelines: [], cautions: [] }] } } } : undefined });
  const base = createBaseModelTracker({ warn() {} });
  base.seed(model, "max");
  if (identity) base.adoptLogicalIdentity("luna-6");
  const routing = { runtime };
  const hooks = registerSlateHandoff(pi, store, () => ({ preserveGlobalModelDefault: false }), () => base, () => allowed ? routing.runtime : undefined);
  const ctx: any = {
    cwd: "/tmp", model, hasUI: true, ui: { notify: (text: string) => warnings.push(text) },
    sessionManager: manager, isProjectTrusted: () => false,
    waitForIdle: async () => {}, modelRegistry: { find: () => model },
  };
  return { pi, store, hooks, ctx, handlers, manager, messages, warnings, runtime, routing, base };
}

async function transfer(parent: ReturnType<typeof fixture>, options: { allowed?: boolean; reject?: boolean; failSave?: boolean; shared?: boolean; configure?: (child: ReturnType<typeof fixture>) => void; successor?: SessionManager; run?: () => void | Promise<void> } = {}, purpose?: HandoffPurpose) {
  const child = fixture(options.successor, options.allowed ?? true, options.shared);
  let turns = 0;
  let sendFailure: { error: unknown } | undefined;
  parent.ctx.newSession = async (request: any) => {
    await request.setup(child.manager);
    options.configure?.(child);
    if (options.failSave) {
      let saves = 0;
      const original = child.pi.appendEntry;
      child.pi.appendEntry = (name, data) => {
        if (name === "slate-state" && ++saves === 2) throw new Error("unpause save failed");
        original(name, data);
      };
    }
    await child.handlers.get("session_start")({}, child.ctx);
    await request.withSession({
      ...child.ctx,
      sendMessage: async (message: any, delivery: any) => {
        if (options.reject && message.customType === "slate-kickoff") throw new Error("fresh send refused");
        try {
          child.pi.sendMessage(message);
          if (delivery?.triggerTurn) {
            assert.equal(child.store.paused, false);
            assert.equal(child.ctx.model.id, "gpt-6-luna");
            assert.equal(child.pi.getThinkingLevel(), "max");
            if (options.run) await options.run();
            turns++;
          }
        } catch (error) {
          // Keep fixture errors visible when kickoff delivery reports the failure.
          sendFailure = { error };
          throw error;
        }
      },
    });
    return { cancelled: false };
  };
  await parent.hooks.startHandoff(parent.ctx, undefined, undefined, purpose);
  if (sendFailure) throw sendFailure.error;
  return { child, turns };
}

function appendKickoffReply(successor: SessionManager) {
  successor.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Kickoff reply" }], timestamp: 2,
    model: "gpt-6-luna", provider: "openai", api: "openai-completions", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
}

const fileClockWaitMs = 10_000;
test("the handoff successor is the newest session after kickoff", { timeout: 2 * fileClockWaitMs + 5_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "slate-handoff-order-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const parent = fixture(SessionManager.create("/tmp", dir));
  const successor = SessionManager.create("/tmp", dir);
  const parentFile = parent.manager.getSessionFile()!;
  const successorFile = successor.getSessionFile()!;
  parent.manager.appendMessage({ role: "user", content: "Parent request", timestamp: 1 });

  // Use a file that pi skips to observe when the filesystem records a later write.
  const probeFile = join(dir, "clock-probe");
  const waitForLaterWrite = async (file: string) => {
    const { mtimeMs } = statSync(file);
    const deadline = performance.now() + fileClockWaitMs;
    do {
      writeFileSync(probeFile, "probe");
      if (statSync(probeFile).mtimeMs > mtimeMs) return;
      await delay(10);
    } while (performance.now() < deadline);
    assert.fail(`The file clock did not advance past ${file} within ${fileClockWaitMs} ms`);
  };

  let parentAtKickoff: Buffer | undefined;
  const { child, turns } = await transfer(parent, { successor, run: async () => {
    parentAtKickoff = readFileSync(parentFile);
    await waitForLaterWrite(parentFile);
    appendKickoffReply(successor);
    await waitForLaterWrite(successorFile);
  } }, "track-boundary");

  assert.equal(turns, 1, "the successor must complete exactly one kickoff run");
  assert.doesNotMatch([...parent.warnings, ...child.warnings].join("\n"), /kickoff failed/i);
  assert.ok(parentAtKickoff, "the successor must start a kickoff run");
  assert.ok(parentAtKickoff.equals(readFileSync(parentFile)), "the parent file must not change after kickoff starts");
  assert.ok(statSync(parentFile).mtimeMs < statSync(successorFile).mtimeMs,
    "the parent file must be older than the successor file");
  assert.equal(SessionManager.continueRecent("/tmp", dir).getSessionFile(), successorFile,
    "pi --continue must select the successor session");
  const marker = SessionManager.open(parentFile).getBranch().findLast(
    (entry) => entry.type === "custom" && entry.customType === "slate-handoff-purpose",
  );
  assert.equal(marker?.type, "custom");
  assert.equal(marker.customType, "slate-handoff-purpose");
  assert.deepEqual(marker.data, { sessionId: parent.manager.getSessionId(), purpose: "track-boundary", consumed: true });
});

function diskHandoff(t: TestContext, persist = true) {
  const dir = mkdtempSync(join(tmpdir(), "slate-handoff-clock-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const parent = fixture(SessionManager.create("/tmp", dir));
  if (persist) parent.manager.appendMessage({ role: "user", content: "Parent request", timestamp: 1 });
  return { dir, parent, parentFile: parent.manager.getSessionFile()! };
}

function mockProbe(t: TestContext, dir: string | undefined, options: {
  write?: (fd: number) => void;
  close?: () => void;
  remove?: () => void;
} = {}) {
  const { openSync, writeFileSync, closeSync, unlinkSync } = fs;
  let fd: number | undefined;
  let probe: string | undefined;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof openSync>) => {
    const [path, flags] = args;
    const result = openSync(...args);
    if (typeof path === "string" && flags === "wx" && (dir ? dirname(path) === dir : path.endsWith(".tmp"))) {
      fd = result;
      probe = path;
    }
    return result;
  });
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof writeFileSync>) => {
    writeFileSync(...args);
    if (typeof args[0] === "number" && args[0] === fd) options.write?.(args[0]);
  });
  t.mock.method(fs, "closeSync", (closing: number) => {
    closeSync(closing);
    if (closing === fd) {
      fd = undefined;
      options.close?.();
    }
  });
  t.mock.method(fs, "unlinkSync", (path: fs.PathLike) => {
    if (path === probe) options.remove?.();
    unlinkSync(path);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { path: () => probe };
}

const guardTestTimeoutMs = 8_000;

test("the session clock guard separates an immediate kickoff write from the parent write", { timeout: guardTestTimeoutMs }, async (t) => {
  const { dir, parent, parentFile } = diskHandoff(t);
  const successor = SessionManager.create("/tmp", dir);
  const successorFile = successor.getSessionFile()!;
  const parentTick = 1_800_000_000;
  let tick = parentTick;
  let polls = 0;
  // The first probe shares the parent time. The clock advances only when the event loop runs.
  mockProbe(t, dir, { write(fd) {
    fs.futimesSync(fd, tick, tick);
    if (++polls === 1) setImmediate(() => { tick = parentTick + 2; });
  } });
  const append = parent.manager.appendCustomEntry.bind(parent.manager);
  t.mock.method(parent.manager, "appendCustomEntry", (name: string, data: unknown) => {
    const entry = append(name, data);
    fs.utimesSync(parentFile, parentTick, parentTick);
    return entry;
  });

  let parentAtKickoff: Buffer | undefined;
  const { child, turns } = await transfer(parent, { successor, run: () => {
    parentAtKickoff = readFileSync(parentFile);
    appendKickoffReply(successor);
    fs.utimesSync(successorFile, tick, tick);
  } }, "track-boundary");

  assert.equal(turns, 1);
  assert.doesNotMatch(child.warnings.join("\n"), /kickoff failed|handoff.*clock/i);
  assert.ok(parentAtKickoff?.equals(readFileSync(parentFile)), "the parent file must not change after kickoff starts");
  assert.ok(statSync(parentFile).mtimeMs < statSync(successorFile).mtimeMs,
    "the clock guard must make the immediate successor write strictly newer");
  assert.equal(SessionManager.continueRecent("/tmp", dir).getSessionFile(), successorFile);
  assert.deepEqual(readdirSync(dir).sort(), [basename(parentFile), basename(successorFile)].sort(),
    "only the session files may remain after a successful handoff");
});

test("session clock polling expiry reports the limit and does not stop kickoff", { timeout: guardTestTimeoutMs }, async (t) => {
  const { dir, parent, parentFile } = diskHandoff(t);
  parent.store.paused = true;
  parent.store.pauseReason = "context-budget";
  mockProbe(t, dir, { write(fd) { fs.futimesSync(fd, 1, 1); } });
  const { child, turns } = await transfer(parent, {}, "context-budget");
  assert.equal(turns, 1, "clock polling expiry must not skip kickoff");
  assert.match(child.warnings.join("\n"), /clock did not advance within the 3-second polling limit/);
  assert.doesNotMatch([...parent.warnings, ...child.warnings].join("\n"), /handoff failed|pause cleared/i);
  assert.equal(parent.store.paused, true);
  assert.equal(parent.store.pauseReason, "context-budget");
  assert.equal(child.store.paused, false);
  assert.deepEqual(readdirSync(dir), [basename(parentFile)], "clock polling expiry must remove the probe");
});

test("the guard still runs after a failed marker write and cleans up a failed probe write", { timeout: guardTestTimeoutMs }, async (t) => {
  const { dir, parent, parentFile } = diskHandoff(t);
  const append = parent.manager.appendCustomEntry.bind(parent.manager);
  t.mock.method(parent.manager, "appendCustomEntry", (name: string, data: unknown) => {
    if (name === "slate-handoff-purpose" && (data as { consumed?: boolean }).consumed) {
      throw new Error("marker write refused");
    }
    return append(name, data);
  });
  mockProbe(t, dir, { write() { throw new Error("probe write refused"); } });
  const { child, turns } = await transfer(parent);
  assert.equal(turns, 1);
  assert.match(child.warnings.join("\n"), /handoff purpose as consumed.*marker write refused\n.*session file clock.*probe write refused/);
  assert.doesNotMatch([...parent.warnings, ...child.warnings].join("\n"), /handoff failed|pause cleared/i);
  assert.deepEqual(readdirSync(dir), [basename(parentFile)]);
});

test("probe cleanup reports close and delete errors without stopping kickoff", { timeout: guardTestTimeoutMs }, async (t) => {
  const { dir, parent } = diskHandoff(t);
  mockProbe(t, dir, {
    write(fd) { fs.futimesSync(fd, 1_900_000_000, 1_900_000_000); },
    close() { throw new Error("probe close refused"); },
    remove() { throw new Error("probe delete refused"); },
  });
  const { child, turns } = await transfer(parent);
  assert.equal(turns, 1);
  assert.match(child.warnings.join("\n"), /could not close.*probe close refused\n.*could not delete.*probe delete refused/);
  assert.doesNotMatch([...parent.warnings, ...child.warnings].join("\n"), /handoff failed|pause cleared/i);
});

for (const session of ["in-memory", "not yet persisted"] as const) {
  test(`the session clock guard skips a ${session} parent`, { timeout: 2_000 }, async (t) => {
    const disk = session === "not yet persisted" ? diskHandoff(t, false) : undefined;
    const parent = disk?.parent ?? fixture();
    const probe = mockProbe(t, disk?.dir);
    const { child, turns } = await transfer(parent);
    assert.equal(turns, 1);
    assert.equal(probe.path(), undefined, "a parent with no file needs no probe or polling wait");
    assert.doesNotMatch(child.warnings.join("\n"), /handoff.*clock/i);
    if (disk) assert.deepEqual(readdirSync(disk.dir), []);
  });
}

test("a failed purpose marker write reports the failure without interrupting kickoff", { timeout: 2000 }, async (t) => {
  const parent = fixture();
  parent.store.paused = true;
  parent.store.pauseReason = "context-budget";
  const append = parent.manager.appendCustomEntry.bind(parent.manager);
  t.mock.method(parent.manager, "appendCustomEntry", (name: string, data: unknown) => {
    if (name === "slate-handoff-purpose" && (data as { consumed?: boolean }).consumed) {
      throw new Error("marker write refused");
    }
    return append(name, data);
  });
  const { child, turns } = await transfer(parent, {}, "track-boundary");
  assert.equal(turns, 1);
  assert.match(child.warnings.join("\n"), /could not record.*handoff purpose.*marker write refused/);
  assert.doesNotMatch([...parent.warnings, ...child.warnings].join("\n"), /handoff failed|pause cleared/i);
  assert.equal(parent.store.paused, true);
  assert.equal(parent.store.pauseReason, "context-budget");
});

test("adoption gates the hidden kickoff and resume delivers it once across reload", { timeout: 2000 }, async () => {
  const { child, turns } = await transfer(fixture(), { allowed: false }, "track-boundary");
  assert.equal(turns, 0);
  assert.equal(child.messages.some((m) => m.customType === "slate-kickoff"), false);
  assert.match(child.warnings.join("\n"), /Choose a permitted model and effort, then run \/slate resume/);
  const resumed = fixture(child.manager);
  resumed.store.restore(resumed.ctx);
  assert.equal(resumed.store.paused, true);
  assert.equal(await resumed.hooks.resume!(resumed.ctx), true);
  const kickoff = resumed.messages.filter((m) => m.customType === "slate-kickoff");
  assert.equal(kickoff.length, 1);
  assert.equal(kickoff[0].display, false);
  assert.match(kickoff[0].content, /track-boundary/);
  const reloaded = fixture(child.manager);
  reloaded.store.restore(reloaded.ctx);
  await reloaded.hooks.resume!(reloaded.ctx);
  assert.equal(reloaded.messages.some((m) => m.customType === "slate-kickoff"), false);
});

test("successful adoption starts exactly one hidden kickoff and consumes the inherited purpose", { timeout: 2000 }, async () => {
  const { child, turns } = await transfer(fixture(), {}, "track-boundary");
  assert.equal(turns, 1);
  assert.equal(child.messages.filter((m) => m.customType === "slate-pause").length, 0);
  assert.equal(child.messages.filter((m) => m.customType === "slate-kickoff").length, 1);
  const first = child.messages.find((m) => m.customType === "slate-kickoff");
  assert.equal(first.display, false);
  const claims = child.messages.filter((m) => m.customType === "slate-kickoff-claimed");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].display, false);
  assert.match(first.content, /track-boundary/);
  const next = await transfer(child);
  assert.equal(next.turns, 1);
  const second = next.child.messages.find((m) => m.customType === "slate-kickoff");
  assert.match(second.content, /user-request/);
  assert.doesNotMatch(second.content, /track-boundary|reached its context budget/);
});

const adoptionFailures: [string, RegExp, (child: ReturnType<typeof fixture>) => void][] = [
  ["mapping", /not one unambiguous allowed logical choice/, (c) => { c.routing.runtime = { ...c.runtime, reverseMap: () => ({ kind: "none" }) }; }],
  ["fixed effort", /no allowed fixed effort/, (c) => { c.routing.runtime = { ...c.runtime, effortFor: () => undefined }; }],
  ["busy ownership", /adoption is busy/, (c) => { c.runtime.ownership.acquire("held", SAVED_DEFAULT_RESOURCE_KEY); }],
  ["clamped effort", /clamped effort/, (c) => { c.pi.getThinkingLevel = () => "low"; c.pi.setThinkingLevel = () => {}; }],
  ["effort throw", /could not apply fixed effort.*effort failed/, (c) => {
    c.pi.getThinkingLevel = () => "low";
    c.pi.setThinkingLevel = () => { throw new Error("effort failed"); };
  }],
  ["registry miss", /unknown or no auth/, (c) => { c.ctx.model = undefined; c.ctx.modelRegistry.find = () => undefined; }],
  ["setter false", /unknown or no auth/, (c) => { c.ctx.model = undefined; c.pi.setModel = async () => false; }],
  ["setter throw", /could not restore model.*setter failed/, (c) => {
    c.ctx.model = undefined;
    c.pi.setModel = async () => { throw new Error("setter failed"); };
  }],
  ["unpause save", /could not persist the unpaused handoff state/, (c) => {
    const save = c.store.save.bind(c.store);
    c.store.save = () => { if (!c.store.paused) throw new Error("save failed"); save(); };
  }],
  ["missing identity", /without a usable model identity/, (c) => {
    const branch = c.manager.getBranch();
    const entry = branch.find((e) => e.type === "custom" && e.customType === "slate-handoff");
    assert.ok(entry?.type === "custom");
    delete (entry.data as { model?: unknown }).model;
  }],
  ["unexpected error", /could not adopt successor handoff.*reset failed/, (c) => {
    c.routing.runtime = { ...c.runtime, resetPreferences: () => { throw new Error("reset failed"); } };
  }],
  ["first save", /could not persist restored handoff state/, (c) => { c.store.save = () => { throw new Error("save failed"); }; }],
];
for (const [name, warning, configure] of adoptionFailures) test(`failed adoption: ${name} sends only the required pause`, { timeout: 2000 }, async () => {
  const { child, turns } = await transfer(fixture(), { configure });
  assert.equal(child.store.paused, true);
  assert.equal(child.store.pauseReason, "adoption");
  assert.match(child.warnings.join("\n"), warning);
  assert.equal(turns, 0);
  assert.equal(child.messages.filter((m) => m.customType === "slate-kickoff").length, 0);
  const pauses = child.messages.filter((m) => m.customType === "slate-pause");
  assert.equal(pauses.length, name === "first save" ? 0 : 1);
  if (pauses.length) assert.deepEqual(pauses[0], {
    customType: "slate-pause",
    content: "Handoff model adoption is pending. While paused, do not start a turn. Choose a permitted model and effort, then run /slate resume. Disregard this pause after adoption or resume succeeds.",
    display: false,
  });
});

for (const interrupted of ["cancel", "idle-failure", "transfer-failure", "setup-failure"] as const) test(`${interrupted} and restart retain only the same boundary purpose for retry`, { timeout: 2000 }, async () => {
  const parent = fixture();
  parent.ctx.newSession = async (request: any) => {
    if (interrupted === "transfer-failure") throw new Error("transfer failed");
    if (interrupted === "setup-failure") {
      const manager = SessionManager.inMemory("/tmp");
      manager.appendCustomEntry = () => { throw new Error("setup failed"); };
      await request.setup(manager);
    }
    return { cancelled: true };
  };
  parent.ctx.waitForIdle = async () => { if (interrupted === "idle-failure") throw new Error("idle failed"); };
  if (interrupted === "cancel") await parent.hooks.startHandoff(parent.ctx, undefined, undefined, "post-check");
  else await assert.rejects(parent.hooks.startHandoff(parent.ctx, undefined, undefined, "post-check"), /failed/);
  const restarted = fixture(parent.manager);
  restarted.store.restore(restarted.ctx);
  const { child } = await transfer(restarted);
  assert.match(child.messages.find((m) => m.customType === "slate-kickoff").content, /post-check/);
});

test("a budget pause and boundary purpose both appear without changing old state causes", { timeout: 2000 }, async () => {
  const parent = fixture();
  parent.store.paused = true;
  parent.store.pauseReason = "context-budget";
  const result = await transfer(parent, {}, "track-boundary");
  const text = result.child.messages.find((m) => m.customType === "slate-kickoff").content;
  assert.match(text, /track-boundary/);
  assert.match(text, /reached its context budget/);
  const old = fixture();
  const snapshot = old.store.snapshot();
  delete snapshot.pauseReason;
  old.store.adoptSnapshot(snapshot, old.ctx);
  assert.equal(old.store.pauseReason, undefined);
  const plain = await transfer(old);
  assert.doesNotMatch(plain.child.messages.find((m) => m.customType === "slate-kickoff").content, /reached its context budget/);
});

test("failed unpause save retains the kickoff and cannot duplicate it after reload", { timeout: 2000 }, async () => {
  const { child, turns } = await transfer(fixture(), { failSave: true });
  assert.equal(turns, 0);
  const resumed = fixture(child.manager);
  resumed.store.restore(resumed.ctx);
  assert.equal(resumed.store.paused, true);
  await resumed.hooks.resume!(resumed.ctx);
  await resumed.hooks.resume!(resumed.ctx);
  assert.equal(resumed.messages.filter((m) => m.customType === "slate-kickoff").length, 1);
});

test("shared-route adoption and failed unpause save resume with the trusted identity exactly once", { timeout: 2000 }, async () => {
  const { child, turns } = await transfer(fixture(), { shared: true, failSave: true });
  assert.equal(turns, 0);
  assert.equal(child.store.paused, true);
  assert.equal(child.base.currentLogicalIdentity(), "luna-6");
  assert.equal(await child.hooks.resume!(child.ctx), true);
  assert.equal(await child.hooks.resume!(child.ctx), true);
  assert.equal(child.messages.filter((m) => m.customType === "slate-kickoff").length, 1);
});

for (const invalid of ["runtime", "model", "unmapped", "ambiguous", "effort"] as const) test(`adoption resume refuses invalid ${invalid} without claiming the pending kickoff`, { timeout: 2000 }, async () => {
  const { child } = await transfer(fixture(), { allowed: false });
  const resumed = fixture(child.manager, invalid !== "runtime", invalid === "ambiguous", invalid !== "ambiguous");
  resumed.store.restore(resumed.ctx);
  if (invalid === "model") resumed.ctx.model = undefined;
  if (invalid === "unmapped") resumed.ctx.model = { provider: "unknown", id: "unknown" };
  if (invalid === "effort") resumed.pi.setThinkingLevel("low");
  assert.equal(await resumed.hooks.resume!(resumed.ctx), false);
  assert.equal(resumed.store.paused, true);
  assert.equal(resumed.store.pauseReason, "adoption");
  const durable = fixture(child.manager);
  durable.store.restore(durable.ctx);
  assert.equal(durable.store.paused, true);
  assert.match(resumed.warnings.join("\n"), /Choose a permitted model and effort, then run \/slate resume/);
  assert.equal(resumed.messages.length, 0);
  assert.equal(child.manager.getBranch().some((e) => e.type === "custom_message" && e.customType === "slate-kickoff-claimed"), false);
  assert.equal(await durable.hooks.resume!(durable.ctx), true);
  assert.equal(durable.messages.filter((m) => m.customType === "slate-kickoff").length, 1);
});

test("budget and unpaused resume accept unmapped models without a runtime", { timeout: 2000 }, async () => {
  const parent = fixture(undefined, false);
  parent.ctx.model = { provider: "custom", id: "custom" };
  parent.store.paused = true;
  parent.store.pauseReason = "context-budget";
  assert.equal(await parent.hooks.resume!(parent.ctx), true);
  assert.equal(parent.store.paused, false);
  assert.equal(parent.store.pauseReason, undefined);
  assert.equal(await parent.hooks.resume!(parent.ctx), true);
});

test("resume save failure restores the durable adoption pause and sends nothing", { timeout: 2000 }, async () => {
  const { child } = await transfer(fixture(), { allowed: false });
  const resumed = fixture(child.manager);
  resumed.store.restore(resumed.ctx);
  resumed.store.save = () => { throw new Error("resume save refused"); };
  assert.equal(await resumed.hooks.resume!(resumed.ctx), false);
  assert.equal(resumed.store.paused, true);
  assert.equal(resumed.store.pauseReason, "adoption");
  assert.match(resumed.warnings.join("\n"), /could not save.*resume save refused.*\/slate resume to retry/);
  assert.equal(resumed.messages.length, 0);
  const durable = fixture(child.manager);
  durable.store.restore(durable.ctx);
  assert.equal(durable.store.paused, true);
  assert.equal(await durable.hooks.resume!(durable.ctx), true);
  assert.equal(durable.messages.filter((m) => m.customType === "slate-kickoff").length, 1);
});

test("revisiting a successfully transferred parent does not reuse its purpose", { timeout: 2000 }, async () => {
  const parent = fixture();
  await transfer(parent, {}, "track-boundary");
  const revisited = fixture(parent.manager);
  const { child } = await transfer(revisited);
  const text = child.messages.find((m) => m.customType === "slate-kickoff").content;
  assert.match(text, /user-request/);
  assert.doesNotMatch(text, /track-boundary/);
});

for (const failed of [false, true]) test(`budget pause cleared by ${failed ? "failure" : "cancel"} leaves no later budget cause`, { timeout: 2000 }, async () => {
  const parent = fixture();
  parent.store.paused = true;
  parent.store.pauseReason = "context-budget";
  parent.ctx.newSession = async () => { if (failed) throw new Error("replacement failed"); return { cancelled: true }; };
  if (failed) await assert.rejects(parent.hooks.startHandoff(parent.ctx), /replacement failed/);
  else await parent.hooks.startHandoff(parent.ctx);
  assert.equal(parent.store.paused, false);
  assert.equal(parent.store.pauseReason, undefined);
  const { child } = await transfer(parent);
  assert.doesNotMatch(child.messages.find((m) => m.customType === "slate-kickoff").content, /reached its context budget/);
});

test("fresh kickoff rejection reports through the fresh context and never replays", { timeout: 2000 }, async () => {
  const parent = fixture();
  const { child, turns } = await transfer(parent, { reject: true });
  assert.equal(turns, 0);
  assert.match(child.warnings.join("\n"), /kickoff failed:.*fresh send refused/);
  assert.doesNotMatch(parent.warnings.join("\n"), /kickoff failed/);
  const reloaded = fixture(child.manager);
  reloaded.store.restore(reloaded.ctx);
  await reloaded.hooks.resume!(reloaded.ctx);
  assert.equal(reloaded.messages.some((m) => m.customType === "slate-kickoff"), false);
});
