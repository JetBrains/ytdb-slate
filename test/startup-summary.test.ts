import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import slateExtension from "../extension/index.ts";
import { registerSlateMode } from "../extension/mode.ts";
import { SlateStore } from "../extension/state.ts";
import { EMPTY_WORKER_EXTENSION_SET } from "../extension/worker-extensions.ts";
import { loadConfig, permitsSlateConfig } from "../extension/config.ts";
import { preferencePath, readProjectModel, readStartupSummary, renderStartupSummary, saveStartupSummary, SUMMARY_WIDGET_KEY, writeProjectModel } from "../extension/startup-summary.ts";
import { TRACK_WORKFLOW_DOC } from "../extension/paths.ts";
import { resolveProjectKey } from "../extension/project-key.ts";
import type { SlateSnapshot } from "../extension/state.ts";

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "slate-summary-"));
	const agent = join(root, "agent");
	const project = join(root, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	const path = preferencePath(agent);
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
		rmSync(root, { recursive: true, force: true });
	});
	return { root, agent, project, path };
}

test("preference saves in the redirected agent folder, keeps other keys, and ignores slate.json", (t) => {
	const f = fixture(t);
	assert.deepEqual(readStartupSummary(), { enabled: false });
	assert.equal(preferencePath(), f.path);
	writeFileSync(join(f.project, ".pi", "slate.json"), '{"startupSummary":true}');
	mkdirSync(f.agent);
	writeFileSync(join(f.agent, "slate.json"), '{"startupSummary":true}');
	assert.equal(readStartupSummary().enabled, false);
	assert.match(JSON.stringify(loadConfig(f.project, true, () => {})), /"startupSummary":true/);
	assert.equal(saveStartupSummary(false).path, f.path);
	assert.deepEqual(readStartupSummary(), { enabled: false });
	assert.equal(permitsSlateConfig(loadConfig(f.project, false, () => {}), false), true);
	writeFileSync(f.path, '{"extra":{"value":3}}');
	assert.deepEqual(readStartupSummary(), { enabled: false });
	saveStartupSummary(true);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { extra: { value: 3 }, startupSummary: true });
	assert.deepEqual(readStartupSummary(), { enabled: true });
	rmSync(join(f.agent, "slate.json"));
	assert.equal(permitsSlateConfig(loadConfig(f.project, false, () => {}), false), false);
});

test("absent keys stay off and explicit booleans keep their meaning", async (t) => {
	for (const [label, content, enabled] of [
		["absent key", "{}", false],
		["unrelated key", '{"other":1}', false],
		["explicit on", '{"startupSummary":true}', true],
		["explicit off", '{"startupSummary":false}', false],
	] as const) {
		await t.test(label, (caseT) => {
			const f = fixture(caseT);
			mkdirSync(f.agent);
			writeFileSync(f.path, content);
			assert.deepEqual(readStartupSummary(), { enabled });
		});
	}
});

test("invalid preference reads show the summary, and commands refuse to replace invalid files", (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	for (const text of ["[]", "null", "9", "{broken"]) {
		writeFileSync(f.path, text);
		assert.match(readStartupSummary().warning!, new RegExp(f.path));
		assert.equal(readStartupSummary().enabled, true);
		assert.throws(() => saveStartupSummary(false));
		assert.equal(readFileSync(f.path, "utf8"), text);
	}
	writeFileSync(f.path, '{"startupSummary":"no"}');
	assert.match(readStartupSummary().warning!, /boolean startupSummary/);
	assert.equal(readStartupSummary().enabled, true);
	// A directory is unreadable as JSON even for users who can list it.
	rmSync(f.path);
	mkdirSync(f.path);
	assert.match(readStartupSummary().warning!, /Cannot read or parse/);
	assert.equal(readStartupSummary().enabled, true);
	assert.throws(() => saveStartupSummary(false));
	assert.equal(lstatSync(f.path).isDirectory(), true);
});

test("failure before rename keeps old bytes, mode and no temporary file", (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	writeFileSync(f.path, '{"other":1,"startupSummary":true}\n', { mode: 0o640 });
	const bytes = readFileSync(f.path);
	const mode = statSync(f.path).mode & 0o777;
	assert.throws(() => saveStartupSummary(false, f.path, { beforeReplace: () => { throw new Error("before rename"); } }), /before rename/);
	assert.deepEqual(readFileSync(f.path), bytes);
	assert.equal(statSync(f.path).mode & 0o777, mode);
	assert.deepEqual(readdirSync(f.agent), ["slate-preferences.json"]);
	saveStartupSummary(false, f.path);
	assert.equal(statSync(f.path).mode & 0o777, mode);
	assert.equal(readStartupSummary(f.path).enabled, false);
});

test("cleanup failure reports the original write failure and the stranded temporary path", (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	writeFileSync(f.path, '{"startupSummary":true}\n');
	let stranded = "";
	assert.throws(() => saveStartupSummary(false, f.path, { beforeReplace: () => {
		const temp = readdirSync(f.agent).find((name) => name.endsWith(".tmp"))!;
		stranded = join(f.agent, temp);
		renameSync(stranded, `${stranded}.saved`);
		mkdirSync(stranded); // unlinkSync cannot remove a directory, including as root.
		throw new Error("write failed first");
	} }), (error: unknown) => {
		assert.match(String(error), /^Error: write failed first\. The temporary file /);
		assert.doesNotMatch(String(error), /Error: Error:/);
		assert.match(String(error), /temporary file .* could not be removed/);
		assert.ok(String(error).includes(stranded));
		assert.match(String(error), /EISDIR|EPERM/);
		assert.match(String((error as Error).cause), /write failed first/);
		return true;
	});
	assert.equal(readStartupSummary(f.path).enabled, true);
	assert.equal(lstatSync(stranded).isDirectory(), true);
});

test("new files use umask rights, and symlinks keep their link and target mode", (t) => {
	const f = fixture(t);
	const result = saveStartupSummary(false);
	assert.equal(result.path, f.path);
	assert.equal(existsSync(f.path), true);
	assert.equal(statSync(f.path).mode & 0o777, 0o666 & ~process.umask());
	const target = join(f.agent, "actual.json");
	writeFileSync(target, '{"other":1}', { mode: 0o600 });
	chmodSync(target, 0o600);
	rmSync(f.path);
	symlinkSync(target, f.path);
	saveStartupSummary(true);
	assert.equal(lstatSync(f.path).isSymbolicLink(), true);
	assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { other: 1, startupSummary: true });
	assert.equal(statSync(target).mode & 0o777, 0o600);
	assert.equal(readdirSync(f.agent).filter((entry) => entry.endsWith(".tmp")).length, 0);
});

test("failure flushing the folder after replacement reports saved but uncertain durability", (t) => {
	const f = fixture(t);
	const result = saveStartupSummary(false, f.path, { syncFolder: () => { throw Object.assign(new Error("disk failure"), { code: "EIO" }); } });
	if (process.platform === "win32") assert.equal(result.durabilityWarning, undefined);
	else assert.match(result.durabilityWarning!, /saved.*may not survive a crash/);
	assert.equal(readStartupSummary(f.path).enabled, false);
});

test("a linked target failure never replaces the link", (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	symlinkSync(join(f.agent, "missing.json"), f.path);
	assert.throws(() => saveStartupSummary(false));
	assert.equal(lstatSync(f.path).isSymbolicLink(), true);
	assert.deepEqual(readdirSync(f.agent), ["slate-preferences.json"]);
});

