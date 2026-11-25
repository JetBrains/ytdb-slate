import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";

import { applyPrivateProjectModel } from "../extension/project-model-startup.ts";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const initial = { provider: "offline", id: "default" };
const stored = { provider: "offline", id: "vendor/stored" };
const spec = "offline/vendor/stored";
const record = { model: spec, thinkingLevel: "high" };
const startup = { type: "session_start", reason: "startup" } as const;
const timeout = { timeout: 5000 };
type Notice = [string, string];

function fixture(t: TestContext) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "slate-project-model-startup-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const agent = join(cwd, "agent");
	mkdirSync(agent);
	const originalAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => {
		if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgent;
	});
	const path = join(agent, "slate-preferences.json");
	const put = (value: unknown) => writeFileSync(path, JSON.stringify(value));
	const save = (entry: unknown = record) => put({ projectModels: { [cwd]: entry } });
	save();
	const notices: Notice[] = [];
	const calls: string[] = [];
	const state = { model: initial, effort: "low" as ThinkingLevel };
	const manager = SessionManager.inMemory(cwd);
	const registry = {
		find(provider: string, id: string) {
			assert.deepEqual({ provider, id }, stored);
			return stored as typeof stored | undefined;
		},
		hasConfiguredAuth: () => true,
	};
	const ctx = {
		mode: "tui",
		cwd,
		hasUI: true,
		sessionManager: manager,
		get model() { return state.model; },
		modelRegistry: registry,
		ui: { notify: (message: string, severity: string) => notices.push([message, severity]) },
	};
	const pi = {
		getThinkingLevel: () => state.effort,
		async setModel(model: typeof stored) {
			calls.push("model");
			state.model = model;
			state.effort = "minimal";
			return true;
		},
		setThinkingLevel(level: ThinkingLevel) {
			calls.push(level);
			state.effort = level;
		},
	};
	const start = async (event: SessionStartEvent = startup, args: string[] = []) => {
		const original = process.argv;
		process.argv = [...original.slice(0, 2), ...args];
		try { await applyPrivateProjectModel(pi, event, ctx as unknown as ExtensionContext); }
		finally { process.argv = original; }
	};
	return { start, cwd, path, put, save, manager, registry, ctx, pi, state, notices, calls };
}

function assertUntouched(f: ReturnType<typeof fixture>) {
	assert.deepEqual(f.calls, []);
	assert.deepEqual(f.state, { model: initial, effort: "low" });
	assert.deepEqual(f.notices, []);
}

for (const mode of ["print", "json", "rpc"]) {
	test(`${mode} does not examine session history or apply the private project model`, timeout, async (t) => {
		const f = fixture(t);
		f.ctx.mode = mode;
		t.mock.method(f.manager, "getEntries", () => assert.fail("non-interactive history read"));
		await f.start();
		assertUntouched(f);
	});
}

for (const reason of ["resume", "fork", "reload"] as const) {
	test(`${reason} stays excluded even without conversation`, timeout, async (t) => {
		const f = fixture(t);
		await f.start({ type: "session_start", reason });
		assertUntouched(f);
	});
}

test("a launch on an empty branch beside old conversation does not apply the choice", timeout, async (t) => {
	const f = fixture(t);
	const forkPoint = f.manager.appendThinkingLevelChange("low");
	f.manager.appendMessage({ role: "user", timestamp: 0, content: "Older branch" });
	f.manager.branch(forkPoint);
	assert.equal(f.manager.buildSessionContext().messages.length, 0);
	assert.ok(f.manager.getEntries().some((entry) => entry.type === "message"));
	await f.start();
	assertUntouched(f);
});

test("an extension message in the conversation also prevents application", timeout, async (t) => {
	const f = fixture(t);
	f.manager.appendCustomMessageEntry("fixture", "Earlier context", false);
	assert.equal(f.manager.buildSessionContext().messages.length, 1);
	await f.start();
	assertUntouched(f);
});

for (const kind of ["branch summary", "compaction"] as const) {
	test(`a ${kind} on another branch counts as conversation`, timeout, async (t) => {
		const f = fixture(t);
		const forkPoint = f.manager.appendThinkingLevelChange("low");
		if (kind === "branch summary") f.manager.branchWithSummary(forkPoint, "Earlier context");
		else f.manager.appendCompaction("Earlier context", null, 100);
		assert.deepEqual(f.manager.buildSessionContext().messages.map((message) => message.role),
			[kind === "branch summary" ? "branchSummary" : "compactionSummary"]);
		f.manager.branch(forkPoint);
		assert.deepEqual(f.manager.buildSessionContext().messages, []);
		await f.start();
		assertUntouched(f);
	});
}

test("an empty branch summary still permits application", timeout, async (t) => {
	const f = fixture(t);
	const forkPoint = f.manager.appendThinkingLevelChange("low");
	f.manager.branchWithSummary(forkPoint, "");
	assert.ok(f.manager.getEntries().some((entry) => entry.type === "branch_summary"));
	assert.deepEqual(f.manager.buildSessionContext().messages, []);
	await f.start();
	assert.deepEqual(f.calls, ["model", "high"]);
});

test("a successor is excluded even if its handoff record cannot be adopted", timeout, async (t) => {
	const f = fixture(t);
	f.manager.appendCustomEntry("slate-handoff", { sessionId: f.manager.getSessionId(), snapshot: null });
	await f.start({ type: "session_start", reason: "new" });
	assertUntouched(f);
});

