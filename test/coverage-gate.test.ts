import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const GATE = fileURLToPath(new URL("../verification/coverage-gate.mjs", import.meta.url));
const RUNNER = fileURLToPath(new URL("../verification/run-tests.sh", import.meta.url));

interface RunResult { status: number | null; stdout: string; stderr: string }

function command(cwd: string, executable: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, ...args: string[]): string {
  const result = command(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t: { after(fn: () => void): void }, initial = "export const before = 1;\n") {
  const repo = mkdtempSync(join(tmpdir(), "slate-gate-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "gate@example.invalid");
  git(repo, "config", "user.name", "Gate Test");
  write(repo, "extension/sample.ts", initial);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}

function write(repo: string, relative: string, content: string | NodeJS.ArrayBufferView) {
  const path = join(repo, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commit(repo: string, message = "head") {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
}

function runGate(repo: string, base: string, lcov: string, extra: string[] = [], env?: NodeJS.ProcessEnv): RunResult {
  const lcovPath = join(repo, "gate.lcov");
  writeFileSync(lcovPath, lcov);
  return command(repo, process.execPath, [GATE, "--repo", repo, "--base", base, "--head", "HEAD", "--lcov", lcovPath, ...extra], env);
}

function emptyLcov() { return "TN:\n"; }
function sourceLcov(lines: string[], branches: string[] = []) {
  return ["TN:", "SF:extension/sample.ts", ...lines.map((line) => `DA:${line}`), ...branches.map((branch) => `BRDA:${branch}`), "end_of_record", ""].join("\n");
}

test("gate parser keeps no-newline markers and ++ source lines out of file accounting (WH20, WH21)", async (t) => {
  await t.test("no trailing newline", (t) => {
    const { repo, base } = fixture(t, "export const before = 1;\nexport const tail = 2;");
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const tail = 2;\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\n");
    commit(repo);
    const additions = Number(git(repo, "diff", "--numstat", `${base}..HEAD`).split("\t")[0]);
    const result = runGate(repo, base, sourceLcov(["2,1", "3,1", "4,1", "5,1", "6,1", "7,1", "8,0"]));
    assert.match(result.stdout, new RegExp(`line denominator ${additions}(?:;|$)`));
  });

  await t.test("source beginning with ++ and a space", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\n++ tmp/notes.txt\nfollowing line\n");
    commit(repo);
    const additions = Number(git(repo, "diff", "--numstat", `${base}..HEAD`).split("\t")[0]);
    const result = runGate(repo, base, emptyLcov());
    assert.match(result.stdout, /extension\/sample\.ts:/);
    assert.match(result.stdout, new RegExp(`line denominator ${additions}(?:;|$)`));
  });
});

test("gate forces an internal unified diff and rejects nonempty unparseable output (WH22)", async (t) => {
  await t.test("external diff cannot hide a file", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const changed = 2;\n");
    commit(repo);
    const external = join(repo, "external-diff.sh");
    writeFileSync(external, "#!/bin/sh\nprintf 'external output only\\n'\n");
    chmodSync(external, 0o755);
    git(repo, "config", "diff.external", external);
    const result = runGate(repo, base, emptyLcov());
    assert.match(result.stdout, /extension\/sample\.ts:/);
    assert.equal(result.status, 1);
  });

  await t.test("configured diff prefixes cannot move a file out of scope", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const changed = 2;\n");
    commit(repo);
    git(repo, "config", "diff.dstPrefix", "poison/");
    const result = runGate(repo, base, emptyLcov());
    assert.match(result.stdout, /extension\/sample\.ts:/);
    assert.equal(result.status, 1);
  });

  await t.test("textconv cannot erase a changed file", (t) => {
    const first = fixture(t);
    write(first.repo, ".gitattributes", "extension/*.ts diff=poison\n");
    commit(first.repo, "attributes");
    const base = git(first.repo, "rev-parse", "HEAD");
    const textconv = join(first.repo, "textconv.sh");
    writeFileSync(textconv, "#!/bin/sh\nprintf 'same transformed text\\n'\n");
    chmodSync(textconv, 0o755);
    git(first.repo, "config", "diff.poison.textconv", textconv);
    write(first.repo, "extension/sample.ts", "export const changed = 2;\n");
    commit(first.repo);
    const result = runGate(first.repo, base, emptyLcov());
    assert.match(result.stdout, /extension\/sample\.ts:/);
    assert.equal(result.status, 1);
  });

  await t.test("nonempty output with no parsed file is an error", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const changed = 2;\n");
    commit(repo);
    const bin = join(repo, "bin");
    mkdirSync(bin);
    const realGit = command(repo, "sh", ["-c", "command -v git"]).stdout.trim();
    const fakeGit = join(bin, "git");
    writeFileSync(fakeGit, "#!/bin/sh\ncase \" $* \" in *' --unified=0 '*) printf 'malformed diff bytes\\n'; exit 0;; esac\nexec \"$REAL_GIT\" \"$@\"\n");
    chmodSync(fakeGit, 0o755);
    const result = runGate(repo, base, emptyLcov(), [], { PATH: `${bin}:${process.env.PATH ?? ""}`, REAL_GIT: realGit });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /nonempty git diff produced zero parsed files/i);
  });
});

