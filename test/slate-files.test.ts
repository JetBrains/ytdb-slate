import assert from "node:assert/strict";
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { captureObservation } from "../extension/observations.ts";
import {
  isSlateArtifactId,
  isSlateArtifactReference,
  slateArtifactDir,
  SLATE_ARTIFACT_REFERENCE_MAX_BYTES,
  SlateWriteRefused,
  removeSlateArtifact,
  writeSlateArtifact,
} from "../extension/slate-files.ts";

/**
 * SE1 and SE2 regression suite. Every hostile layout is built in a temporary
 * directory OUTSIDE the repository, and every case asserts that the file outside
 * the project is not modified.
 */
function lab(): { root: string; project: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "slate-write-test."));
  const project = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { root, project, outside };
}

function withLab(run: (paths: { root: string; project: string; outside: string }) => void): void {
  const paths = lab();
  try {
    run(paths);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
}

/** A victim file with a distinctive mode, exactly as the security review used. */
function victim(outside: string): string {
  const file = join(outside, ".bashrc");
  writeFileSync(file, "ORIGINAL VICTIM CONTENT\n", { mode: 0o700 });
  return file;
}

function observationsDir(project: string): string {
  return slateArtifactDir(project, "observations");
}

const REJECTED_IDS = [
  ["traversal segment", "../../../../outside/notes"],
  ["absolute path", "/etc/passwd"],
  ["empty id", ""],
  ["dots only", ".."],
  ["single dot", "."],
  ["separator", "a/b"],
  ["valid prefix then traversal", "t1.e1/../../x"],
  ["backslash separator", "t1.e1\\..\\..\\x"],
  ["null byte", "t1.e1\u0000x"],
  ["trailing space", "t1.e1 "],
  ["no episode part", "t1"],
  ["negative episode", "t1.e-1"],
  ["fractional episode", "t1.e1.5"],
  ["unsafe episode", `t1.e${Number.MAX_SAFE_INTEGER + 1}`],
  ["portable forbidden character", "review:main.e1"],
];

test("generated and safe restored episode ids are accepted without a digit cap", () => {
  for (const [label, id] of REJECTED_IDS) {
    assert.equal(isSlateArtifactId(id), false, `${label} must be rejected`);
  }
  for (const id of ["t1.e1", "review-main.e1", `t${Number.MAX_SAFE_INTEGER}.e${Number.MAX_SAFE_INTEGER}`]) {
    assert.equal(isSlateArtifactId(id), true, `${id} must be accepted`);
  }
});

test("the canonical reference validator enforces the exact UTF-8 boundary", () => {
  const overhead = Buffer.byteLength(".pi/slate/observations/.md");
  const exact = `${"a".repeat(SLATE_ARTIFACT_REFERENCE_MAX_BYTES - overhead - 3)}.e1`;
  const reference = `.pi/slate/observations/${exact}.md`;
  assert.equal(Buffer.byteLength(reference), SLATE_ARTIFACT_REFERENCE_MAX_BYTES);
  assert.equal(isSlateArtifactId(exact), true);
  assert.equal(isSlateArtifactReference(reference, "observations", exact), true);
  assert.equal(isSlateArtifactId(`a${exact}`), false);
  assert.equal(isSlateArtifactReference(`.pi/slate/observations/a${exact}.md`, "observations"), false);
});

test("a rejected id writes no file and destroys nothing outside the project", () => {
  withLab(({ project, outside }) => {
    const keep = join(outside, "notes.md");
    writeFileSync(keep, "KEEP ME\n");

    for (const [label, id] of REJECTED_IDS) {
      assert.throws(
        () => writeSlateArtifact({ cwd: project, kind: "observations", id: id as string, content: "PWNED\n" }),
        SlateWriteRefused,
        `${label} must be refused`,
      );
      const capture = captureObservation(project, id as string, "PWNED\n");
      assert.equal(capture.stored, false, `${label} must not store`);
      if (!capture.stored) assert.equal(capture.reason, "write-failed");
    }

    assert.equal(readFileSync(keep, "utf8"), "KEEP ME\n");
    assert.equal(existsSync(join(project, "..", "outside", "notes")), false);
    // A valid id still works, so the guard is a filter and not a blanket refusal.
    const good = captureObservation(project, "t1.e1", "real output\n");
    assert.equal(good.stored, true);
  });
});

test("a symlinked target file is refused and the victim file is untouched", () => {
  withLab(({ project, outside }) => {
    const target = victim(outside);
    mkdirSync(observationsDir(project), { recursive: true });
    const link = join(observationsDir(project), "t1.e1.md");
    symlinkSync(target, link);

    // The message is asserted, not just the refusal: several defences would each
    // refuse this layout, and only the message says the SYMLINK check is the one
    // that fired at the final path component.
    assert.throws(
      () => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "PWNED\n" }),
      /that path is a symbolic link/,
    );
    const capture = captureObservation(project, "t1.e1", "PWNED BY WORKER\n");

    assert.equal(capture.stored, false);
    if (!capture.stored) assert.equal(capture.reason, "write-failed");
    assert.equal(readFileSync(target, "utf8"), "ORIGINAL VICTIM CONTENT\n");
    assert.equal(statSync(target).mode & 0o777, 0o700);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  });
});