function harness(t: test.TestContext) {
	const f = fixture(t);
	const events = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const widgets = new Map<string, string[]>();
	const notices: Array<{ text: string; type: string }> = [];
	let chatStatus: string | undefined;
	let active = ["read", "thread", "slate_change"];
	let branch: Array<{ type: string; customType: string; data: unknown }> = [];
	let successorEntry: Record<string, unknown> | undefined;
	let failNextSave = false;
	let mode = "tui";
	let hasUI = true;
	let brokenWidget = false;
	let brokenClear = false;
	let brokenTheme = false;
	let missingTheme = false;
	let brokenFg = false;
	let sessionId = "successor";
	const api = {
		on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) { events.set(name, [...(events.get(name) ?? []), fn]); },
		registerTool() {}, registerCommand(name: string, command: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, command); },
		getActiveTools: () => active, setActiveTools(names: string[]) { active = names; },
		getAllTools: () => [{ name: "read" }, { name: "thread" }, { name: "slate_change" }],
		getThinkingLevel: () => undefined, sendMessage() {},
		appendEntry(name: string, data: SlateSnapshot) {
			if (name === "slate-state" && failNextSave) {
				failNextSave = false;
				throw new Error("injected handoff save failure");
			}
			branch.push({ type: "custom", customType: name, data: structuredClone(data) });
		},
	};
	const ctx = {
		cwd: f.project, get mode() { return mode; }, get hasUI() { return hasUI; }, model: undefined, modelRegistry: {},
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => sessionId, getSessionFile: () => undefined },
		waitForIdle: async () => {},
		newSession: async (options: { setup: (successor: { getSessionId: () => string; appendCustomEntry: (name: string, data: Record<string, unknown>) => void }) => Promise<void> }) => {
			await options.setup({ getSessionId: () => "successor", appendCustomEntry(name, data) {
				assert.equal(name, "slate-handoff");
				successorEntry = structuredClone(data);
			} });
			return { cancelled: false };
		},
		ui: {
			get theme() {
				if (brokenTheme) throw new Error("theme failed");
				if (missingTheme) return undefined;
				return {
					fg(color: string, text: string) {
						if (brokenFg) throw new Error("color failed");
						return `<${color}>${text}</${color}>`;
					},
					bold: (text: string) => `<b>${text}</b>`,
				};
			},
			notify(text: string, type: string) { notices.push({ text, type }); chatStatus = text; },
			setWidget(key: string, lines: string[] | undefined) {
				if (brokenWidget && key === SUMMARY_WIDGET_KEY && lines) throw new Error("render failed");
				if (brokenClear && key === SUMMARY_WIDGET_KEY && !lines) throw new Error("clear failed");
				if (lines) widgets.set(key, lines);
				else widgets.delete(key);
			},
			setStatus() {},
		},
	} as unknown as ExtensionContext;
	slateExtension(api as unknown as ExtensionAPI);
	return { ...f, ctx, widgets, notices, active: () => active, commands,
		// Pi's status replaces the last chat status. Widgets render in another
		// part of the same frame, and reload clears them before session_start.
		frame: () => [...widgets.values()].flat().concat(chatStatus === undefined ? [] : [chatStatus]),
		reloadStatus() { chatStatus = "Reloaded keybindings, extensions, skills, prompts, themes, and context files"; },
		async start(reason = "startup") { for (const fn of events.get("session_start") ?? []) await fn({ reason }, ctx); },
		async command(args: string) { await commands.get("slate")!.handler(args, ctx); },
		async submit(text: string, source = "interactive") {
			// AgentSession.prompt handles registered commands before it emits input.
			if (text === "/slate" || text.startsWith("/slate ")) {
				await commands.get("slate")!.handler(text.slice("/slate".length).trim(), ctx);
				return { command: true };
			}
			const event = { type: "input", text, source };
			let result: unknown = { action: "continue" };
			for (const fn of events.get("input") ?? []) {
				result = (await fn(event, ctx)) ?? { action: "continue" };
				if ((result as { action: string }).action === "handled") return { event, result };
			}
			const prompt = { systemPrompt: "Base model context" };
			for (const fn of events.get("before_agent_start") ?? []) {
				const change = await fn(prompt, ctx) as { systemPrompt?: string } | undefined;
				if (change?.systemPrompt) prompt.systemPrompt = change.systemPrompt;
			}
			return { event, result, prompt: prompt.systemPrompt };
		},
		snapshot(data: SlateSnapshot) { branch = [{ type: "custom", customType: "slate-state", data }]; },
		handoff(data: Record<string, unknown>, savedState?: SlateSnapshot) {
			branch = [{ type: "custom", customType: "slate-handoff", data },
				...(savedState ? [{ type: "custom", customType: "slate-state", data: savedState }] : [])];
		},
		successorEntry: () => successorEntry,
		mode(value: string, ui = true) { mode = value; hasUI = ui; },
		session(value: string) { sessionId = value; },
		failNextSave() { failNextSave = true; },
		breakWidget(value: boolean) { brokenWidget = value; },
		breakClear(value: boolean) { brokenClear = value; },
		breakTheme(value: boolean) { brokenTheme = value; },
		missTheme(value: boolean) { missingTheme = value; },
		breakFg(value: boolean) { brokenFg = value; },
		resetUI() { widgets.clear(); chatStatus = undefined; },
	};
}

const snapshot = (currentChange?: string, owner?: string, orchestratorMode = true): SlateSnapshot => ({
	format: "single-action-v1", threads: [], episodes: [], orchestratorMode, paused: false,
	workerCostUsd: 0, carriedCostUsd: 0, currentChange, changeOwnerSessionId: owner,
});

const PANEL = [
	"What Slate does, step by step:",
	"1. Research: Slate studies your request and the code through worker threads.",
	"2. Risks: Slate judges risks and required reviews internally.",
	"3. Solution: Slate presents a short plan or a required design. You approve the short plan or validate the design. If adversarial design review is required, you give final design approval after it. Otherwise, design validation includes final approval.",
	"4. Tracks: a code track implements one bounded part of approved work. Required reviewers check it. A design track plans a larger part of the work and owns child tracks. You accept each code track in a multi-track change and each design track with all its child tracks. At required boundaries, run /slate handoff --track-boundary to continue in a new main session.",
	"5. Final acceptance: you review the whole change and accept it.",
	"6. Delivery: Without draft publishing, accepted branch history is the delivery. With it, Slate prepares one pull request for the whole change on one branch. Only you merge after final acceptance. A merge is not final acceptance.",
	"Run /slate summary off or /slate summary on to disable or enable automatic display. On applies at the next automatic opportunity. Off also hides the panel now.",
];

const STYLED_PANEL = [
	"<b><accent>What Slate does, step by step:</accent></b>",
	"<b><accent>1. Research:</accent></b> Slate studies your request and the code through worker threads.",
	"<b><accent>2. Risks:</accent></b> Slate judges risks and required reviews internally.",
	"<b><accent>3. Solution:</accent></b> Slate presents a short plan or a required design. <b><warning>You approve the short plan or validate the design. If adversarial design review is required, you give final design approval after it. Otherwise, design validation includes final approval</warning></b>.",
	"<b><accent>4. Tracks:</accent></b> a code track implements one bounded part of approved work. Required reviewers check it. A design track plans a larger part of the work and owns child tracks. <b><warning>You accept each code track in a multi-track change and each design track with all its child tracks</warning></b>. At required boundaries, run <mdCode>/slate handoff --track-boundary</mdCode> to continue in a new main session.",
	"<b><accent>5. Final acceptance:</accent></b> you review the whole change and <b><warning>accept it</warning></b>.",
	"<b><accent>6. Delivery:</accent></b> Without draft publishing, accepted branch history is the delivery. With it, Slate prepares one pull request for the whole change on one branch. <b><warning>Only you merge</warning></b> after final acceptance. A merge is not final acceptance.",
	"<dim>Run </dim><mdCode>/slate summary off</mdCode><dim> or </dim><mdCode>/slate summary on</mdCode><dim> to disable or enable automatic display. On applies at the next automatic opportunity. Off also hides the panel now.</dim>",
];

test("default-off startup permits manual display and saves on for the next automatic opportunity", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot());
	await f.start();
	assert.deepEqual(readStartupSummary(), { enabled: false });
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("summary on");
	assert.deepEqual(readStartupSummary(), { enabled: true });
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.start("reload");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await f.command("summary off");
	await f.start("reload");
	assert.deepEqual(readStartupSummary(), { enabled: false });
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
});

test("reload keeps the summary panel and restores the mode status", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	saveStartupSummary(true);
	f.snapshot(snapshot("change-20260924T105757Z-ab29a0b2cdd1cdc0fa26d66bc4718dc9", "parent"));
	await f.start();
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	assert.equal(f.widgets.has("slate"), false, "orchestrator status needs no widget");
	f.resetUI(); // Pi resetExtensionUI clears widgets before session_start on reload.
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.start("reload");
	f.reloadStatus(); // Pi's status replaces a chat notice after session_start.
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	assert.ok(f.frame().includes(STYLED_PANEL[0]!));
	assert.ok(f.frame().some((line) => line.startsWith("Reloaded keybindings")));
	assert.equal(f.frame().length >= PANEL.length, true);
	assert.match(f.commands.get("slate")!.description, /summary/);
});

