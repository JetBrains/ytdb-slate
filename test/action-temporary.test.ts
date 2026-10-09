import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allocateActionTemporary, finishActionTemporary } from "../extension/action-temporary.ts";
import { createChangeFolder } from "../extension/artifact-names.ts";

function lab(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "slate-action-temporary-")), change = createChangeFolder();
  const folder = join(root, "slate-changes", change), tmp = join(folder, "tmp");
  fs.mkdirSync(folder, { recursive: true });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, change, folder, tmp };
}

test("allocation checks every component without repairing change folders", (t) => {
  for (const component of ["slate-changes", "change", "tmp"]) for (const kind of ["missing", "file", "link"]) {
    const f = lab(t), target = component === "slate-changes" ? join(f.root, component) : component === "change" ? f.folder : f.tmp;
    fs.rmSync(target, { recursive: true, force: true });
    if (kind === "file") fs.writeFileSync(target, "sentinel");
    if (kind === "link") fs.symlinkSync(f.root, target);
    if (component === "tmp" && kind === "missing") assert.ok(allocateActionTemporary(f.root, f.change));
    else assert.throws(() => allocateActionTemporary(f.root, f.change), /ENOENT|not a directory|symbolic link/);
    if (kind === "file") assert.equal(fs.readFileSync(target, "utf8"), "sentinel");
  }
  const f = lab(t);
  for (const change of ["../bad", "runtime-20261001T000000Z-" + "a".repeat(32)]) {
    assert.throws(() => allocateActionTemporary(f.root, change), /Invalid/);
  }
  assert.equal(fs.existsSync(f.tmp), false);
});

test("private allocation accepts checked concurrent creation and preserves existing modes", { timeout: 1000 }, async (t) => {
  const f = lab(t), mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", ((path: fs.PathLike, options: fs.MakeDirectoryOptions) => {
    mkdir(path, options);
    throw Object.assign(new Error("concurrent creator"), { code: "EEXIST" });
  }) as typeof fs.mkdirSync);
  syncBuiltinESMExports();
  const a = allocateActionTemporary(f.root, f.change), b = allocateActionTemporary(f.root, f.change);
  assert.notEqual(a.path, b.path);
  assert.equal(fs.statSync(f.tmp).mode & 0o777, 0o700);
  assert.equal(fs.statSync(a.path).mode & 0o777, 0o700);
  fs.chmodSync(f.tmp, 0o755);
  allocateActionTemporary(f.root, f.change);
  assert.equal(fs.statSync(f.tmp).mode & 0o777, 0o755);
  const finish = finishActionTemporary(a);
  assert.equal(finishActionTemporary(a), finish);
  assert.equal(await finish, undefined);
  assert.equal(fs.existsSync(a.path), false);
  assert.equal(fs.existsSync(b.path), true);
});

test("allocation reports creation errors and names an unexposed verification failure", (t) => {
  for (const operation of ["mkdirSync", "mkdtempSync", "verification"] as const) {
    const f = lab(t);
    let created: string | undefined;
    if (operation === "verification") {
      const mkdtemp = fs.mkdtempSync;
      t.mock.method(fs, "mkdtempSync", ((prefix: string) => { created = mkdtemp(prefix); fs.chmodSync(created, 0o777); return created; }) as typeof fs.mkdtempSync);
    } else t.mock.method(fs, operation, () => { throw new Error("injected creation failure"); });
    syncBuiltinESMExports();
    try {
      assert.throws(() => allocateActionTemporary(f.root, f.change), (error: Error) => {
        assert.match(error.message, /injected creation failure|not private/);
        if (operation === "mkdtempSync") {
          assert.ok(error.message.includes(`Slate kept action temporary folder ${f.tmp}. Reason:`));
          assert.ok(fs.statSync(f.tmp).isDirectory());
        }
        if (created) { assert.ok(error.message.includes(created)); assert.ok(fs.existsSync(created)); }
        return true;
      });
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
});

test("completion keeps bytes and refuses every observed replacement", { timeout: 1000 }, async (t) => {
  for (const replacement of ["contents", "parent", "change", "tmp", "action", "link"]) {
    const f = lab(t), a = allocateActionTemporary(f.root, f.change), b = allocateActionTemporary(f.root, f.change);
    const record = join(f.folder, "record.md"), sibling = join(b.path, "start-copy");
    fs.writeFileSync(record, "record sentinel"); fs.writeFileSync(sibling, "sibling sentinel");
    let moved: string | undefined;
    if (replacement === "contents") fs.writeFileSync(join(a.path, "payload"), "retained bytes");
    else {
      const target = replacement === "parent" ? join(f.root, "slate-changes") : replacement === "change" ? f.folder : replacement === "tmp" ? f.tmp : a.path;
      fs.renameSync(target, target + ".held");
      moved = target;
      if (replacement === "link") fs.symlinkSync(target + ".held", target);
      else fs.mkdirSync(target);
    }
    const warning = await finishActionTemporary(a);
    assert.ok(warning?.includes(a.path));
    const retained = (path: string) => moved && path.startsWith(moved) ? moved + ".held" + path.slice(moved.length) : path;
    assert.ok(fs.existsSync(retained(a.path)));
    assert.equal(fs.readFileSync(retained(record), "utf8"), "record sentinel");
    assert.equal(fs.readFileSync(retained(sibling), "utf8"), "sibling sentinel");
    if (replacement === "contents") {
      assert.equal(fs.readFileSync(join(a.path, "payload"), "utf8"), "retained bytes");
      assert.equal(fs.readFileSync(record, "utf8"), "record sentinel");
      assert.equal(fs.readFileSync(sibling, "utf8"), "sibling sentinel");
    }
  }
});

test("completion performs one exact non-recursive syscall and reports its failures", { timeout: 1000 }, async (t) => {
  for (const code of ["ok", "ENOTEMPTY", "EACCES", "EIO"]) {
    const f = lab(t), a = allocateActionTemporary(f.root, f.change);
    const removals: unknown[][] = [];
    let listings = 0;
    t.mock.method(fs.promises, "rmdir", async (...args: unknown[]) => {
      removals.push(args);
      if (code !== "ok") throw Object.assign(new Error(code), { code });
    });
    const forbidListing = () => { listings++; throw new Error("content traversal"); };
    t.mock.method(fs.promises, "readdir", forbidListing);
    t.mock.method(fs, "readdirSync", forbidListing);
    t.mock.method(fs, "opendirSync", forbidListing);
    syncBuiltinESMExports();
    try {
      const warning = await finishActionTemporary(a);
      assert.equal(listings, 0);
      assert.equal(removals.length, 1);
      assert.deepEqual(removals[0], [a.path]);
      if (code === "ok") assert.equal(warning, undefined);
      else { assert.ok(warning?.includes(a.path)); assert.ok(warning?.includes(code)); }
      assert.ok(fs.existsSync(a.path));
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
  assert.match((await finishActionTemporary({ change: "invalid", path: "unowned" }))!, /not owned/);
});