test("a symlinked artifact directory is refused and writes nothing outside", () => {
  withLab(({ project, outside }) => {
    const decoy = join(outside, "decoy");
    mkdirSync(decoy, { recursive: true });
    mkdirSync(join(project, ".pi", "slate"), { recursive: true });
    symlinkSync(decoy, observationsDir(project));

    assert.throws(
      () => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "PWNED\n" }),
      /that path is a symbolic link/,
    );
    const capture = captureObservation(project, "t1.e1", "PWNED\n");

    assert.equal(capture.stored, false);
    assert.deepEqual(readdirSync(decoy), []);
  });
});

test("a symlinked config directory is refused and writes nothing outside", () => {
  withLab(({ project, outside }) => {
    const decoy = join(outside, "decoy-pi");
    mkdirSync(decoy, { recursive: true });
    symlinkSync(decoy, join(project, ".pi"));

    assert.throws(
      () => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "PWNED\n" }),
      /that path is a symbolic link/,
    );
    const capture = captureObservation(project, "t1.e1", "PWNED\n");

    assert.equal(capture.stored, false);
    assert.deepEqual(readdirSync(decoy), []);
  });
});

test("a dangling symlink is refused and does not create the outside path", () => {
  withLab(({ project, outside }) => {
    const missing = join(outside, "absent", "created-by-slate.md");
    mkdirSync(observationsDir(project), { recursive: true });
    symlinkSync(missing, join(observationsDir(project), "t1.e1.md"));

    assert.throws(
      () => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "PWNED\n" }),
      /that path is a symbolic link/,
    );
    const capture = captureObservation(project, "t1.e1", "PWNED\n");

    assert.equal(capture.stored, false);
    assert.equal(existsSync(missing), false);
    assert.equal(existsSync(join(outside, "absent")), false);
  });
});

