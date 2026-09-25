import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, permitsSlateConfig } from "../extension/config.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";
import { SlateStore } from "../extension/state.ts";
import { ThreadManager } from "../extension/threads.ts";
import { registerSlateTools } from "../extension/tools.ts";
import { createRuntimeStorageFolder } from "../extension/artifact-names.ts";
import { openWorkerSession, type WorkerSession } from "../extension/worker.ts";
import { createWorkerExtensionResolver } from "../extension/worker-extensions.ts";

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    model: undefined,
    modelRegistry: {
      find(provider: string, id: string) { return provider === "test" && id === "worker" ? { provider, id, reasoning: false } : undefined; },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; },
      hasConfiguredAuth() { return true; },
      async getAvailable() { return []; },
      getRegisteredProviderIds: () => [],
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    },
  } as unknown as ExtensionContext;
}

function fixture(root: string, body: string): string {
  const path = join(root, `fixture-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(path, body);
  return path;
}

async function isolatedWorkerTest(
  _t: test.TestContext,
  run: (root: string, reports: string[]) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "slate-worker-lifecycle-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_OFFLINE = "1";
  const reports: string[] = [];
  try {
    await run(root, reports);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    rmSync(root, { recursive: true, force: true });
  }
}

test("Pi worker session creation refuses a symbolic-link runtime parent", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const folder = createRuntimeStorageFolder();
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(root, ".pi", "slate"), { recursive: true });
    symlinkSync(outside, join(root, ".pi", "slate", folder));
    await assert.rejects(openWorkerSession({ ctx: context(root), runtimeFolder: folder }), /artifact directory because that path is a symbolic link/);
    assert.deepEqual(readdirSync(outside), [], "Pi received no transcript folder outside the project");
  });
});

const tool = (name: string, text: string) => `({
  name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)}, description: ${JSON.stringify(text)},
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() { return { content: [{ type: "text", text: ${JSON.stringify(text)} }], details: {} }; }
})`;

test("home settings reach a real manager worker without trusting project settings or instructions", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const agent = process.env.PI_CODING_AGENT_DIR!;
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(root, ".pi"), { recursive: true });
    const settings = '{"defaultProvider":"test","defaultModel":"home-default"}';
    writeFileSync(join(agent, "settings.json"), settings);
    writeFileSync(join(agent, "worker.md"), "HOME WORKER DOCUMENT");
    writeFileSync(join(agent, "AGENTS.md"), "HOME AGENTS CONTEXT");
    writeFileSync(join(root, "AGENTS.md"), "PROJECT AGENTS CONTEXT");
    writeFileSync(join(root, ".pi", "SYSTEM.md"), "UNTRUSTED SYSTEM OVERRIDE");
    writeFileSync(join(root, ".pi", "settings.json"), '{"defaultModel":"untrusted-default"}');
    writeFileSync(join(root, ".pi", "slate.json"), '{"workerPromptDocs":["evil.md"],"router":null}');
    const marker = join(root, "home-worker.txt");
    const path = fixture(root, `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerTool(${tool("home_fixture", "home extension")});
  pi.on("session_start", (_event, ctx) => {
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ trusted: ctx.isProjectTrusted(), prompt: ctx.getSystemPrompt() }));
    throw new Error("stop before any provider request");
  });
}`);
    writeFileSync(join(agent, "slate.json"), JSON.stringify({ workerPromptDocs: ["worker.md"], workerExtensions: ["fixture"], router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, costRating: 50, effort: "off", preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }] } } }));
    const ctx = context(root);
    ctx.isProjectTrusted = () => false;
    const config = loadConfig(root, false, assert.fail);
    const host = { getAllTools: () => [{ name: "home_fixture", description: "home extension", sourceInfo: { source: "fixture", origin: "path", path } }] } as unknown as ExtensionAPI;
    const extensions = createWorkerExtensionResolver(host, () => config.workerExtensions ?? [], assert.fail);
    assert.deepEqual(extensions().paths, [path]);
    const manager = new ThreadManager(
      new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI), config, extensions,
      createLogicalRuntime({ trusted: permitsSlateConfig(config, false), projectConfig: config }),
    );
    try {
      const result = await manager.dispatch({ model: "fixture", reason: "home config fixture", task: "capture startup", type: "general" }, ctx, undefined);
      assert.equal(result.episode.status, "failed");
      assert.match(result.episodeText, /stop before any provider request/);
      const captured = JSON.parse(readFileSync(marker, "utf8"));
      assert.equal(captured.trusted, false);
      assert.match(captured.prompt, /HOME WORKER DOCUMENT/);
      assert.match(captured.prompt, /HOME AGENTS CONTEXT/);
      assert.match(captured.prompt, /PROJECT AGENTS CONTEXT/);
      assert.match(captured.prompt, /Do not use semicolons or contractions/);
      assert.doesNotMatch(captured.prompt, /UNTRUSTED SYSTEM OVERRIDE/);
      assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), settings);
    } finally { await manager.disposeAll(); }
  });
});

test("trusted workers preserve home and project AGENTS context without home Slate settings", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const agent = process.env.PI_CODING_AGENT_DIR!;
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "AGENTS.md"), "HOME AGENTS CONTEXT");
    writeFileSync(join(root, "AGENTS.md"), "PROJECT AGENTS CONTEXT");
    const config = loadConfig(root, true, assert.fail);
    const session = await openWorkerSession({ ctx: context(root), config });
    try {
      assert.match(session.systemPrompt, /HOME AGENTS CONTEXT/);
      assert.match(session.systemPrompt, /PROJECT AGENTS CONTEXT/);
      assert.equal(existsSync(join(agent, "slate.json")), false);
    } finally { await session.shutdownWorker(); }
  });
});

test("standalone untrusted workers reject JSON permission flags and supplied content", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const doc = join(root, "role.md");
    const marker = join(root, "extension-ran");
    writeFileSync(doc, "FORGED WORKER DOCUMENT");
    const path = fixture(root, `import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(marker)}, "ran"); }`);
    const ctx = context(root);
    ctx.isProjectTrusted = () => false;
    const config = JSON.parse('{"trusted":true,"homeOnly":true}');
    config.workerPromptDocs = [doc];
    const session = await openWorkerSession({ ctx, config, promptDocs: [doc], extensionPaths: [path] });
    try {
      assert.doesNotMatch(session.agent.state.systemPrompt, /FORGED WORKER DOCUMENT|Do not use semicolons or contractions/);
      assert.equal(existsSync(marker), false);
    } finally { await session.shutdownWorker(); }
  });
});

test("real worker startup activates factory and session_start tools, keeps Slate tools excluded, and shuts down once", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root, reports) => {
    const marker = join(root, "shutdown.txt");
    const path = fixture(root, `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.registerTool(${tool("factory_tool", "factory ok")});
  pi.on("session_start", () => { pi.registerTool(${tool("startup_tool", "startup ok")}); });
  pi.on("session_shutdown", () => { appendFileSync(${JSON.stringify(marker)}, "shutdown\\n"); });
}`);
    const session = await openWorkerSession({
      ctx: context(root),
      extensionPaths: [path],
      extensionToolNames: ["factory_tool", "startup_tool", "thread"],
      report: (message) => reports.push(message),
    });
    const active = session.agent.state.tools.map((entry) => entry.name);
    assert.ok(active.includes("factory_tool"));
    assert.ok(active.includes("startup_tool"));
    assert.equal(active.includes("thread"), false);
    const startup = session.agent.state.tools.find((entry) => entry.name === "startup_tool");
    assert.ok(startup);
    const result = await startup.execute("call", {}, undefined, undefined);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, "startup ok");
    await Promise.all([session.shutdownWorker(), session.shutdownWorker()]);
    assert.equal(readFileSync(marker, "utf8"), "shutdown\n");
    assert.deepEqual(reports, []);
  });
});

test("action ownership starts before session_start and managed operations leave the active set", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const marker = join(root, "early-boundary.txt");
    const path = fixture(root, `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => {
    pi.sendMessage({ customType: "fixture", content: "startup aside", display: false }, { deliverAs: "nextTurn" });
    writeFileSync(${JSON.stringify(marker)}, "started");
  });
}`);
    let callbackSawStartup = true;
    const session = await openWorkerSession({
      ctx: context(root),
      extensionPaths: [path],
      onCreated: () => { callbackSawStartup = existsSync(marker); },
    });
    assert.equal(callbackSawStartup, false, "the owner callback runs before session_start");
    assert.equal(readFileSync(marker, "utf8"), "started");
    assert.equal(session.activeManagedOperationCount(), 0, "settled startup operations are removed");
    for (let index = 0; index < 25; index++) {
      await session.sendCustomMessage(
        { customType: "fixture", content: `settled-${index}`, display: false },
        { deliverAs: "nextTurn" },
      );
      assert.equal(session.activeManagedOperationCount(), 0, "settled operations do not form a lifetime list");
    }

    let entered!: () => void;
    let release!: () => void;
    const operationEntered = new Promise<void>((resolve) => { entered = resolve; });
    const operationGate = new Promise<void>((resolve) => { release = resolve; });
    session.prompt = async () => {
      entered();
      await operationGate;
    };
    const held = session.sendUserMessage("held managed operation");
    await operationEntered;
    assert.equal(session.activeManagedOperationCount(), 1, "only the held operation remains active");

    let abortCalls = 0;
    const originalAbort = session.abort.bind(session);
    session.abort = async () => { abortCalls++; await originalAbort(); };
    let settlementFinished = false;
    const settlement = session.settleManagedOperations().then(() => { settlementFinished = true; });
    await Promise.resolve();
    assert.equal(settlementFinished, false, "settlement waits for admitted work");
    await assert.rejects(
      session.sendCustomMessage({ customType: "fixture", content: "late", display: false }, { deliverAs: "nextTurn" }),
      /lifecycle is closed/,
    );
    assert.equal(session.activeManagedOperationCount(), 1, "post-closure work is rejected before delegation");
    release();
    await held;
    await settlement;
    assert.equal(abortCalls, 1, "settlement requests the real Pi abort before it finishes");
    assert.equal(session.activeManagedOperationCount(), 0);
    await session.shutdownWorker();
  });
});

test("startup waits for an unawaited admitted message call and cancellation joins the wait", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const path = fixture(root, `export default function (pi) {
  pi.on("session_start", () => { pi.sendUserMessage("unawaited startup turn"); });
}`);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let created!: WorkerSession;
    const opening = openWorkerSession({
      ctx: context(root), extensionPaths: [path],
      onCreated(session) {
        created = session;
        session.prompt = async () => { entered(); await gate; };
        const abort = session.abort.bind(session);
        session.abort = async () => { release(); await abort(); };
      },
    });
    try {
      await started;
      let returned = false;
      void opening.then(() => { returned = true; }, () => { returned = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(returned, false, "startup may not return while its unawaited call runs");
      assert.equal(created.activeManagedOperationCount(), 1, "the admitted startup call remains live behind the gate");
      created.closeManagedOperations();
      await created.settleManagedOperations();
      assert.equal(returned, true, "abort releases the waiting startup call");
      const session = await opening;
      assert.equal(session.activeManagedOperationCount(), 0);
      await session.shutdownWorker();
    } finally {
      release();
      await created.shutdownWorker();
    }
  });
});

test("startup drains a message call admitted by a completed startup call", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const path = fixture(root, `export default function (pi) {
  pi.on("session_start", () => { pi.sendUserMessage("first startup call"); });
  pi.on("agent_end", () => { pi.sendUserMessage("chained startup call"); });
}`);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let secondEntered!: () => void;
    const chained = new Promise<void>((resolve) => { secondEntered = resolve; });
    let created!: WorkerSession;
    let prompts = 0;
    const opening = openWorkerSession({
      ctx: context(root), extensionPaths: [path],
      onCreated(session) {
        created = session;
        // The first idle observation admits a further call through agent_end.
        // A single snapshot cannot include that call before Pi announces idle.
        let notified = false;
        session.waitForIdle = async () => {
          if (!notified) {
            notified = true;
            await session.extensionRunner.emit({ type: "agent_end", messages: [] });
          }
        };
        session.prompt = async () => {
          prompts++;
          if (prompts === 1) {
            await firstGate;
          } else {
            secondEntered();
            await secondGate;
          }
        };
        const abort = session.abort.bind(session);
        session.abort = async () => { releaseFirst(); releaseSecond(); await abort(); };
      },
    });
    try {
      releaseFirst();
      await chained;
      assert.equal(prompts, 2, "agent_end admitted a further startup call");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(created.activeManagedOperationCount(), 1, "the chained call stays active");
      let opened = false;
      void opening.then(() => { opened = true; }, () => { opened = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(opened, false, "opening waits for the chained operation");
      releaseSecond();
      const session = await opening;
      assert.equal(session.activeManagedOperationCount(), 0);
      await session.shutdownWorker();
    } finally {
      releaseFirst();
      releaseSecond();
      await created.shutdownWorker();
    }
  });
});

test("real worker startup failure blocks the worker and still runs shutdown", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root, reports) => {
    const marker = join(root, "failed-shutdown.txt");
    const path = fixture(root, `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => { throw new Error("startup exploded"); });
  pi.on("session_shutdown", () => { writeFileSync(${JSON.stringify(marker)}, "closed"); });
}`);
    await assert.rejects(
      openWorkerSession({ ctx: context(root), extensionPaths: [path], report: (message) => reports.push(message) }),
      /startup did not complete.*startup exploded/,
    );
    assert.equal(readFileSync(marker, "utf8"), "closed");
    assert.ok(reports.some((message) => /startup failed.*startup exploded/.test(message)));
  });
});

test("real worker leaves an unselected startup tool inactive", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const path = fixture(root, `export default function (pi) {
  pi.on("session_start", () => { pi.registerTool(${tool("startup_tool", "not selected")}); });
}`);
    const session = await openWorkerSession({
      ctx: context(root),
      extensionPaths: [path],
      extensionToolNames: [],
    });
    try {
      assert.equal(session.agent.state.tools.some((entry) => entry.name === "startup_tool"), false);
    } finally {
      await session.shutdownWorker();
    }
  });
});

test("real worker refuses a pi built-in registered during session_start", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root, reports) => {
    const path = fixture(root, `export default function (pi) {
  pi.on("session_start", () => { pi.registerTool(${tool("read", "shadow")}); });
}`);
    await assert.rejects(
      openWorkerSession({ ctx: context(root), extensionPaths: [path], extensionToolNames: ["read"], report: (message) => reports.push(message) }),
      /registered tool\(s\) during startup.*pi built-in.*read/,
    );
  });
});

test("real worker refuses a Slate tool registered during session_start", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const path = fixture(root, `export default function (pi) {
  pi.on("session_start", () => { pi.registerTool(${tool("thread", "shadow")}); });
}`);
    await assert.rejects(
      openWorkerSession({ ctx: context(root), extensionPaths: [path], extensionToolNames: ["thread"] }),
      /registered tool\(s\) during startup.*slate or pi built-in.*thread/,
    );
  });
});

test("startup failure remains the primary error when shutdown overlaps", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root, reports) => {
    const marker = join(root, "race-shutdown.txt");
    const path = fixture(root, `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", async () => { await new Promise((resolve) => setTimeout(resolve, 20)); throw new Error("startup race exploded"); });
  pi.on("session_shutdown", () => { writeFileSync(${JSON.stringify(marker)}, "closed"); });
}`);
    let shutdown: Promise<void> | undefined;
    await assert.rejects(
      openWorkerSession({
        ctx: context(root),
        extensionPaths: [path],
        report: (message) => reports.push(message),
        onCreated: (created) => { shutdown = created.shutdownWorker(); },
      }),
      /startup did not complete.*startup race exploded/,
    );
    await shutdown;
    assert.equal(readFileSync(marker, "utf8"), "closed");
    assert.ok(reports.some((message) => /startup failed.*startup race exploded/.test(message)));
    assert.equal(reports.some((message) => /shutdown failed.*startup race exploded/.test(message)), false);
  });
});

test("shutdown waits for in-flight startup and reports a shutdown handler failure", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root, reports) => {
    const marker = join(root, "ordered.txt");
    const path = fixture(root, `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", async () => { appendFileSync(${JSON.stringify(marker)}, "start\\n"); await Promise.resolve(); appendFileSync(${JSON.stringify(marker)}, "started\\n"); });
  pi.on("session_shutdown", () => { appendFileSync(${JSON.stringify(marker)}, "shutdown\\n"); throw new Error("shutdown exploded"); });
}`);
    let shutdown: Promise<void> | undefined;
    const session = await openWorkerSession({
      ctx: context(root),
      extensionPaths: [path],
      report: (message) => reports.push(message),
      onCreated: (created) => { shutdown = created.shutdownWorker(); },
    });
    await shutdown;
    await session.shutdownWorker();
    assert.equal(readFileSync(marker, "utf8"), "start\nstarted\nshutdown\n");
    assert.equal(reports.filter((message) => /shutdown failed.*shutdown exploded/.test(message)).length, 1);
  });
});

test("shutdown emission failure is reported and disposal still completes", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root, reports) => {
    const path = fixture(root, "export default function () {}\n");
    let disposed = 0;
    const session = await openWorkerSession({
      ctx: context(root),
      extensionPaths: [path],
      report: (message) => reports.push(message),
      onCreated: (created) => {
        const emit = created.extensionRunner.emit.bind(created.extensionRunner);
        created.extensionRunner.emit = async (event) => {
          if (event.type === "session_shutdown") throw new Error("emit exploded");
          return emit(event);
        };
        created.dispose = () => { disposed++; };
      },
    });
    await session.shutdownWorker();
    assert.equal(disposed, 1);
    assert.equal(reports.filter((message) => /shutdown failed.*emit exploded/.test(message)).length, 1);
  });
});

test("disposal failure is reported after shutdown without rejecting cleanup", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root, reports) => {
    const path = fixture(root, "export default function () {}\n");
    const session = await openWorkerSession({
      ctx: context(root),
      extensionPaths: [path],
      report: (message) => reports.push(message),
      onCreated: (created) => {
        created.dispose = () => { throw new Error("dispose exploded"); };
      },
    });
    await session.shutdownWorker();
    assert.equal(reports.filter((message) => /disposal failed.*dispose exploded/.test(message)).length, 1);
  });
});

test("a throwing lifecycle report sink falls back without changing startup failure", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const path = fixture(root, `export default function (pi) {
  pi.on("session_start", () => { throw new Error("reported startup failure"); });
}`);
    const originalWarn = console.warn;
    const fallback: string[] = [];
    console.warn = (message?: unknown) => fallback.push(String(message));
    try {
      await assert.rejects(
        openWorkerSession({
          ctx: context(root),
          extensionPaths: [path],
          report: () => { throw new Error("report sink failed"); },
        }),
        /startup did not complete.*reported startup failure/,
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(fallback.some((message) => /startup failed.*reported startup failure/.test(message)));
  });
});

test("manager teardown owns an opening worker and all callers await cleanup", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    const started = join(root, "manager-started.txt");
    const release = join(root, "manager-release.txt");
    const stopped = join(root, "manager-stopped.txt");
    const path = fixture(root, `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(started)}, "started\\n");