test("a visible parent panel stays visible through handoff even with the saved preference off", { timeout: 10000 }, async (t) => {
	const parent = harness(t);
	saveStartupSummary(true);
	parent.snapshot(snapshot());
	await parent.start();
	assert.deepEqual(parent.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await parent.command("summary off");
	await parent.command("summary");
	assert.deepEqual(parent.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await parent.command("handoff");
	const entry = parent.successorEntry()!;
	assert.equal(entry.summaryVisible, true);
	assert.equal((entry.snapshot as SlateSnapshot).format, snapshot().format);
	assert.equal("summaryVisible" in (entry.snapshot as SlateSnapshot), false);
	const successor = harness(t);
	saveStartupSummary(false);
	successor.handoff(entry);
	await successor.start("new");
	assert.deepEqual(successor.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	assert.equal(readStartupSummary().enabled, false, "handoff does not change the preference");
});

test("an interactive prompt hides the panel in the successor despite automatic display being on", { timeout: 10000 }, async (t) => {
	const parent = harness(t);
	saveStartupSummary(true);
	parent.snapshot(snapshot());
	await parent.start();
	await parent.submit("Hide this panel.");
	assert.equal(parent.widgets.has(SUMMARY_WIDGET_KEY), false);
	await parent.command("handoff");
	const entry = parent.successorEntry()!;
	assert.equal(entry.summaryVisible, false);
	const successor = harness(t);
	saveStartupSummary(true);
	successor.handoff(entry);
	await successor.start("new");
	assert.equal(readStartupSummary().enabled, true);
	assert.equal(successor.active().includes("slate_change"), true, "the successor has orchestrator tools");
	assert.equal(successor.widgets.has(SUMMARY_WIDGET_KEY), false);
	successor.resetUI();
	await successor.start("reload");
	assert.deepEqual(successor.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "reload uses the automatic rule");
});

test("carried panel visibility reports broken preferences without changing the panel", { timeout: 10000 }, async (t) => {
	for (const [visible, text, warning] of [
		[true, "{broken", /Cannot read or parse/],
		[false, '{"startupSummary":1}', /needs a boolean startupSummary value/],
	] as const) {
		await t.test(visible ? "visible" : "hidden", async (caseT) => {
			const f = harness(caseT);
			mkdirSync(f.agent);
			writeFileSync(f.path, text);
			f.handoff({ sessionId: "successor", summaryVisible: visible, snapshot: snapshot() });
			await f.start("new");
			const preferenceWarnings = f.notices.filter((notice) => notice.type === "warning" && notice.text.includes(f.path));
			assert.equal(preferenceWarnings.length, 1);
			assert.match(preferenceWarnings[0]!.text, warning);
			assert.equal(readStartupSummary().enabled, true, "a broken preference defaults to on");
			if (visible) assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
			else assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "carried hidden state overrides the default");
		});
	}
});

test("handoff entries without visibility retain the automatic display rule", { timeout: 10000 }, async (t) => {
	for (const enabled of [false, true]) {
		await t.test(`startup preference ${enabled ? "on" : "off"}`, async (caseT) => {
			const f = harness(caseT);
			saveStartupSummary(enabled);
			f.handoff({ sessionId: "successor", snapshot: snapshot() });
			await f.start("new");
			assert.equal(readStartupSummary().enabled, enabled);
			if (enabled) assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
			else assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
		});
	}
});

test("invalid handoff snapshot does not carry a visible panel", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	saveStartupSummary(true);
	f.handoff({ sessionId: "successor", summaryVisible: true, snapshot: { format: "invalid" } });
	await f.start("new");
	assert.match(f.notices.at(-1)!.text, /invalid successor handoff state/);
	assert.equal(readStartupSummary().enabled, true);
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "no mode was adopted, so automatic display stays off");
});

test("failed handoff save does not carry a hidden panel", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	saveStartupSummary(true);
	f.handoff({ sessionId: "successor", summaryVisible: false, snapshot: snapshot() });
	f.failNextSave();
	await f.start("new");
	assert.match(f.notices.at(-1)!.text, /could not persist restored handoff state.*injected handoff save failure/);
	assert.equal(readStartupSummary().enabled, true);
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "adopted mode uses the automatic display rule after a failed save");
});

test("copied and already restored handoff entries do not change automatic display", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	saveStartupSummary(true);
	writeFileSync(join(f.project, ".pi", "slate.json"), '{"orchestratorModeDefault":true}');
	f.handoff({ sessionId: "original", summaryVisible: false, snapshot: snapshot() });
	await f.start("fork");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "a copied entry belongs to the original session");
	f.resetUI();
	f.handoff({ sessionId: "successor", summaryVisible: false, snapshot: snapshot() }, snapshot());
	await f.start("reload");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "saved slate state prevents readoption");
});

test("a failed carried panel update warns through the summary channel", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.handoff({ sessionId: "successor", summaryVisible: true, snapshot: snapshot() });
	f.breakWidget(true);
	await f.start("new");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.match(f.notices.at(-1)!.text, /could not show the workflow summary: Error: render failed/);
	assert.equal(f.notices.at(-1)!.type, "warning");
});

test("fresh terminal mode seeding displays the panel after restore, but an explicit off state does not", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	saveStartupSummary(true);
	await f.start();
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "fresh normal mode has no panel");
	writeFileSync(join(f.project, ".pi", "slate.json"), '{"orchestratorModeDefault":true}');
	await f.start("reload");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "fresh mode seed precedes display");
	f.snapshot(snapshot(undefined, undefined, false));
	f.resetUI();
	await f.start("reload");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "saved off prevents seeding");
});

test("normal mode stays clear through reload status, while toggles and repeat on restore the panel", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	saveStartupSummary(true);
	f.snapshot(snapshot(undefined, undefined, false));
	await f.start();
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	f.resetUI();
	await f.start("reload");
	f.reloadStatus();
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.equal(f.frame().some((line) => line === STYLED_PANEL[0]), false);
	await f.submit("/slate on");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await f.submit("/slate off");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.submit("/slate on");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "each on shows it again");
	await f.submit("/slate");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "toggle off clears it");
	await f.submit("/slate");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "toggle on shows it");
	await f.submit("/slate on");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL, "explicit on shows it again");
});

test("the saved off choice suppresses automatic display, not manual display in either mode", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot(undefined, undefined, false));
	await f.start();
	await f.command("summary off");
	await f.command("on");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await f.command("off");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
	await f.command("summary off");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("summary on");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "saving on does not show the panel");
	await f.command("on");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
});

test("the first terminal prompt clears only the summary widget without changing model input", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	saveStartupSummary(true);
	f.snapshot(snapshot());
	await f.start();
	const lines = f.widgets.get(SUMMARY_WIDGET_KEY)!;
	assert.deepEqual(lines, STYLED_PANEL);
	assert.deepEqual(await f.submit("/slate effective"), { command: true });
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), lines, "slash commands keep the panel");
	const injected = await f.submit("extension message", "extension");
	assert.deepEqual(injected.result, { action: "continue" });
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), lines, "extension input keeps the panel");
	const entries = structuredClone(f.ctx.sessionManager.getEntries());
	const submitted = await f.submit("Please check this file.");
	assert.deepEqual(submitted.event, { type: "input", text: "Please check this file.", source: "interactive" });
	assert.deepEqual(submitted.result, { action: "continue" });
	assert.match(submitted.prompt!, /^Base model context/);
	assert.doesNotMatch(submitted.prompt!, /What Slate does, step by step:|Run \/slate summary off or/);
	assert.deepEqual(f.ctx.sessionManager.getEntries(), entries, "clearing writes no session or model message");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.equal(f.widgets.has("slate"), false, "clearing the panel needs no mode widget");
	await f.submit("/slate summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), lines, "on demand restores the panel");
	await f.submit("Next prompt.");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "the next prompt clears a re-shown panel");
	await f.start("reload");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), lines, "reload restores the panel");
	await f.submit("First prompt after reload.");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
});

test("a failed summary clear warns and leaves the prompt untouched", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	saveStartupSummary(true);
	f.snapshot(snapshot());
	await f.start();
	f.breakClear(true);
	const submitted = await f.submit("Keep my prompt.");
	assert.deepEqual(submitted.result, { action: "continue" });
	assert.equal(submitted.event!.text, "Keep my prompt.");
	assert.doesNotMatch(submitted.prompt!, /What Slate does, step by step:/);
	assert.ok(f.widgets.has(SUMMARY_WIDGET_KEY));
	assert.match(f.notices.at(-1)!.text, /could not clear the workflow summary: Error: clear failed/);
	assert.equal(f.notices.at(-1)!.type, "warning");
	f.breakClear(false);
	await f.submit("Try again.");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.equal(f.notices.filter((notice) => notice.type === "warning").length, 1);
});

test("command validation and mode gating do not toggle orchestrator mode", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	await f.start();
	assert.equal(f.active().includes("slate_change"), false);
	await f.command("summary unknown");
	assert.match(f.notices.at(-1)!.text, /Usage: \/slate summary/);
	assert.equal(f.active().includes("slate_change"), false);
	await f.command("summary off");
	assert.equal(f.active().includes("slate_change"), false);
	assert.equal(f.notices.at(-1)!.type, "info");
	writeFileSync(f.path, "[]");
	await f.command("summary on");
	assert.equal(readFileSync(f.path, "utf8"), "[]");
	assert.match(f.notices.at(-1)!.text, /could not save/);
	f.mode("rpc", true);
	f.resetUI();
	await f.start("reload");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("summary");
	assert.equal(f.notices.at(-1)!.text, PANEL.join("\n"));
	assert.equal(f.notices.at(-1)!.type, "info");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	writeFileSync(f.path, '{"startupSummary":true}');
	await f.command("on");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "RPC on never creates a panel");
	f.mode("print", false);
	await f.start("reload");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	await f.command("off");
	await f.command("on");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false, "print on never creates a panel");
	const printed: string[] = [];
	const originalLog = console.log;
	try {
		console.log = (text: string) => { printed.push(text); };
		await f.command("summary");
	} finally {
		console.log = originalLog;
	}
	assert.deepEqual(printed, [PANEL.join("\n")]);
});

const projectModel = { model: "provider/vendor/model", thinkingLevel: "high" } as const;
const otherPreferences = { startupSummary: true, extra: { value: [1, false] } };

