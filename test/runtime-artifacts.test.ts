import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRuntimeStorageFolder, isRuntimeStorageFolder, isSlateArtifactReference, slateArtifactReference } from "../extension/artifact-names.ts";
import { captureObservation, durableObservation, type ObservationRecord } from "../extension/observations.ts";
import { ensureRuntimeDirectory, writeSlateArtifact } from "../extension/slate-files.ts";
import { resolveEpisodeFile, SLATE_STATE_FORMAT, SlateStore, type SlateSnapshot } from "../extension/state.ts";

function withProject(run: (project: string, outside: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "slate-runtime-artifacts-"));
  const project = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  try { run(project, outside); } finally { rmSync(root, { recursive: true, force: true }); }
}

function store(): SlateStore {
  return new SlateStore({ appendEntry() {} } as unknown as ExtensionAPI);
}

function snapshot(id: string, file: string, observations?: ObservationRecord): SlateSnapshot {
  const threadId = id.split(".")[0]!;
  return {
    format: SLATE_STATE_FORMAT,
    threads: [{ id: threadId, name: "saved", status: "successful", type: "general", episodeId: id, createdAt: 1, updatedAt: 1 }],
    episodes: [{ id, threadId, task: "saved", status: "ok", file, ...(observations ? { observations } : {}), createdAt: 1 }],
    orchestratorMode: false, paused: false, workerCostUsd: 0, carriedCostUsd: 0,
  };
}

function restore(current: SlateStore, data: SlateSnapshot, project: string): void {
  current.adoptSnapshot(data, { cwd: project, hasUI: false } as ExtensionContext);
}

test("two runtimes of one saved session keep separate files with the same visible episode id", () => {
  withProject((project) => {
    const first = store();
    const second = store();
    assert.notEqual(first.runtimeFolder, second.runtimeFolder);
    assert.equal(existsSync(join(project, ".pi", "slate", first.runtimeFolder)), false);
    const a = writeSlateArtifact({ cwd: project, folder: first.runtimeFolder, kind: "episodes", id: "t3.e1", content: "first" });
    const b = writeSlateArtifact({ cwd: project, folder: second.runtimeFolder, kind: "episodes", id: "t3.e1", content: "second" });
    assert.notEqual(a.absolutePath, b.absolutePath);
    restore(first, snapshot("t3.e1", a.absolutePath), project);
    restore(second, snapshot("t3.e1", b.absolutePath), project);
    assert.equal(resolveEpisodeFile(project, first.episodes.get("t3.e1")?.file), a.absolutePath);
    assert.equal(resolveEpisodeFile(project, second.episodes.get("t3.e1")?.file), b.absolutePath);
    assert.equal(readFileSync(a.absolutePath, "utf8"), "first");
    assert.equal(readFileSync(b.absolutePath, "utf8"), "second");
  });
});

test("a reload after a tree rollback chooses a new folder and keeps the earlier bytes", () => {
  withProject((project) => {
    const current = store();
    const previous = current.runtimeFolder;
    const old = writeSlateArtifact({ cwd: project, folder: previous, kind: "episodes", id: "t1.e1", content: "before tree" });
    const branch = snapshot("t1.e1", old.absolutePath);
    current.startRuntime();
    restore(current, branch, project);
    assert.notEqual(current.runtimeFolder, previous);
    const fresh = writeSlateArtifact({ cwd: project, folder: current.runtimeFolder, kind: "episodes", id: "t1.e1", content: "after reload" });
    assert.equal(readFileSync(old.absolutePath, "utf8"), "before tree");
    assert.equal(readFileSync(fresh.absolutePath, "utf8"), "after reload");
    assert.notEqual(old.absolutePath, fresh.absolutePath);
  });
});

test("legacy flat and scoped episode and observation references survive one restore", () => {
  withProject((project) => {
    const current = store();
    const old = join(project, ".pi", "slate", "episodes", "t1.e1.md");
    mkdirSync(join(project, ".pi", "slate", "episodes"), { recursive: true });
    writeFileSync(old, "legacy");
    const scoped = writeSlateArtifact({ cwd: project, folder: current.runtimeFolder, kind: "episodes", id: "t2.e1", content: "scoped" });
    const observation = captureObservation(project, "t2.e1", "finding", current.runtimeFolder);
    assert.equal(observation.stored, true);
    const mixed = snapshot("t1.e1", old);
    const newer = snapshot("t2.e1", scoped.absolutePath, durableObservation(observation));
    mixed.threads.push(...newer.threads);
    mixed.episodes.push(...newer.episodes);
    restore(current, mixed, project);
    assert.deepEqual([...current.episodes.keys()], ["t1.e1", "t2.e1"]);
    assert.equal(current.episodes.get("t1.e1")?.file, old);
    assert.deepEqual(current.episodes.get("t2.e1")?.observations, observation.stored ? { stored: true, path: observation.path, bytes: observation.bytes, truncated: observation.truncated, grammar: observation.grammar } : undefined);
    assert.equal(resolveEpisodeFile(project, scoped.absolutePath), scoped.absolutePath);
  });
});

test("scoped reads refuse escaped, malformed and symbolic-link paths", () => {
  withProject((project, outside) => {
    const folder = createRuntimeStorageFolder();
    const stored = writeSlateArtifact({ cwd: project, folder, kind: "episodes", id: "t1.e1", content: "safe" });
    const victim = join(outside, "victim.md");
    writeFileSync(victim, "outside");
    assert.equal(resolveEpisodeFile(project, victim), undefined);
    const invalid = folder.replace("runtime-", "invalid-");
    const wrong = join(project, ".pi", "slate", invalid, "episodes", "t1.e1.md");
    mkdirSync(join(project, ".pi", "slate", invalid, "episodes"), { recursive: true });
    writeFileSync(wrong, "wrong");
    assert.equal(resolveEpisodeFile(project, wrong), undefined);
    assert.equal(isSlateArtifactReference(`.pi/slate/${invalid}/observations/t1.e1.md`), false);
    const link = join(project, ".pi", "slate", folder, "episodes", "t2.e1.md");
    symlinkSync(victim, link);
    assert.equal(resolveEpisodeFile(project, link), undefined);
    assert.equal(resolveEpisodeFile(project, stored.absolutePath), stored.absolutePath);
  });
});

test("worker transcript directory refuses a symbolic-link parent and invalid folder names with reasons", () => {
  withProject((project, outside) => {
    const folder = createRuntimeStorageFolder();
    mkdirSync(join(project, ".pi", "slate"), { recursive: true });
    symlinkSync(outside, join(project, ".pi", "slate", folder));
    assert.throws(() => ensureRuntimeDirectory(project, folder, "threads"), /symbolic link/);
    assert.deepEqual(readdirSync(outside), []);
    assert.throws(() => ensureRuntimeDirectory(project, "../escape", "threads"), /invalid runtime storage folder name/);
    assert.throws(() => writeSlateArtifact({ cwd: project, folder: "runtime-bad", kind: "episodes", id: "t1.e1", content: "x" }), /invalid runtime storage folder name/);
    assert.equal(isRuntimeStorageFolder(folder), true);
    assert.equal(isSlateArtifactReference(slateArtifactReference("episodes", "t1.e1", folder), "episodes", "t1.e1"), true);
  });
});