while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 5));
export default function (pi) {
  pi.on("session_shutdown", () => { appendFileSync(${JSON.stringify(stopped)}, "stopped\\n"); });
}`);
    const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, costRating: 50, effort: "off", preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }] } } } });
    const manager = new ThreadManager(
      new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI),
      {},
      () => ({ units: [], paths: [path], toolNames: [] }),
      runtime,
    );
    const dispatch = manager.dispatch({ model: "fixture", reason: "lifecycle fixture", task: "opening teardown", type: "general" }, context(root), undefined);
    for (let tries = 0; tries < 200; tries++) {
      try { readFileSync(started); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    assert.equal(readFileSync(started, "utf8"), "started\n");
    let firstSettled = false;
    let secondSettled = false;
    const first = manager.disposeAll().then(() => { firstSettled = true; });
    const second = manager.disposeAll().then(() => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const firstReturnedEarly = firstSettled;
    const secondReturnedEarly = secondSettled;
    writeFileSync(release, "release");
    await Promise.all([first, second]);
    await assert.rejects(dispatch, /cancelled during session teardown/);
    assert.equal(readFileSync(stopped, "utf8"), "stopped\n");
    assert.equal(firstReturnedEarly, false);
    assert.equal(secondReturnedEarly, false);
    const view = manager as unknown as { live: Map<string, WorkerSession> };
    assert.equal(view.live.size, 0);
  });
});

test("shutdown excludes independent background tasks while managed calls remain joined", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root) => {
    let backgroundEntered!: () => void;
    let releaseBackground!: () => void;
    let backgroundFinished!: () => void;
    const entered = new Promise<void>((resolve) => { backgroundEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const finished = new Promise<void>((resolve) => { backgroundFinished = resolve; });
    const state = { backgroundEntered, gate, backgroundFinished, completed: false };
    const stateKey = `slate-independent-background:${process.pid}:${Date.now()}:${Math.random()}`;
    const symbol = Symbol.for(stateKey);
    (globalThis as Record<symbol, unknown>)[symbol] = state;
    const path = fixture(root, `const state = globalThis[Symbol.for(${JSON.stringify(stateKey)})];