test("project keys follow Git files and share the common directory", (t) => {
	const f = fixture(t);
	const git = join(realpathSync(f.project), ".git");
	const linked = join(f.root, "linked");
	const metadata = join(git, "worktrees", "linked");
	const old = process.env.GIT_DIR;
	process.env.GIT_DIR = f.agent;
	t.after(() => {
		if (old === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = old;
	});
	assert.deepEqual(readProjectModel(f.project), { kind: "none", key: realpathSync(f.project) });
	mkdirSync(metadata, { recursive: true });
	mkdirSync(join(git, "objects"));
	mkdirSync(join(git, "refs"));
	for (const dir of [git, metadata]) writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
	mkdirSync(join(linked, "src"), { recursive: true });
	writeFileSync(join(linked, ".git"), "gitdir: ../project/.git/worktrees/linked\r\n");
	writeFileSync(join(metadata, "commondir"), "../..\n");
	writeProjectModel(join(linked, "src"), projectModel);
	assert.deepEqual(readProjectModel(join(f.project, ".pi")), { kind: "entry", key: git, entry: projectModel });
	const alias = join(f.root, "alias");
	symlinkSync(linked, alias, "dir");
	assert.deepEqual(readProjectModel(alias), readProjectModel(f.project));
	writeFileSync(join(metadata, "commondir"), "./missing");
	assert.equal(readProjectModel(linked).kind, "key-unavailable");
	writeFileSync(join(linked, ".git"), "gitdir: \n");
	assert.equal(readProjectModel(linked).kind, "key-unavailable");
	rmSync(join(linked, ".git"));
	symlinkSync(git, join(linked, ".git"), "dir");
	assert.deepEqual(readProjectModel(linked), readProjectModel(f.project));
	assert.equal(readProjectModel(join(f.root, "missing")).kind, "key-unavailable");
	assert.equal(readProjectModel(join(metadata, "commondir")).kind, "key-unavailable");
});

function gitAt(cwd: string, ...args: string[]): string {
	const home = mkdtempSync(join(tmpdir(), "slate-git-home-"));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
	Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" });
	try {
		return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function gitKey(cwd: string): string {
	return realpathSync(gitAt(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}

test("project key discovery agrees with Git across worktrees, metadata and bare repositories", (t) => {
	const f = fixture(t);
	gitAt(f.project, "init", "-q");
	gitAt(f.project, "-c", "user.name=Slate Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture", "--allow-empty");
	const linked = join(f.root, "linked");
	gitAt(f.project, "worktree", "add", "-q", "--detach", linked);
	const bare = join(f.root, "bare.git");
	const inner = join(f.project, "inner.git");
	for (const dir of [bare, inner]) {
		mkdirSync(dir);
		gitAt(dir, "init", "-q", "--bare");
	}
	const nested = join(f.project, "nested");
	gitAt(f.project, "clone", "-q", ".", nested);
	mkdirSync(join(linked, "src"));
	mkdirSync(join(bare, "src"));
	const directories = [f.project, join(f.project, ".pi"), linked, join(linked, "src"),
		join(f.project, ".git"), join(f.project, ".git", "objects"), join(f.project, ".git", "worktrees", "linked"),
		bare, join(bare, "objects"), join(bare, "src"), inner, join(inner, "objects"), nested];
	assert.deepEqual(directories.map(resolveProjectKey), directories.map(gitKey));
});

test("project key resolves symlinks before parent segments in Git pointers", (t) => {
	const f = fixture(t);
	const inner = join(f.root, "inner");
	const repo = join(inner, "project");
	const child = join(inner, "child");
	const work = join(f.root, "work");
	const linked = join(f.root, "linked");
	for (const dir of [repo, child, work, linked]) mkdirSync(dir, { recursive: true });
	for (const dir of [f.project, repo]) gitAt(dir, "init", "-q");
	symlinkSync(child, join(f.root, "alias"), "dir");
	writeFileSync(join(work, ".git"), "gitdir: ../alias/../project/.git\n");
	const metadata = join(f.root, "metadata");
	mkdirSync(metadata);
	writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(metadata, "commondir"), "../alias/../project/.git\n");
	writeFileSync(join(linked, ".git"), "gitdir: ../metadata\n");
	const expected = realpathSync(join(repo, ".git"));
	assert.deepEqual([gitKey(work), gitKey(linked)], [expected, expected]);
	assert.deepEqual([resolveProjectKey(work), resolveProjectKey(linked)], [expected, expected]);
});

test("round two: symbolic unborn HEAD keeps a nested clear in its own repository", { skip: process.platform === "win32" && "Requires a symbolic link at HEAD" }, (t) => {
	const f = fixture(t);
	const nested = join(f.project, "unborn");
	mkdirSync(nested);
	for (const dir of [f.project, nested]) gitAt(dir, "init", "-q");
	const head = join(nested, ".git", "HEAD");
	rmSync(head);
	symlinkSync("refs/heads/topic", head);
	const parentKey = gitKey(f.project);
	const nestedKey = gitKey(nested);
	assert.notEqual(nestedKey, parentKey);
	const before = resolveProjectKey(nested);
	mkdirSync(f.agent);
	const nestedEntry = { ...projectModel, model: "provider/nested" };
	const data = { projectModels: { [parentKey]: projectModel, [nestedKey]: nestedEntry } };
	writeFileSync(f.path, JSON.stringify(data));
	const clear = writeProjectModel(nested, undefined);
	assert.deepEqual({ before, cleared: clear.key, data: JSON.parse(readFileSync(f.path, "utf8")) }, {
		before: nestedKey, cleared: nestedKey, data: { projectModels: { [parentKey]: projectModel } },
	});
});

for (const format of ["sha1", "sha256"]) {
	test(`round two: detached ${format} HEAD agrees with Git`, (t) => {
		const f = fixture(t);
		try { gitAt(f.project, "init", "-q", `--object-format=${format}`); }
		catch (error) {
			if (format !== "sha256" || !/unknown (?:option|hash algorithm)|unsupported.*sha256/i.test(String(error))) throw error;
			t.skip(`Installed Git does not support SHA-256 repositories: ${String(error)}`);
			return;
		}
		gitAt(f.project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "x");
		gitAt(f.project, "checkout", "--detach");
		assert.match(readFileSync(join(f.project, ".git", "HEAD"), "utf8").trim(), format === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/);
		assert.equal(resolveProjectKey(f.project), gitKey(f.project));
	});
}

for (const [label, metadata, suffix] of [
	["two trailing line feeds", "meta", "\n\n"],
	["CRLF", "meta", "\r\n"],
	["no terminator", "meta", ""],
	["embedded newline", "meta\ndata", "\n"],
] as const) {
	test(`round two: gitdir pointer with ${label} agrees with Git`, { skip: process.platform === "win32" && label === "embedded newline" && "Requires a newline in a directory name" }, (t) => {
		const f = fixture(t);
		gitAt(f.project, "init", "-q", "--separate-git-dir", join(f.root, metadata));
		writeFileSync(join(f.project, ".git"), `gitdir: ../${metadata}${suffix}`);
		const expected = gitKey(f.project);
		const result = readProjectModel(f.project);
		assert.equal(result.kind === "none" ? result.key : result.kind, expected);
	});
}

test("round two: Git directory checks use access rather than entry type for objects and refs", { skip: process.platform === "win32" && "Requires POSIX execute permissions" }, (t) => {
	const f = fixture(t);
	const metadata = join(f.root, "metadata");
	mkdirSync(metadata);
	writeFileSync(join(metadata, "HEAD"), "ref:\trefs/heads/topic\n");
	for (const name of ["objects", "refs"]) {
		const path = join(metadata, name);
		writeFileSync(path, "");
		chmodSync(path, 0o700);
	}
	writeFileSync(join(f.project, ".git"), `gitdir: ${metadata}\r\n\r\n`);
	assert.equal(resolveProjectKey(f.project), gitKey(f.project));
});

test("round three: dangling marker and invalid HEAD forms refuse instead of using the parent", { timeout: 10000, skip: process.platform === "win32" && "Requires POSIX symbolic links" }, async (t) => {
	const f = harness(t);
	gitAt(f.project, "init", "-q");
	const marker = join(realpathSync.native(f.project), ".pi", ".git");
	symlinkSync("missing", marker);
	await assertKeyRefused(f, join(f.project, ".pi"), marker, gitKey(f.project));
	rmSync(marker);
	mkdirSync(marker);
	mkdirSync(join(marker, "objects"));
	mkdirSync(join(marker, "refs"));
	const head = join(marker, "HEAD");
	symlinkSync("../not-a-ref", head);
	await assertKeyRefused(f, join(f.project, ".pi"), marker, gitKey(f.project));
	rmSync(head);
	mkdirSync(head);
	await assertKeyRefused(f, join(f.project, ".pi"), marker, gitKey(f.project));
});

test("a model prefix with an unknown form shows usage without switching mode", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	await f.start();
	const actual = [];
	const expected = [];
	for (const mode of ["on", "off"]) {
		for (const args of ["model-save", "models", "model=clear", "MODEL-SAVE"]) {
			await f.command(mode);
			const active = [...f.active()];
			await f.command(args);
			actual.push([mode, args, f.notices.at(-1)!.text, f.active()]);
			expected.push([mode, args, "Usage: /slate model [save | clear].", active]);
		}
	}
	assert.deepEqual(actual, expected);
	assert.equal(existsSync(f.path), false);
});

test("model save refuses a provider with a slash", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.ctx.model = { provider: "custom/nested", id: "id" } as NonNullable<ExtensionContext["model"]>;
	f.ctx.thinkingLevel = "off";
	await f.command("model save");
	assert.deepEqual({ notice: f.notices.at(-1), wrote: existsSync(f.path) }, {
		notice: { type: "warning", text: "Cannot save the project model: Error: The provider name contains a slash." }, wrote: false,
	});
});

test("model save and clear report completed writes when the reply fails", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.ctx.model = { provider: "provider", id: "vendor/model" } as NonNullable<ExtensionContext["model"]>;
	f.ctx.thinkingLevel = "high";
	const notify = f.ctx.ui.notify;
	t.mock.method(f.ctx.ui, "notify", (message: string, type: Parameters<typeof notify>[1]) => {
		if (type === "info") throw new Error("notification unavailable");
		notify(message, type);
	});
	const saveError = await f.command("model save").catch(String);
	const afterSave = readProjectModel(f.project).kind;
	const saveNotice = f.notices.at(-1);
	const clearError = await f.command("model clear").catch(String);
	assert.deepEqual([saveError, clearError, afterSave, readProjectModel(f.project).kind], [undefined, undefined, "entry", "none"]);
	for (const [notice, verb] of [[saveNotice, "Saved"], [f.notices.at(-1), "Cleared"]] as const) {
		assert.equal(notice?.type, "warning");
		assert.match(notice.text, new RegExp(`${verb} the project model.*could not show the reply.*notification unavailable`));
	}
});

test("model commands own the verb and only change the current entry", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	await f.start();
	const active = [...f.active()];
	assert.match(f.commands.get("slate")!.description, /model \[save \| clear\]/);
	await f.command("model");
	assert.match(f.notices.at(-1)!.text, /Project key: .*\. No stored model/);
	await f.command("model clear");
	assert.match(f.notices.at(-1)!.text, /No stored model to clear/);
	assert.equal(existsSync(f.path), false);
	for (const args of ["model foo", "MODEL save extra", "model clear extra"]) {
		await f.command(args);
		assert.match(f.notices.at(-1)!.text, /Usage: \/slate model/);
		assert.deepEqual(f.active(), active);
		assert.equal(existsSync(f.path), false);
	}

	const key = realpathSync(f.project);
	const entries = { [key]: { model: "bad", thinkingLevel: "high" }, "/another/project": ["invalid but kept"] };
	const data = { ...otherPreferences, projectModels: entries };
	mkdirSync(f.agent);
	const put = (entry: unknown) => writeFileSync(f.path, JSON.stringify(entry));
	const get = () => JSON.parse(readFileSync(f.path, "utf8"));
	put(data);
	await f.command("model");
	assert.match(f.notices.at(-1)!.text, /Invalid project model/);
	await f.command("model save");
	assert.match(f.notices.at(-1)!.text, /no current model/);
	f.ctx.model = { provider: "provider", id: "vendor/model" } as NonNullable<ExtensionContext["model"]>;
	await f.command("model save");
	assert.match(f.notices.at(-1)!.text, /no current thinking level/);
	assert.deepEqual(get(), data);

	f.ctx.thinkingLevel = "high";
	await f.command("model save");
	assert.match(f.notices.at(-1)!.text, /Saved the project model/);
	assert.deepEqual(get(), { ...data, projectModels: { ...entries, [key]: projectModel } });
	await f.command("model");
	assert.ok(f.notices.at(-1)!.text.includes(`Project key: ${key}. Stored model: provider/vendor/model. Thinking level: high.`));
	await f.command("summary off");
	assert.deepEqual(get(), { ...data, startupSummary: false, projectModels: { ...entries, [key]: projectModel } });

	put(data);
	await f.command("model clear");
	assert.match(f.notices.at(-1)!.text, /Cleared the project model/);
	assert.deepEqual(get(), { ...data, projectModels: { "/another/project": entries["/another/project"] } });
	const bytes = readFileSync(f.path);
	await f.command("model clear");
	assert.match(f.notices.at(-1)!.text, /No stored model to clear/);
	assert.deepEqual(readFileSync(f.path), bytes);
	put({ ...data, projectModels: { [key]: null } });
	await f.command("model clear");
	assert.deepEqual(get(), { ...data, projectModels: {} });
	assert.deepEqual(f.active(), active);
	f.mode("print", false);
	const log = t.mock.method(console, "log", (_text: string) => {});
	await f.command("model");
	assert.match(log.mock.calls[0]!.arguments[0], /No stored model/);
});

