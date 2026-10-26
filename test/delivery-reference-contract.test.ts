import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Run the production assertion through its public wrapper. No copied predicate
// can turn a scanner defect into a passing mutation test.
// The aggregate limit allows slow-runner margin for sequential resolver calls.
test("delivery references stay inside reviewed contexts across shipped docs", { timeout: 840_000 }, async (t) => {
  const repo = process.cwd();
  const fixture = mkdtempSync(join(tmpdir(), "slate-delivery-references-"));
  try {
    for (const path of ["extension", "verification", "docs", "test", "README.md", "package.json"]) {
      cpSync(join(repo, path), join(fixture, path), { recursive: true });
    }
    mkdirSync(join(fixture, ".pi"));
    cpSync(join(repo, ".pi/slate.json"), join(fixture, ".pi/slate.json"));
    symlinkSync(join(repo, "node_modules"), join(fixture, "node_modules"), "dir");
    // No remaining check reads Git history when both original-base checks are excluded.
    const excluded = ["doctrine-original-base", "doctrine-original-controls"];
    const workflowFile = "docs/track-workflow.md";
    const workflow = readFileSync(join(fixture, workflowFile), "utf8");
    const readme = readFileSync(join(fixture, "README.md"), "utf8");
    const readmeReference = "- [`docs/delivery-packages.md`](docs/delivery-packages.md) — the compact track and change package format, read only before package preparation";
    const actor = "| orchestrator | track or change package | [delivery-packages.md](delivery-packages.md) | § Package preparation |";
    const begin = "<!-- delivery-package-loading:begin -->";
    const end = "<!-- delivery-package-loading:end -->";
    const loading = workflow.slice(workflow.indexOf(begin), workflow.indexOf(end) + end.length);
    assert.ok(readme.includes(readmeReference) && workflow.includes(actor) && loading.includes("Immediately before"));

    let cleanOutput = "";
    const mutationCounts = (output: string): Record<string, number> => JSON.parse(output.match(/^NOTE executed mutation counts: (.+)$/m)![1]!);
    function selectedOutput(output: string, contract: string, accepted: boolean, auditAccepted = true): void {
      assert.match(output, new RegExp(`^CHECK +selected-mutation-audit +${auditAccepted ? "PASS" : "FAIL"}\\b`, "m"));
      assert.deepEqual([...output.matchAll(/^CHECK +(\S+) /gm)].map((match) => match[1]), [contract, "selected-mutation-audit", "roster"]);
      const failures = Number(!accepted) + Number(!auditAccepted);
      assert.match(output, new RegExp(`^== summary: ${3 - failures} pass, ${failures} fail, 0 not run \\(3 result lines = 1 selected checks \\+ scoped mutation audit \\+ this roster audit\\) ==$`, "m"));
    }
    async function check(name: string, changes: Record<string, string>, accepted = false, contract = "contract-delivery-packages", auditAccepted = true, focusedGroup?: "surviving" | "protocol"): Promise<void> {
      await t.test(name, { timeout: 65_000 }, () => {
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
          const result = spawnSync("bash", [join(fixture, "verification/run-resolver-checks.sh"), "--repo", fixture, "--strict", ...(name === "clean source" || ["contract-escalation-routing", "contract-level-publishing"].includes(contract) ? ["--exclude", excluded.join(",")] : ["--only", contract])], {
            cwd: fixture, encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, JITI_FS_CACHE: "true" },
          });
          const output = `${result.stdout}\n${result.stderr}`;
          assert.equal(result.error, undefined, output);
          assert.equal(result.signal, null, output);
          assert.equal(result.status, accepted ? 0 : 1, output);
          assert.match(output, new RegExp(`^CHECK +${contract} +${accepted ? "PASS" : "FAIL"}\\b`, "m"));
          assert.match(output, /^CHECK +roster +PASS\b/m);
          if (focusedGroup) {
            const label = focusedGroup === "surviving"
              ? "surviving safeguards match current owned rules"
              : "retained-reference protocol matches current owned rules";
            assert.ok(output.includes(label + " →"), output);
          }
          if (name === "clean source") {
            cleanOutput = output;
            assert.equal(mutationCounts(output)["boundary-regression"], 31);
            assert.equal(mutationCounts(output)["delivery-boundaries"], 12);
            assert.equal(mutationCounts(output)["surviving-safeguards"], 53);
            assert.equal(mutationCounts(output)["retained-protocol"], 8);
            assert.deepEqual([...output.matchAll(/^CHECK +(\S+) +EXCLUDED\b/gm)].map((match) => match[1]), excluded);
            assert.match(output, /^== summary: 207 pass, 0 fail, 0 not run, 2 excluded \(209 result lines = 208 expected checks \+ this roster audit\) ==$/m);
          } else if (!["contract-escalation-routing", "contract-level-publishing"].includes(contract)) selectedOutput(output, contract, accepted, auditAccepted);
        } finally {
          for (const [path, original] of originals) {
            if (original === undefined) rmSync(path);
            else writeFileSync(path, original);
          }
        }
      });
    }

    await check("clean source", {}, true);
    await t.test("selected checks equal clean full-run verdicts and mutation counts", { timeout: 10_000 }, () => {
      for (const contract of ["contract-heading-regions", "contract-delivery-packages"]) {
        const result = spawnSync("bash", [join(fixture, "verification/run-resolver-checks.sh"), "--repo", fixture, "--only", contract], {
          encoding: "utf8", timeout: 5_000, maxBuffer: 2 * 1024 * 1024,
        });
        const output = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.error, undefined, output);
        assert.equal(result.status, 0, output);
        const verdict = new RegExp(`^CHECK +${contract} +(PASS|FAIL|NOT RUN)`, "m");
        assert.equal(output.match(verdict)?.[1], cleanOutput.match(verdict)?.[1], output);
        assert.match(output, /^CHECK +roster +PASS\b/m);
        selectedOutput(output, contract, true);
        assert.deepEqual(mutationCounts(output), contract === "contract-heading-regions" ? { "heading-policy": 882 } : {});
        if (contract === "contract-heading-regions") assert.equal(mutationCounts(cleanOutput)["heading-policy"], 882);
      }
    });
    const resolverFile = "verification/resolver-checks.mjs";
    const resolver = readFileSync(join(fixture, resolverFile), "utf8");
    const recursiveFile = "docs/recursive-workflow.md";
    const recursive = readFileSync(join(fixture, recursiveFile), "utf8");
    for (const [group, before, after] of [
      ["surviving", "Never destroy the exact state the user reviewed.", "Reviewed state may be discarded."],
      ["surviving", "Without that mapping, the original accepted marker remains evidence.", "Discard the original marker."],
      ["surviving", "Never move an existing reviewed binding, even by fast-forward.", "Move reviewed bindings freely."],
      ["surviving", "If any exception condition is unmet, pause and ask the user under the collision rule above.", "Continue when a condition is unmet."],
      ["surviving", "Do not move the old reference merely to solve that conflict.", "Move the old reference to solve the conflict."],
      ["surviving", "Intermediate track packages and review intentions list each remaining difference\nacross those surfaces and name the later child that owns it.", "Intermediate packages need no remaining differences."],
      ["surviving", "Agreement across documents, prompt guidance, and the extension is required at\nthe level boundary.", "Agreement is optional."],
      ["surviving", "A pause creates no permission to interleave commits in an open slice.", "A pause permits interleaving."],
      ["surviving", "If the host cannot supply the merged head, pause rather than infer it from a squash commit.", "Infer the merged head from the squash commit."],
      ["protocol", "Use `slate-retained/<change>/<name>`.", "Use any reference namespace."],
      ["protocol", "A reviewed reference is create-only, locally and remotely.", "Move reviewed references freely."],
    ] as const) {
      const file = /^(Never destroy|Without that mapping|Intermediate track packages|Agreement across)/.test(before) ? workflowFile : recursiveFile;
      const original = file === workflowFile ? workflow : recursive;
      assert.ok(original.includes(before), before);
      await check(`${group} group rejects: ${before}`, { [file]: original.replace(before, after) }, false, "contract-level-publishing", true, group);
    }
    const designContent = '"High-level design\\nKeep one identity.\\n\\nLow-level design\\nPut the line first."';
    assert.ok(resolver.includes(designContent));
    for (const content of ['""', '"Replacement content."']) {
      await check(`independent body expectation rejects ${content}`, {
        [resolverFile]: resolver.replace(designContent, content),
      }, false, "contract-escalation-routing");
    }
    const deliveryFile = "docs/delivery-packages.md";
    const delivery = readFileSync(join(fixture, deliveryFile), "utf8");
    for (const [before, after] of [
      ["Acceptance creates no delivery commit or rewrite.", "Create a final squashed delivery commit."],
      ["Keep the local branch and accepted-marker branches until root closure.", ""],
      ["Use the local branch for delivery verification and resume.", "Use the target branch for delivery verification."],
      ["check newly reachable history for private change records", "check only the final tree for private change records"],
      ["and private bytes, not only the final tree.", "and public filenames in the final tree."],
      ["On a match, pause.", "On a match, continue."],
      ["explicit waiver, or abandonment", "abandonment"],
      ["explicit waiver, or abandonment", "explicit waiver"],
      ["The user chooses", "The agent chooses"],
      ["to this permitted rewrite.", "to no rewrite."],
      ["Renew acceptance of its head before delivery verification.", ""],
      ["Keep all manual records and source chains.", ""],
    ] as const) {
      assert.ok(delivery.includes(before));
      await check(`local delivery rejects: ${before}`, { [deliveryFile]: delivery.replace(before, after) });
    }
    await check("valid accepted history with reflowed no-rewrite rule", {
      [deliveryFile]: delivery.replace("Acceptance creates no delivery commit or rewrite.", "Acceptance creates no delivery commit\n   or rewrite."),
    }, true);
    const publishingFile = "docs/pr-publishing.md";
    const publishing = readFileSync(join(fixture, publishingFile), "utf8");
    for (const rule of [
      "At creation, describe why the change is needed and the planned change.",
      "For the final description at level completion, describe delivered results.",
      "This form adds no workflow accounting or progress table.",
    ]) {
      assert.ok(publishing.includes(rule));
      await check(`changed default rule: ${rule}`, { [publishingFile]: publishing.replace(rule, "Always copy workflow accounting.") });
    }
    for (const rule of [
      "During implementation, keep progress, decisions, and plan differences in the research log.",
      "Do not refresh the draft description after each track or marker.",
      "Before renewed handoff for merge after fixes, refresh final-result text if the result or template changed.",
    ]) {
      assert.ok(publishing.includes(rule));
      await check(`changed description boundary: ${rule}`, { [publishingFile]: publishing.replace(rule, "Refresh the description after every commit.") }, false, "contract-heading-regions");
    }
    const rewriteLimit = "The rewrite exception applies only while the cumulative-commit rule exists.";
    assert.ok(workflow.includes(rewriteLimit));
    await check("surviving rewrite scope in mixed accounting", {
      [workflowFile]: workflow.replace(rewriteLimit, "The rewrite exception always applies."),
    }, false, "contract-heading-regions");
    const handoffRule = "After each required acceptance, reconcile the owning log and verify retained history through the ordered sequence in";
    assert.ok(publishing.includes(handoffRule));
    await check("redirected ready-handoff accounting", {
      [publishingFile]: publishing.replace(handoffRule, "After each required acceptance, copy accounting into the description through the sequence in"),
    });
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
      "docs/new/moved.md": `# ytdb-slate: multi-agent orchestration for the pi coding agent\n\n## Shipped docs\n\n${readmeReference}\n`,
    });
    await check("count-preserving heading move", { "README.md": readme.replace(readmeReference, "") + `\n## Early reads\n\n${readmeReference}\n` });
    await check("duplicated owning heading", { "README.md": `${readme}\n## Shipped docs\n\nUnrelated text.\n` });
    await check("changed parent heading", { "README.md": readme.replace("# ytdb-slate: multi-agent orchestration for the pi coding agent\n", "# Other title\n") });
    const notes = readFileSync(join(fixture, "docs/user-notes.md"), "utf8");
    const combinedPackage = notes.match(/Use \[delivery-packages\.md\]\(delivery-packages\.md\) § Change package[\s\S]*?(?=\n\n)/)?.[0];
    assert.ok(combinedPackage);
    await check("count-preserving reference order change within one heading", {
      "docs/user-notes.md": notes.replace(combinedPackage, "") + `\n\n${combinedPackage}\n`,
    });
    for (const [file, heading] of [[workflowFile, "### Delivery history and accounting"], ["docs/user-notes.md", "### Final accounting preparation"]] as const) {
      const source = readFileSync(join(fixture, file), "utf8");
      assert.ok(source.includes(heading));
      await check(`changed accounting subsection: ${file}`, { [file]: source.replace(heading, "### Other accounting") });
      await check(`duplicated accounting subsection: ${file}`, { [file]: source.replace(heading, `${heading}\n${heading}`) });
    }
    for (const [file, rule] of [
      ["docs/user-notes.md", "- every finding and its disposition."],
      [workflowFile, "Accepted history is delivery. Acceptance creates no delivery commit or rewrite."],
      [workflowFile, "A bootstrap commit created to open a draft pull request uses\n`Bootstrap: <intent title>`."],
    ] as const) {
      const source = readFileSync(join(fixture, file), "utf8");
      assert.ok(source.includes(rule));
      await check(`removed kept anchor: ${rule}`, { [file]: source.replace(rule, "") }, false, "contract-heading-regions", false);
    }
    for (const [before, after] of [
      ["starts its body with", "ends its body with"],
      ["Keep it fixed across pull request renames.", "Keep it updated across pull request renames."],
      ["with the complete line `Change: <change title>`", "without a change title"],
    ] as const) {
      assert.ok(workflow.includes(before));
      await check(`changed commit identity: ${before}`, { [workflowFile]: workflow.replace(before, after) }, false, "contract-heading-regions");
    }
    await check("changed owned loading rule", { [workflowFile]: workflow.replace("Immediately before preparing any track package or final change package", "At session start") });
    await check("moved owned loading unit", { [workflowFile]: workflow.replace(loading, "") + `\n## Early reads\n\n${loading}\n` });
    for (const marker of [begin, end]) {
      await check(`missing ${marker}`, { [workflowFile]: workflow.replace(marker, "") });
      await check(`duplicate ${marker}`, { [workflowFile]: `${workflow}\n${marker}\n` });
    }
    await check("unrelated prose edit", { "README.md": readme.replace("Slate sends bounded actions", "Slate sends small, bounded actions") }, true);
    await check("new unreferenced nested document", { "docs/new/nested/unrelated.md": "# Notes\n\nThis document contains an unrelated note.\n" }, true);
    await check("harmless wrapping in reviewed list and loading paragraph", {
      "README.md": readme.replace(readmeReference, readmeReference.replace(" — the compact", " —\n  the compact")),
      [workflowFile]: workflow.replace("Immediately before preparing any track package or final change package, read\n", "Immediately before preparing any track\npackage or final change package, read\n"),
    }, true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