test("thresholds reject empty and whitespace-only values (WH24)", (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const changed = 2;\n");
  commit(repo);
  for (const value of ["", "   "]) {
    const result = runGate(repo, base, emptyLcov(), ["--threshold-lines", value]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /threshold must be a number from 0 to 100/i);
  }
});

test("an uncovered addition in an LCOV-recorded file gets a synthetic branch (WH25)", (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const before = 1;\nexport function fresh(value: number) {\n  if (value > 0) return value;\n  return 0;\n}\n");
  commit(repo);
  const result = runGate(repo, base, sourceLcov(["2,1", "3,1", "4,0", "5,1"]), ["--threshold-lines", "0"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /branches 0\/1=0\.00%.*synthetic branch/i);
  assert.match(result.stdout, /branch denominator 1/);
});

test("coverage directives require an explicit same-line reason (WH26)", (t) => {
  // Use explicit fixtures rather than a shared file so one accepted reason cannot mask another.
  for (const text of [
    "/* node:coverage disable */ // .", // reason: fixture tests a one-character pseudo-reason
    "// reason: unrelated neighbouring prose\n/* node:coverage disable */", // reason: fixture tests neighboring prose
  ]) {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", `export const before = 1;\n${text}\n`);
    commit(repo);
    const result = runGate(repo, base, emptyLcov(), ["--threshold-lines", "0"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /coverage directives without a diff-recorded reason/);
  }
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const before = 1;\n/* node:coverage disable */ // reason: generated fallback cannot execute\n");
  commit(repo);
  const accepted = runGate(repo, base, emptyLcov(), ["--threshold-lines", "0"]);
  assert.doesNotMatch(accepted.stdout, /coverage directives without a diff-recorded reason/);
});

test("directive scan catches every raw-line shape Node 24.18 matches (RG21)", (t) => {
  const rejected = [
    "/* node:coverage disable */", // reason: fixture tests a leading status directive
    "run(); /* node:coverage enable */", // reason: fixture tests a trailing status directive
    "/* node:coverage ignore next */", // reason: fixture tests the default ignore count
    "run(); /* node:coverage ignore next 3 */", // reason: fixture tests an explicit ignore count
    "const text = '/* node:coverage disable */';", // reason: fixture tests raw matching in a string
    "const text = `/* node:coverage enable */`;", // reason: fixture tests raw matching in a template
  ];
  for (const text of rejected) {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", `export const before = 1;\n${text}\n`);
    commit(repo);
    const result = runGate(repo, base, emptyLcov(), ["--threshold-lines", "0"]);
    assert.equal(result.status, 1, `${text}\n${result.stdout}`);
    assert.match(result.stdout, /IGNORE DIRECTIVE:/);
    assert.match(result.stdout, /coverage directives without a diff-recorded reason/);
  }

  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const before = 1;\nconst marker = '/* node:coverage disable */'; // reason: fixture validates raw matching\n");
  commit(repo);
  const reasoned = runGate(repo, base, emptyLcov(), ["--threshold-lines", "0"]);
  assert.match(reasoned.stdout, /IGNORE DIRECTIVE:/);
  assert.doesNotMatch(reasoned.stdout, /coverage directives without a diff-recorded reason/);
});

test("directive scan ignores every shape Node 24.18 does not match (RG23)", (t) => {
  const ignored = [
    "// node:coverage disable",
    "run(); // node:coverage enable",
    "// node:coverage ignore next",
    "run(); // node:coverage ignore next",
    "* node:coverage disable */",
    "/* node:coverage DISABLE */",
    "/*  node:coverage disable */",
    "/* node:coverage  disable */",
    "run(); /* note node:coverage disable */",
  ];
  for (const text of ignored) {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", `export const before = 1;\n${text}\n`);
    commit(repo);
    const result = runGate(repo, base, emptyLcov(), ["--threshold-lines", "0"]);
    assert.doesNotMatch(result.stdout, /IGNORE DIRECTIVE:/, text);
  }
});

test("run-tests preserves a gate WARN as its final verdict (WH23)", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "slate-runner-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "verification"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  cpSync(RUNNER, join(repo, "verification/run-tests.sh"));
  writeFileSync(join(repo, "verification/link-peers.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(repo, "verification/coverage-gate.mjs"), "console.log('VERDICT: WARN — fixture requires manual review');\n");
  writeFileSync(join(repo, "test/smoke.test.ts"), "import test from 'node:test'; test('smoke', () => {});\n");
  const bin = join(repo, "bin");
  mkdirSync(bin);
  const fakeNode = join(bin, "node");
  writeFileSync(fakeNode, `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --test-reporter-destination=*) destination="\${arg#*=}" ;;
  esac
done
case " $* " in
  *' --test '*) printf 'TN:\\n' > "$destination"; printf 'fixture node:test PASS\\n'; exit 0 ;;
esac
printf 'VERDICT: WARN — fixture requires manual review\\n'
`);
  chmodSync(fakeNode, 0o755);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "gate@example.invalid");
  git(repo, "config", "user.name", "Gate Test");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture");
  const result = command(repo, "bash", ["verification/run-tests.sh"], { PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RUN VERDICT: WARN —/);
  assert.doesNotMatch(result.stdout, /RUN VERDICT: PASS/);
});

test("missing LCOV is an infrastructure error and the runner labels it (WH41)", (t) => {
  const { repo, base } = fixture(t);
  write(repo, "extension/sample.ts", "export const changed = 2;\n");
  commit(repo);
  const missing = command(repo, process.execPath, [
    GATE, "--repo", repo, "--base", base, "--head", "HEAD", "--lcov", join(repo, "absent.lcov"),
  ]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /coverage-gate: infrastructure error.*LCOV/i);

  const runnerRepo = mkdtempSync(join(tmpdir(), "slate-runner-error-test-"));
  t.after(() => rmSync(runnerRepo, { recursive: true, force: true }));
  mkdirSync(join(runnerRepo, "verification"), { recursive: true });
  mkdirSync(join(runnerRepo, "test"), { recursive: true });
  cpSync(RUNNER, join(runnerRepo, "verification/run-tests.sh"));
  writeFileSync(join(runnerRepo, "verification/link-peers.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(runnerRepo, "verification/coverage-gate.mjs"), "process.exitCode = 2;\n");
  writeFileSync(join(runnerRepo, "test/smoke.test.ts"), "// fixture\n");
  const bin = join(runnerRepo, "bin");
  mkdirSync(bin);
  const fakeNode = join(bin, "node");
  writeFileSync(fakeNode, `#!/bin/sh
for arg in "$@"; do case "$arg" in --test-reporter-destination=*) destination="\${arg#*=}" ;; esac; done
case " $* " in *' --test '*) printf 'TN:\\n' > "$destination"; exit 0 ;; esac
exit 2
`);
  chmodSync(fakeNode, 0o755);
  git(runnerRepo, "init", "-q", "-b", "main");
  git(runnerRepo, "config", "user.email", "gate@example.invalid");
  git(runnerRepo, "config", "user.name", "Gate Test");
  git(runnerRepo, "add", ".");
  git(runnerRepo, "commit", "-qm", "fixture");
  const runner = command(runnerRepo, "bash", ["verification/run-tests.sh"], { PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(runner.status, 2);
  assert.match(runner.stdout, /RUN VERDICT: ERROR — coverage infrastructure failed/);
  assert.doesNotMatch(runner.stdout, /rejected the patch/);
  const retained = /retained failure artifacts at (.+)/.exec(runner.stderr)?.[1]?.trim();
  assert.ok(retained, runner.stderr);
  assert.equal(existsSync(join(retained, "lcov.info")), true);
  rmSync(retained, { recursive: true, force: true });
});

test("ordinary non-line diffs remain parseable", async (t) => {
  for (const kind of ["rename", "deletion", "binary", "mode"] as const) {
    await t.test(kind, (t) => {
      const { repo, base } = fixture(t);
      if (kind === "rename") git(repo, "mv", "extension/sample.ts", "extension/renamed.ts");
      if (kind === "deletion") rmSync(join(repo, "extension/sample.ts"));
      if (kind === "binary") write(repo, "extension/blob.ts", Buffer.from([0, 1, 2, 3]));
      if (kind === "mode") chmodSync(join(repo, "extension/sample.ts"), 0o755);
      commit(repo);
      const result = runGate(repo, base, emptyLcov());
      assert.notEqual(result.status, 2, `${kind}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /zero parsed files/i);
    });
  }
});

test("CRLF additions and duplicate, malformed, truncated, and foreign LCOV records fail closed", async (t) => {
  await t.test("CRLF", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\r\nexport const crlf = 2;\r\n");
    commit(repo);
    const additions = Number(git(repo, "diff", "--numstat", `${base}..HEAD`).split("\t")[0]);
    const result = runGate(repo, base, emptyLcov());
    assert.match(result.stdout, new RegExp(`line denominator ${additions}(?:;|$)`));
  });

  await t.test("duplicate SF takes the highest line and branch hit counts in either order (RG22)", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const duplicate = 2;\n");
    commit(repo);
    const blocks = [
      "SF:extension/sample.ts\nDA:2,1\nBRDA:2,0,0,1\nBRDA:2,0,1,0\nend_of_record",
      "SF:extension/sample.ts\nDA:2,0\nBRDA:2,0,0,0\nBRDA:2,0,1,1\nend_of_record",
    ];
    const result = runGate(repo, base, `TN:\n${blocks.join("\n")}\n`, ["--threshold-lines", "100"]);
    assert.match(result.stdout, /lines 1\/1=100\.00% \| branches 2\/2=100\.00%/);
  });

  await t.test("BRDA identity includes both line and block (RG22)", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const second = 2;\nexport const third = 3;\n");
    commit(repo);
    const lcov = [
      "TN:", "SF:extension/sample.ts", "DA:2,1", "DA:3,1",
      "BRDA:2,0,0,1", "BRDA:3,0,0,0",
      "BRDA:2,1,1,1", "BRDA:2,2,1,0",
      "end_of_record", "",
    ].join("\n");
    const result = runGate(repo, base, lcov);
    assert.match(result.stdout, /branches 2\/4=50\.00%/);
  });

  await t.test("duplicate BRDA identities cannot dilute uncovered branches (WH40)", (t) => {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const duplicate = 2;\n");
    commit(repo);
    const identity = (index: number, hits: number) => `BRDA:2,0,${index},${hits}`;
    const truth = Array.from({ length: 40 }, (_, index) => identity(index, index < 20 ? 1 : 0));
    const duplicateCovered = Array.from({ length: 20 }, (_, index) => identity(index, 1));
    const records = [truth, ...Array.from({ length: 6 }, () => duplicateCovered)]
      .map((branches) => `SF:extension/sample.ts\nDA:2,1\n${branches.join("\n")}\nend_of_record`);
    const result = runGate(repo, base, `TN:\n${records.join("\n")}\n`);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /branches 20\/40=50\.00%/);
  });

  for (const [name, lcov] of [
    ["malformed", "TN:\nSF:extension/sample.ts\nDA:not-a-line,nope\nBRDA:oops,0,0,nope\nend_of_record\n"],
    ["truncated", "TN:\nSF:extension/sample.ts\n"],
    ["foreign", "TN:\nSF:/tmp/foreign/extension/sample.ts\nDA:2,99\nend_of_record\n"],
  ] as const) {
    await t.test(name, (t) => {
      const { repo, base } = fixture(t);
      write(repo, "extension/sample.ts", "export const before = 1;\nexport const uncovered = 2;\n");
      commit(repo);
      const result = runGate(repo, base, lcov);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /lines 0\/1=0\.00%/);
    });
  }
});

test("branch minimum-denominator boundary is 19 WARN, 20 enforced, 21 enforced", (t) => {
  function branchCase(count: number, hits: number) {
    const { repo, base } = fixture(t);
    write(repo, "extension/sample.ts", "export const before = 1;\nexport const branchy = 2;\n");
    commit(repo, `branches-${count}`);
    const branches = Array.from({ length: count }, (_, index) => `2,0,${index},${index < hits ? 1 : 0}`);
    return runGate(repo, base, sourceLcov(["2,1"], branches));
  }
  const nineteen = branchCase(19, 0);
  assert.equal(nineteen.status, 0);
  assert.match(nineteen.stdout, /only 19 changed branches \(<20\)/);
  const twenty = branchCase(20, 0);
  assert.equal(twenty.status, 1);
  assert.match(twenty.stdout, /branch patch coverage 0\.00% is below/);
  const twentyOne = branchCase(21, 18);
  assert.equal(twentyOne.status, 0);
  assert.match(twentyOne.stdout, /branches 18\/21=85\.71%/);
});