test("model commands distinguish a bad store from a bad project key", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.ctx.model = { provider: "provider", id: "model" } as NonNullable<ExtensionContext["model"]>;
	f.ctx.thinkingLevel = "off";
	mkdirSync(f.agent);
	const badMap = JSON.stringify({ ...otherPreferences, projectModels: [] });
	const valid = JSON.stringify(otherPreferences);
	for (const [bytes, reason] of [
		[badMap, /projectModels must be a JSON object/],
		["[]", /must contain a JSON object/],
		[valid, /Cannot determine the project key/],
	] as const) {
		if (bytes === valid) writeFileSync(join(f.project, ".git"), "bad marker");
		writeFileSync(f.path, bytes);
		for (const args of ["model", "model save", "model clear"]) {
			await f.command(args);
			assert.equal(f.notices.at(-1)!.type, "warning");
			assert.match(f.notices.at(-1)!.text, reason);
			assert.equal(readFileSync(f.path, "utf8"), bytes);
		}
	}
});

test("model commands refuse a Git pointer to a directory without Git metadata", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.ctx.model = { provider: "provider", id: "model" } as NonNullable<ExtensionContext["model"]>;
	f.ctx.thinkingLevel = "off";
	mkdirSync(join(f.root, "not-git"));
	writeFileSync(join(f.project, ".git"), "gitdir: ../not-git\n");
	assert.throws(() => gitKey(f.project), /not point to a valid repository/);
	await assertKeyRefused(f, f.project, realpathSync.native(join(f.root, "not-git")), realpathSync(join(f.root, "not-git")));
});

test("round two: invalid HEAD cannot claim a key or authorize model writes", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.ctx.model = { provider: "provider", id: "model" } as NonNullable<ExtensionContext["model"]>;
	f.ctx.thinkingLevel = "off";
	const parent = join(realpathSync.native(f.root), "parent");
	const decoy = join(parent, "decoy");
	const child = join(decoy, "sub");
	for (const name of ["sub", "objects", "refs"]) mkdirSync(join(decoy, name), { recursive: true });
	gitAt(parent, "init", "-q");
	writeFileSync(join(decoy, "HEAD"), "inventory\n");
	writeFileSync(join(f.project, ".git"), "gitdir: ../parent/decoy\n");
	assert.throws(() => gitKey(f.project), /not point to a valid repository/);
	await assertKeyRefused(f, child, decoy, gitKey(parent), realpathSync.native(decoy));
	await assertKeyRefused(f, f.project, decoy, gitKey(parent), realpathSync.native(decoy));
});

for (const level of ["agent directory", "store file"]) {
	for (const operation of ["summary", "model"]) {
		test(`round two: ${operation} reads and replaces the OS store through the ${level} link`, { skip: process.platform === "win32" && "Requires POSIX symbolic link traversal" }, (t) => {
			const f = fixture(t);
			const physical = join(f.root, "physical");
			const sub = join(physical, "sub");
			mkdirSync(sub, { recursive: true });
			symlinkSync("physical/sub", join(f.root, "via"), "dir");
			mkdirSync(f.agent);
			mkdirSync(join(physical, "agent"));
			const leaf = level === "agent directory" ? "slate-preferences.json" : "one.json";
			const lexical = join(f.agent, leaf);
			const actual = join(physical, "agent", leaf);
			const intermediate = join(f.root, "intermediate");
			if (level === "agent directory") {
				process.env.PI_CODING_AGENT_DIR = join(f.root, "agent-link");
				symlinkSync("via/../agent", intermediate, "dir");
				symlinkSync(intermediate, process.env.PI_CODING_AGENT_DIR, "dir");
			} else {
				symlinkSync("via/../agent/one.json", intermediate);
				symlinkSync(intermediate, f.path);
			}
			const key = realpathSync.native(f.project);
			const intended = { startupSummary: true, projectModels: { [key]: projectModel }, marker: "OS" };
			const wrong = '{"startupSummary":false,"marker":"lexical"}';
			writeFileSync(actual, JSON.stringify(intended));
			writeFileSync(lexical, wrong);
			assert.deepEqual(JSON.parse(readFileSync(preferencePath(), "utf8")), intended);
			const inode = statSync(actual).ino;
			const before = operation === "summary" ? readStartupSummary() : readProjectModel(f.project);
			const newModel = { ...projectModel, model: "provider/new" };
			if (operation === "summary") saveStartupSummary(false);
			else writeProjectModel(f.project, newModel);
			assert.deepEqual({ before, actual: JSON.parse(readFileSync(actual, "utf8")), lexical: readFileSync(lexical, "utf8") }, {
				before: operation === "summary" ? { enabled: true } : { kind: "entry", key, entry: projectModel },
				actual: operation === "summary" ? { ...intended, startupSummary: false } : { ...intended, projectModels: { [key]: newModel } },
				lexical: wrong,
			});
			assert.notEqual(statSync(actual).ino, inode);
			const outer = level === "agent directory" ? process.env.PI_CODING_AGENT_DIR! : f.path;
			assert.equal(fs.readlinkSync(outer), intermediate);
			assert.equal(fs.readlinkSync(intermediate), level === "agent directory" ? "via/../agent" : "via/../agent/one.json");
			assert.deepEqual(readdirSync(join(physical, "agent")), [leaf]);
		});
	}
}