export default function (pi) {
  pi.on("session_start", () => {
    void (async () => {
      state.backgroundEntered();
      await state.gate;
      state.completed = true;
      state.backgroundFinished();
    })();
  });
}`);
    const session = await openWorkerSession({
      ctx: context(root),
      extensionPaths: [path],
    });
    try {
      await entered;
      await session.shutdownWorker();
      assert.equal(state.completed, false, "independent background work does not delay shutdown");
      releaseBackground();
      await finished;
      assert.equal(state.completed, true);
    } finally {
      releaseBackground();
      await session.shutdownWorker();
      delete (globalThis as Record<symbol, unknown>)[symbol];
    }
  });
});

test("caller cancellation before worker creation closes the onCreated race and cleans the opening", { timeout: 10000 }, async (t) => {
  await isolatedWorkerTest(t, async (root, reports) => {
    let loadEntered!: () => void;
    let releaseLoad!: () => void;
    const entered = new Promise<void>((resolve) => { loadEntered = resolve; });
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const state = { loadEntered, loadGate, startupAttempts: 0, shutdowns: 0 };
    const stateKey = `slate-caller-opening:${process.pid}:${Date.now()}:${Math.random()}`;
    const symbol = Symbol.for(stateKey);
    (globalThis as Record<symbol, unknown>)[symbol] = state;
    const path = fixture(root, `const state = globalThis[Symbol.for(${JSON.stringify(stateKey)})];
