import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentBranchLabel, resolveCorpusProject, type CorpusProject } from "../extension/corpus.ts";
import { writeCorpusHandoffRecord } from "../extension/handoff-record.ts";
import slateExtension from "../extension/index.ts";
import { SLATE_BINDING_CUSTOM_TYPE } from "../extension/runtime-authority.ts";
import { createDurableSession } from "../extension/session-record.ts";
import { fakeContext, FakeExtensionHost, startSession } from "./startup-harness.ts";

interface Lab {
	root: string;
	cwd: string;
	project: CorpusProject;
	close(): void;
}

function lab(name: string): Lab {
	const root = mkdtempSync(join(tmpdir(), `slate-startup-wiring-${name}.`));
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agent);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	return {
		root,
		cwd,
		// No corpus label: the extension resolves the same project directory itself.
		project: resolveCorpusProject(cwd),
		close() {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function namespaces(project: CorpusProject): string[] {
	if (!existsSync(project.directory)) return [];
	return readdirSync(project.directory).filter((name) => /^[a-z]+-[a-z]+-[0-9a-f]{4}$/.test(name)).sort();
}

test("startup prepares storage, and the first mode change writes exactly one locator note", { timeout: 5_000 }, async (t) => {
	const box = lab("first-change");
	t.after(() => box.close());
	const host = new FakeExtensionHost();
	host.setActiveTools(["read", "bash"]);
	slateExtension(host.api);
	const ctx = fakeContext(host, { cwd: box.cwd, sessionId: "one", sessionFile: join(box.root, "one.jsonl") });
	await startSession(host, ctx);
	assert.deepEqual(host.entries, []);
	assert.deepEqual(namespaces(box.project), []);

	const command = host.commands.get("slate");
	assert.ok(command);
	await command("on", ctx);
	const created = namespaces(box.project);
	assert.equal(created.length, 1);
	assert.deepEqual(host.notes("slate-state"), []);
	const notes = host.notes(SLATE_BINDING_CUSTOM_TYPE);
	assert.equal(notes.length, 1);
	assert.equal(notes[0]?.name, created[0]);
	assert.equal(notes[0]?.policy, "durable-session-v1");

	// Two more saved changes keep one note and one namespace.
	await command("off", ctx);
	await command("on", ctx);
	assert.equal(host.notes(SLATE_BINDING_CUSTOM_TYPE).length, 1);
	assert.deepEqual(namespaces(box.project), created);

	// A resumed Pi session over the same branch restores the stored mode.
	const resumed = new FakeExtensionHost();
	resumed.entries.push(...host.entries);
	resumed.setActiveTools(["read", "bash"]);
	slateExtension(resumed.api);
	const resumedCtx = fakeContext(resumed, {
		cwd: box.cwd,
		sessionId: "two",
		sessionFile: join(box.root, "two.jsonl"),
	});
	await startSession(resumed, resumedCtx);
	assert.deepEqual(resumed.getActiveTools(), ["read", "grep", "find", "ls", "thread", "threads", "episode"]);
	assert.equal(resumed.notes(SLATE_BINDING_CUSTOM_TYPE).length, 1);
	assert.deepEqual(namespaces(box.project), created);
});

test("a conversation holding only old entries starts a new Slate session in silence", { timeout: 5_000 }, async (t) => {
	const box = lab("old-entries");
	t.after(() => box.close());
	const host = new FakeExtensionHost();
	host.entries.push({
		type: "custom",
		customType: "slate-state",
		data: {
			threads: [{
				id: "t1",
				name: "old action",
				status: "successful",
				type: "general",
				episodeId: "t1.e1",
				createdAt: 1,
				updatedAt: 2,
			}],
			episodes: [],
			orchestratorMode: true,
			paused: true,
			workerCostUsd: 9,
			carriedCostUsd: 0,
		},
	});
	slateExtension(host.api);
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	const ctx = fakeContext(host, { cwd: box.cwd, sessionId: "old", sessionFile: join(box.root, "old.jsonl") });
	await startSession(host, ctx);
	// No message names the old entries, and no record of theirs is restored.
	assert.deepEqual(warnings, []);
	assert.deepEqual(namespaces(box.project), []);

	const command = host.commands.get("slate");
	assert.ok(command);
	await command("on", ctx);
	const notes = host.notes(SLATE_BINDING_CUSTOM_TYPE);
	assert.equal(notes.length, 1);
	assert.equal(namespaces(box.project).length, 1);
	// The old entry is still in the conversation, and it is unused data.
	assert.equal(host.notes("slate-state").length, 1);
});

test("the orchestrator mode seed treats a locator note as an unfresh branch", { timeout: 5_000 }, async (t) => {
	const box = lab("seed");
	t.after(() => box.close());
	const seeded = new FakeExtensionHost();
	slateExtension(seeded.api);
	const seededCtx = fakeContext(seeded, {
		cwd: box.cwd,
		sessionId: "seed",
		sessionFile: join(box.root, "seed.jsonl"),
		mode: "tui",
	});
	mkdirSync(join(box.cwd, ".pi"));
	const { writeFileSync } = await import("node:fs");
	writeFileSync(join(box.cwd, ".pi", "slate.json"), JSON.stringify({ orchestratorModeDefault: true }));
	await startSession(seeded, seededCtx);
	// A branch with no locator note is fresh, so the configured default applies.
	assert.deepEqual(seeded.getActiveTools(), ["read", "grep", "find", "ls", "thread", "threads", "episode"]);

	// The same branch after a locator note exists: the seed no longer applies, and
	// the stored mode decides. The namespace below stores mode OFF.
	const command = seeded.commands.get("slate");
	assert.ok(command);
	await command("off", seededCtx);
	assert.equal(seeded.notes(SLATE_BINDING_CUSTOM_TYPE).length, 1);
	const resumed = new FakeExtensionHost();
	resumed.entries.push(...seeded.entries);
	resumed.setActiveTools(["read", "bash"]);
	slateExtension(resumed.api);
	await startSession(resumed, fakeContext(resumed, {
		cwd: box.cwd,
		sessionId: "resumed-seed",
		sessionFile: join(box.root, "resumed.jsonl"),
		mode: "tui",
	}));
	assert.deepEqual(resumed.getActiveTools(), ["read", "bash"]);
});

test("a start that cannot select storage reports every refused change", { timeout: 5_000 }, async (t) => {
	const box = lab("refusal");
	t.after(() => box.close());
	const host = new FakeExtensionHost();
	slateExtension(host.api);
	const ctx = fakeContext(host, {
		cwd: box.cwd,
		sessionId: "refusing",
		sessionFile: join(box.root, "refusing.jsonl"),
	});
	host.entries.push(
		{
			type: "custom",
			customType: SLATE_BINDING_CUSTOM_TYPE,
			data: { policy: "durable-session-v1", identity: "20260828T120000Z-0123abcd0123abcd", name: "calm-otter-7f3a" },
		},
		{
			type: "custom",
			customType: SLATE_BINDING_CUSTOM_TYPE,
			data: { policy: "durable-session-v1", identity: "20260828T120001Z-deadbeefdeadbeef", name: "brisk-bison-abcd" },
		},
	);
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	await startSession(host, ctx);
	assert.match(warnings.join("\n"), /conflicting Pi binding relationships/);

	const command = host.commands.get("slate");
	assert.ok(command);
	const toolsBefore = host.getActiveTools();
	await command("on", ctx);
	assert.match(warnings.join("\n"), /the mode change was not saved/);
	assert.deepEqual(host.getActiveTools(), toolsBefore);
	assert.equal(host.notes(SLATE_BINDING_CUSTOM_TYPE).length, 2);
	assert.deepEqual(namespaces(box.project), []);

	await command("resume", ctx);
	assert.match(warnings.join("\n"), /the resume was not saved/);
});

test("a start without a corpus project refuses every state change", { timeout: 5_000 }, async (t) => {
	const box = lab("missing-cwd");
	t.after(() => box.close());
	const host = new FakeExtensionHost();
	slateExtension(host.api);
	const ctx = fakeContext(host, {
		cwd: box.cwd,
		sessionId: "missing-cwd",
		sessionFile: join(box.root, "missing-cwd.jsonl"),
	});
	// The corpus project is the parent of every external namespace. Without a
	// working directory it cannot resolve, so startup has no storage to select.
	rmSync(box.cwd, { recursive: true, force: true });
	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	await assert.doesNotReject(startSession(host, ctx));
	assert.match(warnings.join("\n"), /could not resolve the corpus project.*refuses every state change/);
	assert.deepEqual(host.entries, []);

	const command = host.commands.get("slate");
	assert.ok(command);
	await command("on", ctx);
	assert.match(warnings.join("\n"), /the mode change was not saved.*no corpus project in this Pi session/s);
	assert.deepEqual(host.entries, []);
});

test("a handoff continues one Slate session in another Pi session", { timeout: 10_000 }, async (t) => {
	const box = lab("handoff");
	t.after(() => box.close());
	const sender = new FakeExtensionHost();
	slateExtension(sender.api);
	const senderCtx: ExtensionContext = fakeContext(sender, {
		cwd: box.cwd,
		sessionId: "sender",
		sessionFile: join(box.root, "sender.jsonl"),
	});
	await startSession(sender, senderCtx);
	const senderCommand = sender.commands.get("slate");
	assert.ok(senderCommand);
	await senderCommand("on", senderCtx);
	const created = namespaces(box.project);
	assert.equal(created.length, 1);
	const name = created[0]!;

	const warnings: string[] = [];
	t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
	await senderCommand("handoff continue the work", senderCtx);
	assert.match(warnings.join("\n"), new RegExp(`handoff record written for ${name}`));
	assert.equal(existsSync(join(box.project.directory, "pending", `${name}.json`)), true);
	const handoffRaw = JSON.parse((await import("node:fs")).readFileSync(join(box.project.directory, "pending", `${name}.json`), "utf8")) as Record<string, unknown>;
	assert.equal(typeof handoffRaw.carriedCostUsd, "number");
	assert.equal(Object.hasOwn(handoffRaw, "snapshot"), false);

	// THE RECEIVING PI SESSION. It has its own conversation and no locator note.
	const receiver = new FakeExtensionHost();
	receiver.setActiveTools(["read", "bash"]);
	slateExtension(receiver.api);
	const receiverCtx = fakeContext(receiver, {
		cwd: box.cwd,
		sessionId: "receiver",
		sessionFile: join(box.root, "receiver.jsonl"),
	});
	await startSession(receiver, receiverCtx);
	await receiver.commands.get("slate")!(`adopt ${name}`, receiverCtx);
	assert.match(warnings.join("\n"), /adopted successfully/);
	assert.equal(receiver.sent.at(-1)?.customType, "slate-kickoff");
	// Exactly one locator note, the adopted namespace, and no second namespace.
	const notes = receiver.notes(SLATE_BINDING_CUSTOM_TYPE);
	assert.equal(notes.length, 1);
	assert.equal(notes[0]?.name, name);
	assert.deepEqual(namespaces(box.project), created);
	assert.deepEqual(receiver.notes("slate-state"), []);

	// A REPEATED adoption of the SAME namespace completes the receiving association
	// instead of refusing it, and it writes no second note (BG1502/CN1506).
	warnings.length = 0;
	await receiver.commands.get("slate")!(`adopt ${name}`, receiverCtx);
	assert.match(warnings.join("\n"), /was already adopted in this Pi session/);
	assert.equal(receiver.notes(SLATE_BINDING_CUSTOM_TYPE).length, 1);
	assert.deepEqual(namespaces(box.project), created);

	// A repeated adoption of ANOTHER namespace is still refused, because this Pi
	// session would abandon the records it continues.
	const other = createDurableSession({
		cwd: box.cwd,
		project: box.project,
		identity: "20260828T120000Z-0123abcd0123abcd",
		name: "brisk-bison-abcd",
		creatorSessionDigest: "c".repeat(64),
		runtime: {
			threads: [], episodes: [], threadSeq: 0, slateSessionParentChain: [],
			orchestratorMode: true, paused: false, workerCostUsd: 0, carriedCostUsd: 0,
		},
	});
	writeCorpusHandoffRecord(box.project, {
		version: 1,
		author: { identity: "20260828T120000Z-0123abcd0123abcd", name: "brisk-bison-abcd" },
		authorSessionDirectory: other.directory,
		createdAt: Date.now(),
		worktreePath: realpathSync(box.cwd),
		branchLabel: currentBranchLabel(box.cwd),
		parentChain: [],
		brief: "another session",
		carriedCostUsd: 0,
	});
	warnings.length = 0;
	await receiver.commands.get("slate")!("adopt brisk-bison-abcd", receiverCtx);
	assert.match(warnings.join("\n"), new RegExp(`already continues Slate session ${name}`));
	assert.equal(receiver.notes(SLATE_BINDING_CUSTOM_TYPE).length, 1);
	assert.equal(receiver.notes(SLATE_BINDING_CUSTOM_TYPE)[0]?.name, name);
});