test("a preference replacement restricts the temporary file before writing content", { skip: process.platform === "win32" }, (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	writeFileSync(f.path, "{}");
	chmodSync(f.path, 0o600);
	const write = fs.writeFileSync;
	const modes: number[] = [];
	const mock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
		if (typeof args[0] === "number") modes.push(fs.fstatSync(args[0]).mode & 0o777);
		return write(...args);
	});
	const oldMask = process.umask(0o022);
	syncBuiltinESMExports();
	try { writeProjectModel(f.project, projectModel); }
	finally { process.umask(oldMask); mock.mock.restore(); syncBuiltinESMExports(); }
	assert.deepEqual(modes, [0o600]);
	assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test("a model write pins the target even if the store link moves during the read", (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	const first = join(realpathSync(f.agent), "first.json");
	const second = join(f.agent, "second.json");
	writeFileSync(first, JSON.stringify(otherPreferences), { mode: 0o600 });
	writeFileSync(second, "{}");
	symlinkSync(first, f.path);
	const read = fs.readFileSync;
	const mock = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
		const value = read(...args);
		if (args[0] === first || args[0] === f.path) {
			rmSync(f.path);
			symlinkSync(second, f.path);
		}
		return value;
	});
	syncBuiltinESMExports();
	try { writeProjectModel(f.project, projectModel); }
	finally { mock.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(lstatSync(f.path).isSymbolicLink(), true);
	assert.equal(readFileSync(f.path, "utf8"), "{}");
	assert.deepEqual(JSON.parse(readFileSync(first, "utf8")), {
		...otherPreferences, projectModels: { [realpathSync(f.project)]: projectModel },
	});
	assert.equal(statSync(first).mode & 0o777, 0o600);
});

test("folder-flush failure gives a command warning instead of plain success", { timeout: 10000 }, async (t) => {
	const f = fixture(t);
	const notices: Array<{ text: string; type: string }> = [];
	let command: ((arg: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const pi = {
		on() {}, registerTool() {}, registerCommand(_name: string, c: { handler: typeof command }) { command = c.handler; },
		getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [], appendEntry() {},
	} as unknown as ExtensionAPI;
	const store = new SlateStore(pi);
	registerSlateMode(pi, store, { startHandoff: async () => {} } as any, () => ({}), () => EMPTY_WORKER_EXTENSION_SET,
		() => undefined, undefined,
		(enabled, path) => saveStartupSummary(enabled, path, {
			syncFolder: () => { throw Object.assign(new Error("disk failure"), { code: "EIO" }); },
		}),
		(cwd, entry) => writeProjectModel(cwd, entry, f.path, entry ? {
			beforeReplace: () => { throw new Error("blocked before replacement"); },
		} : {
			syncFolder: () => { throw Object.assign(new Error("disk failure"), { code: "EIO" }); },
		}));
	const ctx = { cwd: f.project, model: { provider: "provider", id: "vendor/model" }, thinkingLevel: "high",
		mode: "tui", hasUI: true, ui: {
			notify: (text: string, type: string) => notices.push({ text, type }), setWidget() {}, setStatus() {},
		} } as unknown as ExtensionContext;
	assert.ok(command);
	await command!("summary off", ctx);
	assert.equal(readStartupSummary(f.path).enabled, false);
	if (process.platform !== "win32") {
		assert.equal(notices.at(-1)!.type, "warning");
		assert.match(notices.at(-1)!.text, /saved.*may not survive a crash/);
		assert.equal(notices.some((n) => n.type === "info"), false);
	}
	const data = { ...otherPreferences, projectModels: { [realpathSync(f.project)]: projectModel } };
	const bytes = JSON.stringify(data);
	writeFileSync(f.path, bytes);
	await command!("model save", ctx);
	assert.equal(notices.at(-1)!.type, "warning");
	assert.match(notices.at(-1)!.text, /Cannot save.*blocked before replacement/);
	assert.equal(readFileSync(f.path, "utf8"), bytes);
	assert.deepEqual(readdirSync(f.agent), ["slate-preferences.json"]);
	await command!("model clear", ctx);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { ...otherPreferences, projectModels: {} });
	if (process.platform !== "win32") {
		assert.equal(notices.at(-1)!.type, "warning");
		assert.match(notices.at(-1)!.text, /saved.*may not survive a crash/);
	}
});

test("model writes validate the pair and skip replacement when clear has no entry", (t) => {
	const f = fixture(t);
	mkdirSync(f.agent);
	const data = JSON.stringify(otherPreferences);
	writeFileSync(f.path, data);
	assert.throws(() => writeProjectModel(f.project, { ...projectModel, model: "logical-name" }), /provider\/id/);
	writeFileSync(f.path, JSON.stringify({
		...otherPreferences, projectModels: { [realpathSync(f.project)]: { model: projectModel.model } },
	}));
	assert.equal(readProjectModel(f.project).kind, "invalid-entry");
	writeFileSync(f.path, data);
	assert.equal(writeProjectModel(f.project, undefined, f.path, {
		beforeReplace: () => assert.fail("clear must not replace the file"),
	}).saved, undefined);
	assert.equal(readFileSync(f.path, "utf8"), data);
});

test("startup errors warn once and do not stop the session", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	f.snapshot(snapshot());
	mkdirSync(f.agent);
	writeFileSync(f.path, '{"startupSummary":1}');
	await f.start();
	assert.equal(f.notices.filter((n) => n.type === "warning").length, 1);
	assert.ok(f.widgets.has(SUMMARY_WIDGET_KEY));
	writeFileSync(f.path, '{"startupSummary":true}');
	f.breakWidget(true);
	f.notices.length = 0;
	await f.start("reload");
	assert.match(f.notices.at(-1)!.text, /could not show the workflow summary/);
	assert.equal(f.notices.at(-1)!.type, "warning");
});

test("a terminal fixture without a theme keeps its plain widget", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	saveStartupSummary(true);
	f.snapshot(snapshot());
	f.missTheme(true);
	await f.start();
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), PANEL);
	assert.equal(f.notices.filter((notice) => notice.type === "warning").length, 0);
	f.missTheme(false);
	await f.command("summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
});

test("theme failures warn without breaking terminal startup", { timeout: 10000 }, async (t) => {
	const f = harness(t);
	saveStartupSummary(true);
	f.snapshot(snapshot());
	f.breakTheme(true);
	await f.start();
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.equal(f.notices.at(-1)!.type, "warning");
	assert.match(f.notices.at(-1)!.text, /could not show the workflow summary: Error: theme failed/);
	f.breakTheme(false);
	f.breakFg(true);
	f.notices.length = 0;
	await f.command("summary");
	assert.equal(f.widgets.has(SUMMARY_WIDGET_KEY), false);
	assert.equal(f.notices.at(-1)!.type, "warning");
	assert.match(f.notices.at(-1)!.text, /could not show the workflow summary: Error: color failed/);
	f.breakFg(false);
	await f.command("summary");
	assert.deepEqual(f.widgets.get(SUMMARY_WIDGET_KEY), STYLED_PANEL);
});

function giveModel(f: ReturnType<typeof harness>) {
	f.ctx.model = { provider: "provider", id: "new" } as NonNullable<ExtensionContext["model"]>;
	f.ctx.thinkingLevel = "off";
}

async function assertKeyRefused(f: ReturnType<typeof harness>, cwd: string, marker: string, ...keys: string[]) {
	Object.assign(f.ctx, { cwd });
	giveModel(f);
	mkdirSync(f.agent, { recursive: true });
	const bytes = JSON.stringify({
		...otherPreferences, projectModels: Object.fromEntries(keys.map((key) => [key, projectModel])),
	});
	writeFileSync(f.path, bytes);
	const result = readProjectModel(cwd);
	const outcomes = [];
	for (const command of ["model", "model save", "model clear"]) {
		writeFileSync(f.path, bytes);
		await f.command(command);
		const notice = f.notices.at(-1)!;
		outcomes.push({
			command, notice, unchanged: readFileSync(f.path, "utf8") === bytes,
		});
	}
	const refused = outcomes.every(({ notice, unchanged }) =>
		notice.type === "warning" && notice.text.includes("Cannot determine the project key") && notice.text.includes(marker) && unchanged);
	assert.ok(refused, JSON.stringify({ result, outcomes }, null, 2));
	assert.equal(result.kind, "key-unavailable");
	assert.ok(result.reason.includes(marker));
	assert.throws(() => resolveProjectKey(cwd), (error: Error) => error.message.includes(marker));
}

const pointerLimit = 1_048_576;
function paddedGitfile(target: string, size: number) {
	const prefix = "gitdir: " + target;
	return prefix + "\n".repeat(size - Buffer.byteLength(prefix));
}

