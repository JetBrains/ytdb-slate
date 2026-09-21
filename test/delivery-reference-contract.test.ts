import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Run the production assertion through its public wrapper. No copied predicate
// can turn a scanner defect into a passing mutation test.
test("delivery references stay inside reviewed contexts across shipped docs", { timeout: 180_000 }, async (t) => {
  const repo = process.cwd();
  const fixture = mkdtempSync(join(tmpdir(), "slate-delivery-references-"));
  try {
    for (const path of ["extension", "verification", "docs", "test", "README.md", "package.json"]) {
      cpSync(join(repo, path), join(fixture, path), { recursive: true });
    }
    mkdirSync(join(fixture, ".pi"));
    cpSync(join(repo, ".pi/slate.json"), join(fixture, ".pi/slate.json"));
    symlinkSync(join(repo, "node_modules"), join(fixture, "node_modules"), "dir");
    const workflowFile = "docs/track-workflow.md";
    const workflow = readFileSync(join(fixture, workflowFile), "utf8");
    const readme = readFileSync(join(fixture, "README.md"), "utf8");
    const readmeReference = "- `docs/delivery-packages.md` — the compact track and change package format, read only before package preparation";
    const actor = "| orchestrator | track or change package | [delivery-packages.md](delivery-packages.md) | § Package preparation |";
    const begin = "<!-- delivery-package-loading:begin -->";
    const end = "<!-- delivery-package-loading:end -->";
    const loading = workflow.slice(workflow.indexOf(begin), workflow.indexOf(end) + end.length);
    assert.ok(readme.includes(readmeReference) && workflow.includes(actor) && loading.includes("Immediately before"));

    async function check(name: string, changes: Record<string, string>, accepted = false): Promise<void> {
      await t.test(name, { timeout: 25_000 }, () => {
        const originals = new Map<string, string | undefined>();
        try {
          for (const [file, source] of Object.entries(changes)) {
            const path = join(fixture, file);
            const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
            originals.set(path, original);
            assert.notEqual(source, original, `${name}: inert fixture`);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, source);
          }
          const result = spawnSync("bash", [join(fixture, "verification/run-resolver-checks.sh"), "--repo", fixture, "--strict"], {
            cwd: fixture, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, JITI_FS_CACHE: "true" },
          });
          const output = `${result.stdout}\n${result.stderr}`;
          assert.equal(result.error, undefined, output);
          assert.equal(result.signal, null, output);
          assert.equal(result.status, accepted ? 0 : 1, output);
          assert.match(output, new RegExp(`^CHECK +contract-delivery-packages +${accepted ? "PASS" : "FAIL"}\\b`, "m"));
          assert.match(output, /^CHECK +roster +PASS\b/m);
        } finally {
          for (const [path, original] of originals) {
            if (original === undefined) rmSync(path);
            else writeFileSync(path, original);
          }
        }
      });
    }

    await check("clean source", {}, true);
    const forms = {
      "raw path": "At session start, read docs/delivery-packages.md.",
      "reference link": "At session start, read [package rules][early-package].\n\n[early-package]: delivery-packages.md",
      "alternate label and fragment": "At session start, read [package rules](./delivery-packages.md#package-preparation).",
    };
    for (const file of ["README.md", "docs/track-workflow.md", "docs/model-routing.md", "docs/pr-publishing.md", "docs/user-notes.md", "docs/review-rules.md", "docs/new/nested/reader.md"]) {
      const path = join(fixture, file);
      const source = existsSync(path) ? readFileSync(path, "utf8") : "# New reader\n";
      for (const [form, instruction] of Object.entries(forms)) {
        await check(`${file}: added ${form}`, { [file]: `${source}\n\n${instruction}\n` });
      }
    }
    for (const reference of ["`docs/delivery-packages.md`", "[rules](</installed/docs/delivery-packages.md>)", "<https://example.test/delivery-packages.md>"]) {
      await check(`other literal spelling: ${reference}`, { [workflowFile]: `${workflow}\n\nAt session start, read ${reference}.\n` });
    }
    await check("second occurrence on an approved row", { [workflowFile]: workflow.replace(actor, `${actor} delivery-packages.md`) });
    await check("literal in comment", { [workflowFile]: `${workflow}\n<!-- read delivery-packages.md -->\n` });
    await check("literal in fenced code", { [workflowFile]: `${workflow}\n\n\`\`\`text\nread delivery-packages.md\n\`\`\`\n` });
    await check("earlier count-preserving actor replacement", { [workflowFile]: workflow.replace(actor, "At session start, read [delivery-packages.md](delivery-packages.md).") });
    await check("removed context", { "README.md": readme.replace(readmeReference, "") });
    await check("duplicated context", { "README.md": readme.replace(readmeReference, `${readmeReference}\n${readmeReference}`) });
    await check("count-preserving document move", {
      "README.md": readme.replace(readmeReference, ""),
      "docs/new/moved.md": `# ytdb-slate\n\n## Shipped docs\n\n${readmeReference}\n`,
    });
    await check("count-preserving heading move", { "README.md": readme.replace(readmeReference, "") + `\n## Early reads\n\n${readmeReference}\n` });
    await check("duplicated owning heading", { "README.md": `${readme}\n## Shipped docs\n\nUnrelated text.\n` });
    await check("changed parent heading", { "README.md": readme.replace("# ytdb-slate\n", "# Other title\n") });
    const notes = readFileSync(join(fixture, "docs/user-notes.md"), "utf8");
    const combinedPackage = notes.match(/A single-track change uses the combined package[\s\S]*?(?=\n\n)/)?.[0];
    assert.ok(combinedPackage);
    await check("count-preserving reference order change within one heading", {
      "docs/user-notes.md": notes.replace(combinedPackage, "") + `\n\n${combinedPackage}\n`,
    });
    await check("changed owned loading rule", { [workflowFile]: workflow.replace("Immediately before preparing any track package or final change package", "At session start") });
    await check("moved owned loading unit", { [workflowFile]: workflow.replace(loading, "") + `\n## Early reads\n\n${loading}\n` });
    for (const marker of [begin, end]) {
      await check(`missing ${marker}`, { [workflowFile]: workflow.replace(marker, "") });
      await check(`duplicate ${marker}`, { [workflowFile]: `${workflow}\n${marker}\n` });
    }
    await check("unrelated prose edit", { "README.md": readme.replace("Slate is a thread-weaving", "Slate is an orchestration-focused, thread-weaving") }, true);
    await check("new unreferenced nested document", { "docs/new/nested/unrelated.md": "# Notes\n\nThis document contains an unrelated note.\n" }, true);
    await check("harmless wrapping in reviewed list and loading paragraph", {
      "README.md": readme.replace(readmeReference, readmeReference.replace(" — the compact", " —\n  the compact")),
      [workflowFile]: workflow.replace("Immediately before preparing any track package or final change package, read\n", "Immediately before preparing any track\npackage or final change package, read\n"),
    }, true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