state.loadEntered();
await state.loadGate;
export default function (pi) {
  pi.on("session_start", () => {
    state.startupAttempts += 1;
    pi.sendUserMessage("post-cancellation startup work must not reach Pi");
  });
  pi.on("session_shutdown", () => { state.shutdowns += 1; });
}`);
    const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, costRating: 50, effort: "off", preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }] } } } });
    const snapshots: unknown[] = [];
    const store = new SlateStore({
      appendEntry(_customType: string, data: unknown) { snapshots.push(structuredClone(data)); },
    } as unknown as ExtensionAPI);
    const manager = new ThreadManager(
      store,
      {},
      () => ({ units: [], paths: [path], toolNames: [] }),
      runtime,
    );
    const controller = new AbortController();
    const ctx = context(root);
    const dispatch = manager.dispatch(
      { model: "fixture", reason: "caller opening cancellation", task: "opening caller cancellation", type: "general" },
      ctx,
      controller.signal,
    );
    const outcome = dispatch.then(
      () => undefined,
      (error: unknown) => error,
    );
    let bodyError: unknown;
    let cleanupFinished = false;
    const cleanupProbe = "intentional assertion failure after cancellation assertions";
    try {
      await entered;
      const view = manager as unknown as {
        requestContracts: Map<string, { invalidationSignal: AbortSignal; latestAccepted(): unknown }>;
        openingWorkers: Set<Promise<void>>;
        live: Map<string, WorkerSession>;
      };
      const contract = [...view.requestContracts.values()][0];
      assert.ok(contract, "the opening request owner is visible before worker creation");
      controller.abort();
      assert.equal(contract.invalidationSignal.aborted, true, "caller cancellation invalidates the opening owner synchronously");
      assert.equal(contract.latestAccepted(), undefined, "the pre-creation cancellation accepts no request");
      releaseLoad();
      const error = await outcome;
      assert.ok(error instanceof Error);
      assert.match(error.message, /cancelled by the caller/);
      assert.equal(state.startupAttempts, 1, "session_start reaches the closed managed-operation boundary");
      assert.equal(state.shutdowns, 1, "failed opening cleanup emits one shutdown");
      assert.equal(reports.some((message) => /route contract violation/i.test(message)), false);
      assert.equal(view.requestContracts.size, 0);
      assert.equal(view.openingWorkers.size, 0);
      assert.equal(view.live.size, 0);
      assert.equal(store.threads.size, 0);
      assert.equal(store.episodes.size, 0);

      const episodeId = "t1.e1";
      const episodeDir = join(root, ".pi", "slate", store.runtimeFolder, "episodes");
      const episodeFiles = existsSync(episodeDir)
        ? readdirSync(episodeDir).filter((name) => name.endsWith(".md"))
        : [];
      assert.deepEqual(episodeFiles, [], "pre-creation cancellation writes no episode file");
      assert.equal(existsSync(join(episodeDir, `${episodeId}.md`)), false);

      const durableSnapshot = snapshots.at(-1);
      assert.ok(durableSnapshot, "the thread-removal snapshot is saved before restoration");
      const restored = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
      restored.adoptSnapshot(durableSnapshot as Parameters<SlateStore["adoptSnapshot"]>[0], ctx);
      assert.equal(restored.threads.has("t1"), false, "restored state has no cancelled thread");
      assert.equal(restored.episodes.has(episodeId), false, "restored state has no cancelled episode");

      let episodeTool: { execute(...args: unknown[]): Promise<unknown> } | undefined;
      registerSlateTools(
        { registerTool(candidate: { name: string }) { if (candidate.name === "episode") episodeTool = candidate as unknown as typeof episodeTool; } } as unknown as ExtensionAPI,
        restored,
        () => new ThreadManager(restored, {}, undefined, runtime),
      );
      assert.ok(episodeTool, "the production episode tool is registered");
      await assert.rejects(
        episodeTool.execute("call", { id: episodeId }, undefined, undefined, ctx),
        /Unknown episode/,
      );

      const later = new ThreadManager(restored, {}, undefined, runtime);
      const before = restored.threads.size;
      await assert.rejects(
        later.dispatch(
          { model: "fixture", reason: "inverse durable context", task: "later worker context", type: "general", contextEpisodeIds: [episodeId] },
          ctx,
          undefined,
        ),
        /Unknown context episode/,
      );
      assert.equal(restored.threads.size, before, "rejected cancelled context allocates no later thread");
      const laterPrompt = (later as unknown as {
        buildPrompt(opts: { task: string; contextEpisodeIds: string[] }, cwd: string): string;
      }).buildPrompt({ task: "later ordinary action", contextEpisodeIds: [] }, root);
      assert.equal(laterPrompt, "later ordinary action");
      assert.doesNotMatch(laterPrompt, /opening caller cancellation|post-cancellation startup work/);

      assert.fail(cleanupProbe);
    } catch (error) {
      bodyError = error;
    } finally {
      releaseLoad();
      await manager.disposeAll();
      cleanupFinished = true;
      delete (globalThis as Record<symbol, unknown>)[symbol];
    }
    if (!(bodyError instanceof assert.AssertionError) || bodyError.message !== cleanupProbe) throw bodyError;
    assert.equal(cleanupFinished, true, "disposeAll completes after an assertion failure");
    assert.equal(existsSync(root), true, "disposeAll completes before the outer fixture removes the project");
  });
});

test("real Pi keeps independent startup failures and suppresses only their exact aggregate replay", { timeout: 30000 }, async (t) => {
  for (const scenario of ["loader-collision", "collision", "loader", "handlers", "loader-handlers", "repeated-handlers"] as const) {
    await t.test(scenario, { timeout: 10000 }, async (t) => {
      await isolatedWorkerTest(t, async (root) => {
        const controller = new AbortController();
        const state = { cancel: () => controller.abort(), handlers: 0, shutdowns: 0 };
        const symbol = Symbol.for(`slate-startup-reports:${root}`);
        (globalThis as Record<symbol, unknown>)[symbol] = state;
        const stateSource = `const state = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(symbol))})];`;
        const paths: string[] = [];
        if (scenario.includes("loader")) {
          paths.push(fixture(root, `${stateSource}
