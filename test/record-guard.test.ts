// record-tool-test: all
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { recordGuardBlocks, recordGuardReason, RECORD_GUARD_UNRESOLVED_REASON, RECORD_GUARD_REASON, resolveRecordGuardPath } from "../extension/record-guard.ts";
const piResolver = await import(pathToFileURL(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js")).href);

test("record-path-protection uses pi path forms and nearest ancestor identity without prefix confusion", { timeout: 10000 }, async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "slate-record-guard-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "slate-changes", "change", "versions"), { recursive: true });
  await mkdir(join(cwd, "slate-changes-other"));
  await symlink(join(cwd, "slate-changes", "change"), join(cwd, "alias"));
  const forms = ["slate-changes/change/report.md", join(cwd, "slate-changes/change/report.md"), "@slate-changes/change/report.md", pathToFileURL(join(cwd, "slate-changes/change/report.md")).href,
    "./slate-changes/change/versions/missing/a.md", "alias/new.md", "~/slate-record-unused", "~", "@~/slate-record-unused", "space\u00a0name", "x/../slate-changes/change/report.md"];
  for (const input of forms) assert.equal(resolveRecordGuardPath(input, cwd), piResolver.resolveToCwd(input, cwd), input);
  for (const input of forms.slice(0, 6)) assert.equal(await recordGuardBlocks(input, cwd, cwd), true, input);
  assert.equal(await recordGuardBlocks("slate-changes-other/new.md", cwd, cwd), false);
  assert.equal(await recordGuardBlocks(join(homedir(), "outside-file"), cwd, cwd), false);
  assert.equal(await recordGuardBlocks("source.ts", cwd, cwd), false);
  assert.equal(await recordGuardBlocks(null, cwd, cwd), true);
});

test("record-path-protection with no change folder allows established outside writes and blocks future record writes", { timeout: 10000 }, async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "slate-record-no-folder-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.equal(await recordGuardBlocks("source.ts", cwd, cwd), false);
  assert.equal(await recordGuardBlocks("slate-changes/change/report.md", cwd, cwd), true);
  assert.equal(await recordGuardBlocks("unresolved/source.ts", cwd, cwd), true);
  assert.equal(await recordGuardReason("unresolved/source.ts", cwd, cwd), RECORD_GUARD_UNRESOLVED_REASON);
  assert.doesNotMatch(RECORD_GUARD_UNRESOLVED_REASON, /assignment|slate_record/);
  assert.equal(await recordGuardReason("slate-changes/change/report.md", cwd, cwd), RECORD_GUARD_REASON);
  await symlink(join(cwd, "slate-changes", "missing.md"), join(cwd, "dangling"));
  assert.equal(await recordGuardReason("dangling", cwd, cwd), RECORD_GUARD_UNRESOLVED_REASON);
});

test("record-path-protection blocks final dangling links and chained links into protected names", { timeout: 10000 }, async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "slate-record-dangling-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "slate-changes", "change"), { recursive: true });
  await symlink("slate-changes/change/missing.md", join(cwd, "alias"));
  await symlink("alias", join(cwd, "chain"));
  for (const name of ["alias", "chain"]) {
    assert.equal(await recordGuardBlocks(name, cwd, cwd), true);
    assert.equal(await recordGuardReason(name, cwd, cwd), RECORD_GUARD_UNRESOLVED_REASON);
  }
});