test("an entry with another session ID is not this session's handoff", timeout, async (t) => {
	const f = fixture(t);
	f.manager.appendCustomEntry("slate-handoff", { sessionId: "other" });
	await f.start({ type: "session_start", reason: "new" });
	assert.deepEqual(f.calls, ["model", "high"]);
});

const argvCases: Array<[string[], ThinkingLevel | undefined]> = [
	[["--model", "offline/default"], undefined],
	[["--provider", "offline", "--model", "default:low"], undefined],
	[["--model", "default", "--thinking", "medium"], undefined],
	[["--model=default"], "high"],
	[["--model"], "high"],
	[["--model", ""], "high"],
	[["--thinking", ""], "high"],
	[["--thinking", "medium"], "medium"],
	[["--thinking", "off"], "off"],
	[["--thinking", "medium", "--thinking", "max"], "max"],
	[["--thinking=medium"], "high"],
	[["--thinking", "unknown"], "high"],
	[["--thinking"], "high"],
	[["--thinking", "medium", "--", "--thinking", "max"], "medium"],
	[["--", "--model", "default", "--thinking", "medium"], "high"],
];
for (const [args, level] of argvCases) {
	test(`Pi argument forms: ${args.join(" ")}`, timeout, async (t) => {
		const f = fixture(t);
		f.manager.appendModelChange(initial.provider, initial.id);
		f.manager.appendThinkingLevelChange("low");
		await f.start(startup, args);
		if (level === undefined) assertUntouched(f);
		else {
			assert.deepEqual(f.calls, ["model", level]);
			assert.deepEqual(f.state, { model: stored, effort: level });
			assert.deepEqual(f.notices, [[`slate: Applied private project model ${spec} with thinking level ${level}.`, "info"]]);
		}
	});
}

test("TUI eligibility does not require a UI context", timeout, async (t) => {
	const f = fixture(t);
	f.ctx.hasUI = false;
	const info = t.mock.method(console, "info", () => {});
	await f.start();
	assert.deepEqual(f.calls, ["model", "high"]);
	assert.equal(info.mock.callCount(), 1);
});

test("an exact match takes no action and a different level changes only the level", timeout, async (t) => {
	const f = fixture(t);
	f.state.model = stored;
	f.state.effort = "high";
	await f.start();
	assert.deepEqual(f.calls, []);
	assert.deepEqual(f.notices, []);
	await f.start(startup, ["--thinking", "medium"]);
	assert.deepEqual(f.calls, ["medium"]);
	assert.deepEqual(f.notices, [[`slate: Applied private project model ${spec} with thinking level medium.`, "info"]]);
});

test("a switch that already reaches the requested level does not set it again", timeout, async (t) => {
	const f = fixture(t);
	await f.start(startup, ["--thinking", "minimal"]);
	assert.deepEqual(f.calls, ["model"]);
	assert.deepEqual(f.notices, [[`slate: Applied private project model ${spec} with thinking level minimal.`, "info"]]);
});

test("a missing project entry is silent", timeout, async (t) => {
	const f = fixture(t);
	f.put({ projectModels: { "/not-this-project": record } });
	await f.start();
	assertUntouched(f);
});

const failures: Array<[string, (f: ReturnType<typeof fixture>, t: TestContext) => void, RegExp, boolean?]> = [
	["damaged Git entry", (f) => writeFileSync(join(f.cwd, ".git"), "not Git data"), /cannot determine the project key/],
	["unreadable store", (f) => writeFileSync(f.path, "{"), /cannot read the private store/],
	["invalid entry", (f) => f.save({ model: spec }), /entry is invalid/],
	["unknown model", (f) => { f.registry.find = () => undefined; }, /does not know model offline\/vendor\/stored/],
	["missing credentials", (f) => { f.registry.hasConfiguredAuth = () => false; }, /No credentials are configured/],
	["pre-switch refusal", (f, t) => { t.mock.method(f.pi, "setModel", async () => false); }, /refused to switch/, true],
	["pre-switch exception", (f, t) => { t.mock.method(f.pi, "setModel", async () => { throw Error("auth unavailable"); }); },
		/could not apply .* before changing the session/, true],
];
for (const [name, configure, warning, switchCalled = false] of failures) {
	test(name + " warns and preserves the Pi selection", timeout, async (t) => {
		const f = fixture(t);
		const setter = t.mock.method(f.pi, "setModel");
		configure(f, t);
		const perform = f.pi.setModel;
		f.pi.setModel = async (model) => {
			f.calls.push("attempt");
			return perform(model);
		};
		await f.start();
		assert.deepEqual(f.state, { model: initial, effort: "low" });
		assert.deepEqual(f.calls, switchCalled ? ["attempt"] : []);
		if (!switchCalled) assert.equal(setter.mock.callCount(), 0);
		assert.equal(f.notices.length, 1);
		assert.match(f.notices[0]![0], warning);
		assert.equal(f.notices[0]![1], "warning");
	});
}

test("a warning without a UI context is visible on the console", timeout, async (t) => {
	const f = fixture(t);
	f.ctx.hasUI = false;
	f.save({});
	const warn = t.mock.method(console, "warn", () => {});
	await f.start();
	assertUntouched(f);
	assert.equal(warn.mock.callCount(), 1);
	assert.match(String(warn.mock.calls[0]?.arguments[0]), /entry is invalid/);
});