function commitFixture(cwd: string) {
	gitAt(cwd, "-c", "user.name=Slate Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture", "--allow-empty");
}

test("round three agreement: offline submodule checkout and its Git directory", (t) => {
	const f = fixture(t);
	const source = join(f.root, "source");
	mkdirSync(source);
	for (const cwd of [f.project, source]) gitAt(cwd, "init", "-q");
	commitFixture(source);
	gitAt(f.project, "-c", "protocol.file.allow=always", "submodule", "add", source, "sub");
	const module = join(f.project, "sub");
	const metadata = join(f.project, ".git", "modules", "sub");
	assert.equal(gitKey(module), realpathSync.native(metadata));
	for (const cwd of [module, metadata]) assert.equal(resolveProjectKey(cwd), gitKey(cwd));
});

test("round three agreement: separate Git directory and symbolic working directory", (t) => {
	const f = fixture(t);
	const metadata = join(f.root, "meta");
	gitAt(f.project, "init", "-q", "--separate-git-dir", metadata);
	assert.equal(resolveProjectKey(f.project), gitKey(f.project));
	assert.equal(resolveProjectKey(metadata), gitKey(metadata));
	const alias = join(f.root, "alias");
	symlinkSync(f.project, alias, process.platform === "win32" ? "junction" : "dir");
	assert.equal(resolveProjectKey(alias), gitKey(alias));
});

test("round three agreement: nested unborn HEAD file clear keeps the enclosing entry", (t) => {
	const f = fixture(t);
	const nested = join(f.project, ".pi");
	for (const dir of [f.project, nested]) gitAt(dir, "init", "-q", "-b", "main");
	const parent = gitKey(f.project);
	const own = gitKey(nested);
	assert.notEqual(parent, own);
	assert.equal(resolveProjectKey(nested), own);
	writeProjectModel(f.project, projectModel);
	writeProjectModel(nested, projectModel);
	assert.equal(writeProjectModel(nested, undefined).key, own);
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).projectModels, { [parent]: projectModel });
});

test("round three agreement: a HEAD entry alone does not decide", (t) => {
	const f = fixture(t);
	gitAt(f.project, "init", "-q");
	const cwd = join(f.project, ".pi");
	writeFileSync(join(cwd, "HEAD"), "ref: refs/heads/main\n");
	assert.equal(resolveProjectKey(cwd), gitKey(cwd));
	assert.equal(resolveProjectKey(cwd), gitKey(f.project));
});

test("round three agreement: packed refs after pack-refs and gc", (t) => {
	const f = fixture(t);
	gitAt(f.project, "init", "-q", "-b", "main");
	commitFixture(f.project);
	gitAt(f.project, "pack-refs", "--all");
	gitAt(f.project, "gc");
	assert.match(readFileSync(join(f.project, ".git", "packed-refs"), "utf8"), /refs\/heads\/main/);
	assert.equal(existsSync(join(f.project, ".git", "refs", "heads", "main")), false);
	assert.equal(resolveProjectKey(f.project), gitKey(f.project));
});

test("round three agreement: reftable", (t) => {
	const f = fixture(t);
	try { gitAt(f.project, "init", "-q", "--ref-format=reftable"); }
	catch (error) {
		if (!/unknown option.*ref-format|unsupported.*reftable/i.test(String(error))) throw error;
		t.skip("Installed Git does not support reftable: " + String(error));
		return;
	}
	commitFixture(f.project);
	assert.equal(resolveProjectKey(f.project), gitKey(f.project));
});

test("round three agreement: the HEAD prefix ends at byte 255 and a gitfile is exactly 1 MiB", (t) => {
	const f = fixture(t);
	const metadata = join(f.root, "meta");
	gitAt(f.project, "init", "-q", "--separate-git-dir", metadata);
	const prefix = "ref:" + " ".repeat(246) + "refs/";
	assert.equal(Buffer.byteLength(prefix), 255);
	writeFileSync(join(metadata, "HEAD"), prefix + "heads/main\n");
	writeFileSync(join(f.project, ".git"), paddedGitfile(metadata, pointerLimit));
	assert.equal(resolveProjectKey(f.project), gitKey(f.project));
	assert.equal(resolveProjectKey(f.project), realpathSync.native(metadata));
});

const commonCases = ["missing leaf", "missing intermediate component", "empty", "only line feeds",
	"dangling link", "directory", "oversized", "NUL"] as const;
for (const label of ["empty .git directory", "named pipe", "G2 overlong HEAD", "RG4 oversized gitfile",
	...commonCases.map((form) => "RG5 commondir " + form)] as const) {
	test("round three refusal: " + label, { timeout: 10000 }, async (t) => {
		const f = harness(t);
		gitAt(f.project, "init", "-q");
		const cwd = join(f.project, ".pi");
		const marker = join(cwd, ".git");
		const parent = gitKey(f.project);
		let reasonPath = marker;
		let wrong = marker;
		if (label === "empty .git directory") mkdirSync(marker);
		else if (label === "named pipe") {
			if (process.platform === "win32") { t.skip("Requires a POSIX named pipe"); return; }
			try { execFileSync("mkfifo", [marker], { timeout: 5000 }); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				t.skip("mkfifo is unavailable");
				return;
			}
			const open = fs.openSync;
			const path = join(realpathSync.native(cwd), ".git");
			const mock = t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
				assert.notEqual(args[0], path, "A named pipe must not be opened");
				return open(...args);
			});
			syncBuiltinESMExports();
			t.after(() => {
				mock.mock.restore();
				syncBuiltinESMExports();
				assert.equal(mock.mock.calls.some((call) => call.arguments[0] === path), false);
			});
		} else if (label === "RG4 oversized gitfile") {
			wrong = join(f.root, "bare.git");
			mkdirSync(wrong);
			gitAt(wrong, "init", "-q", "--bare");
			wrong = realpathSync.native(wrong);
			writeFileSync(marker, paddedGitfile(wrong, pointerLimit + 1));
		} else {
			gitAt(cwd, "init", "-q");
			wrong = realpathSync.native(marker);
			if (label === "G2 overlong HEAD") {
				reasonPath = join(wrong, "HEAD");
				writeFileSync(reasonPath, "ref:" + " ".repeat(255) + "refs/heads/main\n");
			} else {
				const common = join(wrong, "commondir");
				reasonPath = common;
				switch (label.slice("RG5 commondir ".length)) {
					case "missing leaf": writeFileSync(common, "missing\n"); break;
					case "missing intermediate component": writeFileSync(common, "missing/child\n"); break;
					case "empty": writeFileSync(common, ""); break;
					case "only line feeds": writeFileSync(common, "\n\n"); break;
					case "dangling link":
						if (process.platform === "win32") { t.skip("Requires a dangling POSIX link"); return; }
						symlinkSync("missing", common);
						break;
					case "directory": mkdirSync(common); break;
					case "oversized": writeFileSync(common, "../../.git\n" + "\n".repeat(pointerLimit)); break;
					case "NUL": writeFileSync(common, "../../.git\0\n"); break;
					default: assert.fail(label);
				}
			}
		}
		const markerPath = join(realpathSync.native(cwd), ".git");
		await assertKeyRefused(f, cwd, reasonPath === marker ? markerPath : reasonPath, parent, wrong);
	});
}

function rawName(prefix: string) {
	return Buffer.concat([Buffer.from(prefix), Buffer.from([255])]);
}

function makeRawFixture(t: test.TestContext, create: () => void) {
	try { create(); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EILSEQ" && code !== "EINVAL") throw error;
		t.skip("The file system does not accept the raw byte in this path: " + String(error));
		return false;
	}
	return true;
}

for (const target of ["working directory", "gitdir pointer", "common directory"] as const) {
	test("round three refusal: raw byte in " + target, {
		timeout: 10000, skip: process.platform === "win32" && "Requires POSIX byte paths",
	}, async (t) => {
		const f = harness(t);
		gitAt(f.project, "init", "-q");
		const parent = gitKey(f.project);
		const prefix = join(f.project, "raw");
		const raw = rawName(prefix);
		const shadow = prefix + "\uFFFD";
		if (!makeRawFixture(t, () => mkdirSync(raw))) return;
		const rawChild = (name: string) => Buffer.concat([raw, Buffer.from("/" + name)]);
		writeFileSync(rawChild("HEAD"), "ref: refs/heads/main\n");
		for (const name of ["objects", "refs"]) mkdirSync(rawChild(name));
		mkdirSync(shadow);
		gitAt(shadow, "init", "-q", "--bare");
		const cwd = join(f.project, ".pi");
		const marker = join(cwd, ".git");
		let start = cwd;
		let reason = join(realpathSync.native(cwd), ".git");
		if (target === "working directory") {
			start = join(f.root, "working-link");
			symlinkSync(raw, start, "dir");
			reason = start;
		} else if (target === "gitdir pointer") {
			writeFileSync(marker, Buffer.concat([Buffer.from("gitdir: ../"), rawName("raw"), Buffer.from("\n")]));
		} else {
			gitAt(cwd, "init", "-q");
			reason = join(realpathSync.native(marker), "commondir");
			writeFileSync(reason, Buffer.concat([Buffer.from("../../"), rawName("raw"), Buffer.from("\n")]));
		}
		await assertKeyRefused(f, start, reason, parent, realpathSync.native(shadow));
		assert.throws(() => resolveProjectKey(start), /real path is not valid text/);
	});
}

