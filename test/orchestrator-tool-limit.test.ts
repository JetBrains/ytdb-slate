import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSlateMode } from "../extension/mode.ts";
import { SlateStore } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";

const LIMITED = ["read", "grep", "find", "ls", "thread", "threads", "episode", "slate_change"];

function harness(initial: string[], options: { seedDefault?: boolean; registered?: string[] } = {}) {
	const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	let active = [...initial];
	let sets = 0;
	const api = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command.handler);
		},
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) { active = [...names]; sets++; },
		getAllTools: () => (options.registered ?? ["read", "bash", "mcp", "edit", "slate_change"]).map((name) => ({ name })),
		appendEntry() {},
	};
	const ctx = {
		cwd: process.cwd(), mode: options.seedDefault ? "tui" : "print", hasUI: false,
		ui: { setWidget() {} },
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => [], getEntries: () => [] },
	} as unknown as ExtensionContext;
	const store = new SlateStore(api as unknown as ExtensionAPI);
	registerSlateMode(
		api as unknown as ExtensionAPI, store,
		{ startHandoff: async () => {}, effectiveContextBudget: () => undefined },
		() => ({ orchestratorModeDefault: options.seedDefault }), () => EMPTY_WORKER_EXTENSION_SET,
	);
	const emit = async (name: string, event: unknown = {}) => {
		const results: unknown[] = [];
		for (const handler of events.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	return {
		store,
		active: () => active,
		sets: () => sets,
		set: (names: string[]) => api.setActiveTools(names),
		on: api.on,
		emit,
		command: (args: string) => commands.get("slate")!(args, ctx),
		call: (toolName: string, input: Record<string, unknown> = {}) =>
			emit("tool_call", { type: "tool_call", toolCallId: "id", toolName, input }),
	};
}

const prompt = { systemPrompt: "Base prompt" };

test("later extension tools stay limited and return when orchestrator mode ends", { timeout: 1000 }, async () => {
	const f = harness(["read", "bash", "slate_change"]);
	await f.command("on");
	assert.deepEqual(f.active(), LIMITED);
	f.on("session_start", () => { f.set([...f.active(), "mcp"]); });
	await f.emit("session_start", { reason: "startup" });
	assert.deepEqual(f.active(), [...LIMITED, "mcp"], "later handler runs after Slate");
	await f.emit("before_agent_start", prompt);
	assert.deepEqual(f.active(), LIMITED, "run start restores the limited set");
	assert.deepEqual(await f.call("mcp", { secret: "do not repeat" }), [
		{ block: true, reason: "slate: orchestrator mode does not allow this tool." },
	]);
	assert.deepEqual(await f.call("read"), [undefined]);
	f.set([...f.active(), "mcp"]);
	assert.deepEqual(await f.call("mcp"), [
		{ block: true, reason: "slate: orchestrator mode does not allow this tool." },
	], "a mid-run activation still cannot execute");
	await f.command("off");
	assert.deepEqual(f.active(), ["read", "bash", "mcp"]);
	assert.deepEqual(await f.call("mcp"), [undefined]);
});

test("off keeps an extra activated without another run start", { timeout: 1000 }, async () => {
	const f = harness(["read", "bash"]);
	await f.command("on");
	f.set([...LIMITED, "mcp"]);
	await f.command("off");
	assert.deepEqual(f.active(), ["read", "bash", "mcp"]);
});

test("run-start capture keeps an extra after enforcement removes it", { timeout: 1000 }, async () => {
	const f = harness(["read", "bash"]);
	await f.command("on");
	f.set([...LIMITED, "mcp"]);
	await f.emit("before_agent_start", prompt);
	assert.deepEqual(f.active(), LIMITED);
	await f.command("off");
	assert.deepEqual(f.active(), ["read", "bash", "mcp"]);
});

test("fresh default-on session restores only its startup tools", { timeout: 1000 }, async () => {
	const f = harness(LIMITED, {
		seedDefault: true,
		registered: [...LIMITED, "bash", "edit", "write"],
	});
	await f.emit("session_start", { reason: "startup" });
	assert.equal(f.store.orchestratorMode, true);
	await f.command("off");
	assert.deepEqual(f.active(), LIMITED.filter((name) => name !== "slate_change"));
});

test("restored mode with a non-restricted active set saves that set", { timeout: 1000 }, async () => {
	const f = harness(["read", "bash", "slate_change"]);
	f.store.orchestratorMode = true;
	await f.emit("session_start", { reason: "reload" });
	assert.deepEqual(f.active(), LIMITED);
	await f.command("off");
	assert.deepEqual(f.active(), ["read", "bash"]);
});

test("mode restored without a saved baseline restores all registered tools", { timeout: 1000 }, async () => {
	const f = harness([...LIMITED, "mcp"]);
	f.store.orchestratorMode = true;
	await f.emit("session_start", { reason: "reload" });
	assert.deepEqual(f.active(), LIMITED);
	await f.command("off");
	assert.deepEqual(f.active(), ["read", "bash", "mcp", "edit"]);
});

test("an equal active tool set does not rebuild the prompt", { timeout: 1000 }, async () => {
	const f = harness(["read", "bash"]);
	await f.command("on");
	const initialSets = f.sets();
	await f.emit("session_start", { reason: "startup" });
	await f.emit("before_agent_start", prompt);
	assert.equal(f.sets(), initialSets);
	f.set([...LIMITED].reverse());
	const reorderedSets = f.sets();
	await f.emit("before_agent_start", prompt);
	assert.equal(f.sets(), reorderedSets, "order alone does not require an update");
});
