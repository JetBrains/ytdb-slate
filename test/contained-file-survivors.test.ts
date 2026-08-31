import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	readContainedFile,
	withContainedFile,
	type CorpusProject,
} from "../extension/corpus.ts";
import {
	SLATE_STATE_FORMAT,
	SlateStore,
	type EpisodeRecord,
	type ThreadRecord,
} from "../extension/state.ts";

interface Workspace {
	root: string;
	cwd: string;
	project: CorpusProject;
	sessionDirectory: string;
}

function workspace(t: TestContext): Workspace {
	const root = mkdtempSync(join(tmpdir(), "slate-contained-survivors."));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "worktree");
	const projectDirectory = join(root, "corpus", "project-0123456789ab");
	const sessionDirectory = join(projectDirectory, "calm-otter-7f3a");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(sessionDirectory, "episodes"), { recursive: true });
	return {
		root,
		cwd,
		project: {
			root: join(root, "corpus"),
			key: cwd,
			label: "project",
			digest: "0123456789ab",
			directory: projectDirectory,
			matchingDirectories: [],
		},
		sessionDirectory,
	};
}

function completedThread(): ThreadRecord {
	return {
		id: "t1",
		name: "completed action",
		status: "successful",
		type: "general",
		episodeId: "t1.e1",
		createdAt: 1,
		updatedAt: 2,
	};
}

function episode(file: string): EpisodeRecord {
	return {
		id: "t1.e1",
		threadId: "t1",
		task: "preserve evidence",
		status: "ok",
		file,
		createdAt: 2,
	};
}

test("ordinary contained reads accept a hard-linked episode", (t) => {
	const box = workspace(t);
	const file = join(box.sessionDirectory, "episodes", "t1.e1.md");
	writeFileSync(file, "durable evidence");
	linkSync(file, join(box.root, "episode-backup.md"));

	assert.equal(
		readContainedFile(box.cwd, file, box.project.directory)?.toString("utf8"),
		"durable evidence",
	);
});

test("snapshot adoption retains episode metadata when its file open is refused", (t) => {
	const box = workspace(t);
	const outside = join(box.root, "outside-episode.md");
	writeFileSync(outside, "evidence outside approved storage");
	const appended: unknown[] = [];
	const notices: string[] = [];
	const store = new SlateStore({
		appendEntry(_type: string, data: unknown) { appended.push(data); },
	} as unknown as ExtensionAPI);
	store.corpusProject = box.project;
	store.adoptSnapshot({
		format: SLATE_STATE_FORMAT,
		threads: [completedThread()],
		episodes: [episode(outside)],
		threadSeq: 1,
		orchestratorMode: false,
		paused: false,
		workerCostUsd: 0,
		carriedCostUsd: 0,
	}, {
		cwd: box.cwd,
		hasUI: true,
		ui: { notify(message: string) { notices.push(message); } },
	} as unknown as ExtensionContext);

	assert.equal(store.threads.get("t1")?.episodeId, "t1.e1");
	assert.equal(store.episodes.get("t1.e1")?.file, outside);
	assert.match(notices.join("\n"), /episode t1\.e1: retaining file, but refusing its use/);
	store.save();
	const saved = appended.at(-1) as { episodes?: EpisodeRecord[] } | undefined;
	assert.equal(saved?.episodes?.[0]?.file, outside);
});

test("contained reads refuse a named pipe without blocking", { timeout: 30000 }, (t) => {
	const box = workspace(t);
	const fifo = join(box.sessionDirectory, "episodes", "blocking.md");
	try {
		execFileSync("mkfifo", [fifo]);
	} catch (error) {
		t.skip(`mkfifo is unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "extension", "corpus.ts")).href;
	const child = `
		const { readContainedFile } = await import(${JSON.stringify(moduleUrl)});
		console.log(String(readContainedFile(${JSON.stringify(box.cwd)}, ${JSON.stringify(fifo)}, ${JSON.stringify(box.project.directory)})));
	`;
	const answer = execFileSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", child],
		{
			cwd: join(import.meta.dirname, ".."),
			encoding: "utf8",
			timeout: 10000,
			killSignal: "SIGKILL",
		},
	).trim();
	assert.equal(answer, "undefined");
});

test("contained-read callback failures do not leak file descriptors", (t) => {
	const descriptors = "/proc/self/fd";
	if (!existsSync(descriptors)) {
		t.skip("/proc/self/fd is unavailable");
		return;
	}
	const box = workspace(t);
	const file = join(box.sessionDirectory, "episodes", "t1.e1.md");
	writeFileSync(file, "evidence");
	const before = readdirSync(descriptors).length;

	for (let attempt = 0; attempt < 40; attempt++) {
		assert.throws(
			() => withContainedFile(box.cwd, file, box.project.directory, (fd) => {
				assert.equal(readFileSync(fd, "utf8"), "evidence");
				throw new Error("forced callback refusal after open");
			}),
			/^Error: forced callback refusal after open$/,
		);
	}

	assert.equal(readdirSync(descriptors).length, before, "every opened descriptor must be closed");
});