for (const level of ["agent directory", "store file"] as const) {
	test("round three store refusal: RG2 raw byte at " + level, {
		timeout: 10000, skip: process.platform === "win32" && "Requires POSIX byte paths",
	}, async (t) => {
		const f = harness(t);
		giveModel(f);
		const prefix = join(f.root, "raw");
		const raw = rawName(prefix);
		const shadow = prefix + "\uFFFD";
		let actual: Buffer = raw;
		let decoy = shadow;
		let link = f.path;
		if (level === "agent directory") {
			link = f.agent;
			if (!makeRawFixture(t, () => mkdirSync(raw))) return;
			mkdirSync(shadow);
			actual = Buffer.concat([raw, Buffer.from("/slate-preferences.json")]);
			decoy = preferencePath(shadow);
		} else mkdirSync(f.agent);
		symlinkSync(raw, link, level === "agent directory" ? "dir" : "file");
		const key = realpathSync.native(f.project);
		const bytes = JSON.stringify({ startupSummary: false, projectModels: { [key]: projectModel } });
		const shadowBytes = JSON.stringify({ startupSummary: false, projectModels: { [key]: { ...projectModel, model: "provider/shadow" } } });
		if (!makeRawFixture(t, () => writeFileSync(actual, bytes))) return;
		writeFileSync(decoy, shadowBytes);
		const summary = readStartupSummary(f.path);
		const outcomes = [];
		for (const command of ["summary on", "model", "model save", "model clear"]) {
			writeFileSync(decoy, shadowBytes);
			await f.command(command);
			outcomes.push({
				command, notice: f.notices.at(-1)!,
				sameTarget: readFileSync(actual, "utf8") === bytes,
				sameShadow: readFileSync(decoy, "utf8") === shadowBytes,
			});
		}
		const refused = outcomes.every(({ notice, sameTarget, sameShadow }) =>
			notice.type === "warning" && /Cannot read.*not valid text/.test(notice.text) && sameTarget && sameShadow);
		assert.ok(refused, JSON.stringify({ summary, outcomes }, null, 2));
		assert.match(readStartupSummary(f.path).warning ?? "", /Cannot read.*not valid text/);
		assert.equal(lstatSync(link).isSymbolicLink(), true);
	});
}

for (const operation of ["summary", "model"] as const) {
	for (const form of ["existing", "missing store", "missing agent", "dangling link"] as const) {
		test("round three store: " + operation + ", " + form, (t) => {
			const f = fixture(t);
			if (form !== "missing agent") mkdirSync(f.agent);
			const key = realpathSync.native(f.project);
			const initial = { startupSummary: false, extra: 123, projectModels: { [key]: projectModel } };
			const save = () => operation === "summary" ? saveStartupSummary(true, f.path) : writeProjectModel(f.project, { ...projectModel, model: "provider/new" }, f.path);
			if (form === "dangling link") {
				if (process.platform === "win32") { t.skip("Requires a dangling POSIX link"); return; }
				const missing = join(f.agent, "missing.json");
				symlinkSync(missing, f.path);
				assert.match(readStartupSummary(f.path).warning ?? "", /Cannot read/);
				assert.equal(readProjectModel(f.project, f.path).kind, "store-unreadable");
				assert.throws(save, /Cannot read/);
				assert.equal(existsSync(missing), false);
				assert.equal(lstatSync(f.path).isSymbolicLink(), true);
			} else {
				if (form === "existing") writeFileSync(f.path, JSON.stringify(initial), { mode: 0o600 });
				else {
					assert.deepEqual(readStartupSummary(f.path), { enabled: false });
					assert.equal(readProjectModel(f.project, f.path).kind, "none");
				}
				save();
				const expected = form === "existing" ? initial : {};
				assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), operation === "summary"
					? { ...expected, startupSummary: true }
					: { ...expected, projectModels: { [key]: { ...projectModel, model: "provider/new" } } });
				if (form === "existing" && process.platform !== "win32") assert.equal(statSync(f.path).mode & 0o777, 0o600);
			}
			assert.deepEqual(readdirSync(f.agent), ["slate-preferences.json"]);
		});
	}
}

for (const command of ["summary on", "model save"]) {
	for (const form of ["link alone", "link with text sibling", "missing agent below link"] as const) {
		test("RG2 first write: " + command + ", " + form, {
			timeout: 10000, skip: process.platform === "win32" && "Requires POSIX byte paths",
		}, async (t) => {
			const f = harness(t);
			giveModel(f);
			const prefix = join(f.root, "raw");
			const raw = rawName(prefix);
			if (!makeRawFixture(t, () => mkdirSync(raw))) return;
			symlinkSync(raw, f.agent, "dir");
			const shadow = prefix + "\uFFFD";
			if (form !== "link alone") mkdirSync(shadow);
			if (form === "missing agent below link") process.env.PI_CODING_AGENT_DIR = join(f.agent, "missing");

			assert.deepEqual(readStartupSummary(), { enabled: false });
			assert.deepEqual(readProjectModel(f.project), { kind: "none", key: realpathSync.native(f.project) });
			await f.command(command);
			const notice = f.notices.at(-1)!;
			const actual = readdirSync(raw);
			const sibling = existsSync(shadow) ? readdirSync(shadow) : null;
			assert.deepEqual({ type: notice.type, actual, sibling },
				{ type: "warning", actual: [], sibling: form === "link alone" ? null : [] },
				JSON.stringify({ notice, actual, sibling }));
			assert.match(notice.text, /real path is not valid text/);
		});
	}
}

test("RG2 process cwd: commands refuse a lossy working directory", {
	timeout: 10000, skip: process.platform === "win32" && "Requires POSIX byte paths",
}, async (t) => {
	const f = harness(t);
	const prefix = join(f.root, "raw-");
	const raw = rawName(prefix);
	if (!makeRawFixture(t, () => mkdirSync(raw))) return;
	const shadow = prefix + "\uFFFD";
	mkdirSync(shadow);
	const key = realpathSync.native(shadow);
	const alias = join(f.root, "working-link");
	symlinkSync(raw, alias, "dir");
	const previous = process.cwd();
	try {
		process.chdir(alias);
		assert.equal(process.cwd(), key);
		const native = realpathSync.native(".", { encoding: "buffer" });
		assert.equal(native.subarray(-5).toString("hex"), "7261772dff");
		t.diagnostic("native basename hex=" + native.subarray(-5).toString("hex") +
			", process.cwd basename=" + JSON.stringify(process.cwd().split("/").at(-1)));
		await assertKeyRefused(f, process.cwd(), "real path is not valid text", key);
	} finally {
		process.chdir(previous);
	}
});

test("project key: an ordinary process cwd resolves to the same key", { timeout: 10000 }, (t) => {
	const f = fixture(t);
	gitAt(f.project, "init", "-q");
	const expected = gitKey(f.project);
	const previous = process.cwd();
	try {
		process.chdir(join(f.project, ".pi"));
		assert.equal(resolveProjectKey(process.cwd()), expected);
	} finally {
		process.chdir(previous);
	}
});

test("the short phase list follows all nine lifecycle phases in the shipped document", () => {
	const section = readFileSync(TRACK_WORKFLOW_DOC, "utf8").split("## Lifecycle and phases\n")[1]!.split("\nThe cumulative implementation")[0]!;
	const phases = [...section.matchAll(/^\d+\. (.*(?:\n(?!\d+\.|\n)[ \t]+.*)*)/gm)].map((match) => match[1]!.replace(/\s+/g, " ").trim());
	assert.deepEqual(phases, [
		"research.",
		"assess and record all eleven risk lines.",
		"design and validate for a multi-track change, a proved DESIGN-TRIGGERING area, or a per-track estimate above 100 counted lines.",
		"when a design exists, reconfirm the focus list against the validated design.",
		"when a design exists, run one adversarial design review for each proved DESIGN-TRIGGERING area that has not reviewed the applicable design.",
		"when a design exists, obtain final design approval.",
		"run the track loop.",
		"obtain blocking final acceptance.",
		"deliver.",
	]);
	assert.deepEqual(renderStartupSummary(), PANEL);
	const labels = PANEL.slice(1, 7).map((line, index) => {
		const match = /^(\d+)\. ([^:]+):/.exec(line);
		assert.ok(match);
		assert.equal(Number(match[1]), index + 1);
		return match[2];
	});
	// Each panel step is tied to its governing phase or contiguous phase group.
	assert.deepEqual([
		[labels[0], phases.slice(0, 1)],
		[labels[1], phases.slice(1, 2)],
		[labels[2], phases.slice(2, 6)],
		[labels[3], phases.slice(6, 7)],
		[labels[4], phases.slice(7, 8)],
		[labels[5], phases.slice(8, 9)],
	], [
		["Research", ["research."]],
		["Risks", ["assess and record all eleven risk lines."]],
		["Solution", phases.slice(2, 6)],
		["Tracks", ["run the track loop."]],
		["Final acceptance", ["obtain blocking final acceptance."]],
		["Delivery", ["deliver."]],
	]);
});