test("directory creation accepts a concurrent EEXIST only after re-reading a directory", (t) => {
  withLab(({ project }) => {
    const original = fs.mkdirSync;
    let injected = false;
    t.mock.method(fs, "mkdirSync", ((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (!injected && String(path) === join(project, ".pi")) {
        injected = true;
        original(path, options);
        const error = new Error("concurrent creator") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      return original(path, options);
    }) as typeof fs.mkdirSync);
    syncBuiltinESMExports();
    try {
      const result = writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "complete" });
      assert.equal(readFileSync(result.absolutePath, "utf8"), "complete");
      assert.equal(injected, true);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("one cwd resolution anchors a write when the cwd symlink changes", (t) => {
  withLab(({ root, project, outside }) => {
    const linked = join(root, "cwd-link");
    symlinkSync(project, linked);
    const original = fs.realpathSync;
    let cwdCalls = 0;
    t.mock.method(fs, "realpathSync", ((path: fs.PathLike, options?: unknown) => {
      const resolved = original(path, options as never);
      if (String(path) === linked) {
        cwdCalls++;
        if (cwdCalls === 1) {
          rmSync(linked);
          symlinkSync(outside, linked);
        }
      }
      return resolved;
    }) as typeof fs.realpathSync);
    syncBuiltinESMExports();
    try {
      const written = writeSlateArtifact({ cwd: linked, kind: "observations", id: "t1.e1", content: "anchored" });
      assert.equal(cwdCalls, 1);
      assert.equal(readFileSync(written.absolutePath, "utf8"), "anchored");
      assert.equal(written.absolutePath, join(project, ".pi", "slate", "observations", "t1.e1.md"));
      assert.equal(existsSync(join(outside, ".pi", "slate", "observations", "t1.e1.md")), false);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("short writes are retried until the full buffer is stored", (t) => {
  withLab(({ project }) => {
    const original = fs.writeSync;
    let calls = 0;
    t.mock.method(fs, "writeSync", ((fd: number, buffer: Uint8Array, offset?: number, length?: number) => {
      calls++;
      return original(fd, buffer, offset, Math.min(length ?? buffer.byteLength, 2));
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();
    try {
      const result = writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "complete" });
      assert.equal(readFileSync(result.absolutePath, "utf8"), "complete");
      assert.ok(calls > 1);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("a short write followed by an error removes the matching partial file", (t) => {
  withLab(({ project }) => {
    const original = fs.writeSync;
    let calls = 0;
    t.mock.method(fs, "writeSync", ((fd: number, buffer: Uint8Array, offset?: number, length?: number) => {
      calls++;
      if (calls === 1) return original(fd, buffer, offset, Math.min(length ?? buffer.byteLength, 2));
      throw new Error("injected disk error");
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();
    try {
      assert.throws(() => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "complete" }), /injected disk error/);
      assert.equal(existsSync(join(observationsDir(project), "t1.e1.md")), false);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("a zero-progress write removes the matching empty file", (t) => {
  withLab(({ project }) => {
    t.mock.method(fs, "writeSync", (() => 0) as typeof fs.writeSync);
    syncBuiltinESMExports();
    try {
      assert.throws(() => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "complete" }), /made no progress/);
      assert.equal(existsSync(join(observationsDir(project), "t1.e1.md")), false);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("a descriptor and path mismatch is refused before content is written", (t) => {
  withLab(({ project, outside }) => {
    const decoy = join(outside, "decoy");
    writeFileSync(decoy, "decoy");
    const originalLstat = fs.lstatSync;
    const originalOpen = fs.openSync;
    let injected = false;
    let opens = 0;
    t.mock.method(fs, "lstatSync", ((path: fs.PathLike, options?: unknown) => {
      const actual = originalLstat(path, options as never);
      if (!injected && String(path).endsWith("t1.e1.md") && actual?.isFile()) {
        injected = true;
        return originalLstat(decoy);
      }
      return actual;
    }) as typeof fs.lstatSync);
    t.mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => {
      opens++;
      if (opens === 2) throw new Error("second open proves the pre-write mismatch retried");
      return originalOpen(...args);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "must-not-write" }),
        /second open proves the pre-write mismatch retried/,
      );
      const target = join(observationsDir(project), "t1.e1.md");
      assert.equal(existsSync(target) ? readFileSync(target, "utf8") : "", "");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("a descriptor and path mismatch after writing is refused independently", (t) => {
  withLab(({ project, outside }) => {
    const decoy = join(outside, "decoy");
    writeFileSync(decoy, "decoy");
    const original = fs.lstatSync;
    let targetReads = 0;
    t.mock.method(fs, "lstatSync", ((path: fs.PathLike, options?: unknown) => {
      const actual = original(path, options as never);
      if (String(path).endsWith("t1.e1.md") && actual?.isFile() && ++targetReads >= 2) return original(decoy);
      return actual;
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "must-not-survive" }),
        /path kept changing before the write/,
      );
      assert.ok(targetReads >= 2);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("failed-write cleanup preserves a competing replacement", (t) => {
  withLab(({ project }) => {
    const target = join(observationsDir(project), "t1.e1.md");
    t.mock.method(fs, "writeSync", ((fd: number) => {
      rmSync(target);
      writeFileSync(target, "competing replacement");
      throw new Error(`injected failure on ${fd}`);
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();
    try {
      assert.throws(() => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "ours" }), /injected failure/);
      assert.equal(readFileSync(target, "utf8"), "competing replacement");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("replacement tolerates ENOENT after a concurrent unlink", (t) => {
  withLab(({ project }) => {
    mkdirSync(observationsDir(project), { recursive: true });
    const target = join(observationsDir(project), "t1.e1.md");
    writeFileSync(target, "old");
    const original = fs.unlinkSync;
    let injected = false;
    t.mock.method(fs, "unlinkSync", ((path: fs.PathLike) => {
      if (!injected && String(path) === target) {
        injected = true;
        original(path);
        const error = new Error("concurrent unlink") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return original(path);
    }) as typeof fs.unlinkSync);
    syncBuiltinESMExports();
    try {
      const written = writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "new" });
      assert.equal(injected, true);
      assert.equal(readFileSync(written.absolutePath, "utf8"), "new");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test("two writers for the same id complete with last-writer-wins content", { timeout: 1000 }, async () => {
  const { root, project } = lab();
  const workers: Worker[] = [];
  const outcomes: Array<Promise<unknown>> = [];
  let view: Int32Array | undefined;
  try {
    const moduleUrl = pathToFileURL(join(process.cwd(), "extension", "slate-files.ts")).href;
    const script = join(root, "writer.mjs");
    writeFileSync(script, `
      import { parentPort, workerData } from "node:worker_threads";
      const { writeSlateArtifact } = await import(workerData.moduleUrl);
      const gate = new Int32Array(workerData.gate);
      parentPort.postMessage("ready");
      Atomics.wait(gate, 0, 0);
      try {
        writeSlateArtifact({ cwd: workerData.cwd, kind: "observations", id: "t1.e1", content: workerData.content });
        parentPort.postMessage("ok");
      } catch (error) {
        parentPort.postMessage(error instanceof Error ? error.message : String(error));
      }
    `);
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    view = new Int32Array(gate);
    const run = (content: string) => {
      let readySettled = false;
      let resultSettled = false;
      let readyResolve: () => void;
      let readyReject: (error: Error) => void;
      let resultResolve: (message: string) => void;
      let resultReject: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const result = new Promise<string>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
      const worker = new Worker(script, { workerData: { moduleUrl, gate, cwd: project, content } });
      workers.push(worker);
      worker.on("message", (message: string) => {
        if (message === "ready") {
          readySettled = true;
          readyResolve();
        } else {
          resultSettled = true;
          resultResolve(message);
        }
      });
      worker.once("error", (error) => {
        if (!readySettled) {
          readySettled = true;
          readyReject(error);
        }
        if (!resultSettled) {
          resultSettled = true;
          resultReject(error);
        }
      });
      worker.once("exit", (code) => {
        const error = new Error(`writer exited before completing with code ${code}`);
        if (!readySettled) {
          readySettled = true;
          readyReject(error);
        }
        if (!resultSettled) {
          resultSettled = true;
          resultReject(error);
        }
      });
      outcomes.push(Promise.allSettled([ready, result]));
      return { ready, result };
    };
    const writers = [run("writer-a"), run("writer-b")];
    await Promise.all(writers.map((writer) => writer.ready));
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0, 2);
    assert.deepEqual(await Promise.all(writers.map((writer) => writer.result)), ["ok", "ok"]);
    assert.match(readFileSync(join(observationsDir(project), "t1.e1.md"), "utf8"), /^writer-[ab]$/);
  } finally {
    if (view) {
      Atomics.store(view, 0, 1);
      Atomics.notify(view, 0);
    }
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    await Promise.all(outcomes);
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback removes only the file owned by the same write attempt", () => {
  withLab(({ project }) => {
    const first = writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "first" });
    const second = writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "second" });

    assert.equal(removeSlateArtifact({
      cwd: project,
      kind: "observations",
      id: "t1.e1",
      reference: first.reference,
      identity: first.identity,
    }), false);
    assert.equal(readFileSync(second.absolutePath, "utf8"), "second");
    assert.equal(removeSlateArtifact({
      cwd: project,
      kind: "observations",
      id: "t1.e1",
      reference: second.reference,
      identity: second.identity,
    }), true);
    assert.equal(existsSync(second.absolutePath), false);
  });
});

test("rollback refuses a changed artifact parent and leaves the outside file untouched", () => {
  withLab(({ project, outside }) => {
    const written = writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "inside" });
    const artifactDir = observationsDir(project);
    rmSync(artifactDir, { recursive: true });
    const decoy = join(outside, "observations");
    mkdirSync(decoy);
    const outsideFile = join(decoy, "t1.e1.md");
    writeFileSync(outsideFile, "outside");
    symlinkSync(decoy, artifactDir);

    assert.throws(
      () => removeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", reference: written.reference, identity: written.identity }),
      /artifact directory.*symbolic link/,
    );
    assert.equal(readFileSync(outsideFile, "utf8"), "outside");
  });
});

test("an existing regular file is still overwritten in place of its name", () => {
  withLab(({ project }) => {
    mkdirSync(observationsDir(project), { recursive: true });
    const file = join(observationsDir(project), "t1.e1.md");
    writeFileSync(file, "stale\n");

    const capture = captureObservation(project, "t1.e1", "fresh content\n");

    assert.equal(capture.stored, true);
    assert.equal(readFileSync(file, "utf8"), "fresh content\n");
  });
});

test("an existing directory at the target name is refused", () => {
  withLab(({ project }) => {
    mkdirSync(join(observationsDir(project), "t1.e1.md"), { recursive: true });
    assert.throws(
      () => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "x\n" }),
      /that path is not a regular file/,
    );
    assert.equal(captureObservation(project, "t1.e1", "x\n").stored, false);
  });
});

test("a path component that exists as a plain file is refused", () => {
  withLab(({ project }) => {
    writeFileSync(join(project, ".pi"), "not a directory\n");
    assert.throws(
      () => writeSlateArtifact({ cwd: project, kind: "observations", id: "t1.e1", content: "x\n" }),
      /that path is not a directory/,
    );
  });
});

test("a symlink above the project root stays legitimate", () => {
  withLab(({ root, project }) => {
    const linked = join(root, "linked-project");
    symlinkSync(project, linked);

    const capture = captureObservation(linked, "t1.e1", "through a linked root\n");

    assert.equal(capture.stored, true);
    if (!capture.stored) return;
    assert.equal(capture.path, ".pi/slate/observations/t1.e1.md");
    assert.equal(readFileSync(join(linked, capture.path), "utf8"), "through a linked root\n");
  });
});

test("both artifact kinds share one writer and one refusal rule", () => {
  withLab(({ project, outside }) => {
    const target = victim(outside);
    mkdirSync(slateArtifactDir(project, "episodes"), { recursive: true });
    symlinkSync(target, join(slateArtifactDir(project, "episodes"), "t1.e1.md"));

    assert.throws(
      () => writeSlateArtifact({ cwd: project, kind: "episodes", id: "t1.e1", content: "# Episode\n" }),
      SlateWriteRefused,
    );
    assert.equal(readFileSync(target, "utf8"), "ORIGINAL VICTIM CONTENT\n");

    const written = writeSlateArtifact({ cwd: project, kind: "episodes", id: "t2.e1", content: "# Episode\n" });
    assert.equal(written.reference, ".pi/slate/episodes/t2.e1.md");
    assert.equal(written.absolutePath, join(slateArtifactDir(project, "episodes"), "t2.e1.md"));
    assert.equal(readFileSync(written.absolutePath, "utf8"), "# Episode\n");
  });
});