export default function () { state.cancel(); throw new Error("LOADER_CANARY"); }`));
        }
        if (scenario.includes("collision")) {
          paths.push(fixture(root, `${stateSource}
export default function (pi) { state.cancel(); pi.registerTool(${tool("read", "collision")}); }`));
        }
        if (scenario.includes("handlers")) {
          paths.push(fixture(root, `${stateSource}
export default function (pi) {
  pi.on("session_start", () => { state.cancel(); state.handlers++; throw new Error("HANDLER_CANARY"); });
  pi.on("session_start", () => { state.handlers++; throw new Error(${JSON.stringify(scenario === "repeated-handlers" ? "HANDLER_CANARY" : "SECOND_CANARY")}); });
  pi.on("session_shutdown", () => { state.shutdowns++; });
}`));
        }
        const runtime = createLogicalRuntime({ trusted: true, projectConfig: { router: { models: { include: [], add: [{ model: "fixture", capabilityRating: 50, costRating: 50, effort: "off", preferredProvider: "test", providers: { test: "worker" }, guidelines: [], cautions: [] }] } } } });
        const snapshots: unknown[] = [];
        const store = new SlateStore({
          appendEntry(_customType: string, data: unknown) { snapshots.push(structuredClone(data)); },
        } as unknown as ExtensionAPI);
        const manager = new ThreadManager(store, {}, () => ({ units: [], paths, toolNames: [] }), runtime);
        try {
          await assert.rejects(
            manager.dispatch({ model: "fixture", reason: "independent startup reports", task: "must not prompt", type: "general" }, context(root), controller.signal),
            (error: Error) => {
              assert.match(error.message, /cancelled by the caller/);
              assert.equal(error.message.match(/LOADER_CANARY/g)?.length ?? 0, scenario.includes("loader") ? 1 : 0);
              assert.equal(error.message.match(/overwrite a slate or pi built-in tool/g)?.length ?? 0, scenario.includes("collision") ? 1 : 0);
              assert.equal(error.message.match(/HANDLER_CANARY/g)?.length ?? 0, scenario === "repeated-handlers" ? 2 : scenario.includes("handlers") ? 1 : 0);
              assert.equal(error.message.match(/SECOND_CANARY/g)?.length ?? 0, scenario.includes("handlers") && scenario !== "repeated-handlers" ? 1 : 0);
              assert.doesNotMatch(error.message, /startup did not complete/, "the aggregate must not replay handler failures");
              return true;
            },
          );
          assert.equal(state.handlers, scenario.includes("handlers") ? 2 : 0);
          assert.equal(state.shutdowns, scenario.includes("handlers") ? 1 : 0);
          assert.equal(store.episodes.size, 0);
          const episodeDir = join(root, ".pi", "slate", store.runtimeFolder, "episodes");
          assert.deepEqual(existsSync(episodeDir) ? readdirSync(episodeDir) : [], []);
          const restored = new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
          assert.ok(snapshots.at(-1));
          restored.adoptSnapshot(snapshots.at(-1) as Parameters<SlateStore["adoptSnapshot"]>[0], context(root));
          assert.equal(restored.episodes.size, 0);
          assert.equal(restored.threads.get("t1")?.episodeId, undefined);
        } finally {
          await manager.disposeAll();
          delete (globalThis as Record<symbol, unknown>)[symbol];
        }
      });
    });
  }
});

test("manager host cleanup and terminal cleanup share one shutdown operation", { timeout: 1000 }, async () => {
  const manager = new ThreadManager(new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI), {});
  let shutdownCalls = 0;
  let disposeCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let shared: Promise<void> | undefined;
  const session = {
    shutdownWorker() {
      if (shared) return shared;
      shutdownCalls++;
      shared = gate.then(() => { disposeCalls++; });
      return shared;
    },
    dispose() { disposeCalls++; },
  } as unknown as WorkerSession;
  const view = manager as unknown as {
    live: Map<string, WorkerSession>;
    closeWorker(threadId: string, session: WorkerSession): Promise<void>;
  };
  view.live.set("t1", session);
  const host = manager.disposeAll();
  const terminal = view.closeWorker("t1", session);
  assert.equal(view.live.size, 0);
  assert.equal(shutdownCalls, 1);
  release();
  await Promise.all([host, terminal]);
  assert.equal(shutdownCalls, 1);
  assert.equal(disposeCalls, 1);
});
