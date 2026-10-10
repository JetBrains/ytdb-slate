import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectRequiredResults, type ResultEvent } from "../verification/required-case-reporter.ts";
import { requiredRoster, selectRequiredFiles } from "../verification/required-case-roster.ts";

const source = new URL("../", import.meta.url);
const jobArgs = ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout",
	"--test-reporter=./verification/required-case-reporter.ts", "--test-reporter-destination=stdout",
	"test/notification-push-portable.test.ts"];
const nativePath = "test/notification-native-macos-readback.test.ts";
const nativeName = "macOS native notification retains exact unique text in a new operating system store record";
const macJobArgs = [...jobArgs, nativePath];

function fixture(t: test.TestContext, platform = "win32") {
	const root = mkdtempSync(join(tmpdir(), "slate-required-case-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const dir of ["test", "verification"]) mkdirSync(join(root, dir));
	for (const file of ["test/required-case.ts", "verification/required-case-reporter.ts", "verification/required-case-roster.ts"])
		copyFileSync(new URL(file, source), join(root, file));
	const reporter = join(root, "verification/required-case-reporter.ts");
	const original = readFileSync(reporter, "utf8");
	assert.ok(original.includes("selectRequiredFiles()"));
	// Fixture selection exercises both job contracts on every host platform.
	writeFileSync(reporter, original.replace("selectRequiredFiles()", `selectRequiredFiles(undefined, ${JSON.stringify(platform)})`));
	writeFileSync(join(root, nativePath), platform === "darwin"
		? prefix + `requiredCase(${JSON.stringify(nativeName)}, {}, async (t, complete) => { complete(); });`
		: "");
	return root;
}

function execute(root: string, body: string, args = jobArgs) {
	writeFileSync(join(root, "test/notification-push-portable.test.ts"), body);
	const env: NodeJS.ProcessEnv = { ...process.env, CI: "true", NODE_NO_WARNINGS: "1" };
	// A nested CLI must own its runner instead of inheriting the parent test context.
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 10000, env });
	assert.equal(result.error, undefined, `child must finish: ${result.error}`);
	return { status: result.status, output: result.stdout + result.stderr };
}

const prefix = 'import { requiredCase } from "./required-case.ts";\n';
const names = requiredRoster[0]!.names;
function bodies(first: string, second = "complete();", options = "{}") {
	return prefix + names.map((name, index) =>
		`requiredCase(${JSON.stringify(name)}, ${index === 0 ? options : "{}"}, async (t, complete) => { ${index === 0 ? first : second} });`).join("\n");
}

for (const key of ["skip", "todo"]) {
	test(`required helper rejects every enabled ${key} option`, { timeout: 30000 }, (t) => {
		const root = fixture(t);
		for (const value of ['true', '"reason"', '""', '0', 'null', 'NaN', '0n', '[]', '{}', '1', '"false"']) {
			const result = execute(root, bodies("complete();", undefined, `{ ${key}: ${value} }`));
			assert.notEqual(result.status, 0, `${key}: ${value}`);
			assert.match(result.output, new RegExp(`must not enable ${key}`));
		}
		for (const value of ["false", "undefined"]) {
			assert.equal(execute(root, bodies("complete();", undefined, `{ ${key}: ${value} }`)).status, 0);
		}
	});
}

test("required helper checks runtime calls and body-owned completion", { timeout: 30000 }, (t) => {
	const root = fixture(t);
	for (const body of ["return;", "", "await Promise.resolve();",
		"t.skip();", "t.skip(); return;", "t.todo();", "t.todo(); return;",
		"try { t.skip(); } catch {} complete();", "try { t.todo(); } catch {} complete();",
		"t.after(() => t.skip()); complete();", "t.after(() => t.todo()); complete();"]) {
		const result = execute(root, bodies(body));
		assert.notEqual(result.status, 0, body);
		assert.match(result.output, /must not call|terminal completion marker/);
	}
	const failure = execute(root, bodies('throw new Error("EARLIER_REAL_FAILURE_MESSAGE");'));
	assert.notEqual(failure.status, 0);
	assert.match(failure.output, /EARLIER_REAL_FAILURE_MESSAGE/);
	assert.equal(execute(root, 'import assert from "node:assert/strict";\n' +
		bodies('try { assert.fail("caught assertion outside guard"); } catch {} complete();')).status, 0);
	assert.equal(execute(root, bodies("await Promise.resolve(); complete();")).status, 0);
});

const file = fileURLToPath(new URL("test/notification-push-portable.test.ts", source));
const required = new Map([[file, names]]);
function events(): ResultEvent[] {
	return [...names.map((name): ResultEvent => ({ type: "test:pass", data: { name, file } })),
		{ type: "test:summary", data: { file, success: true,
			counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } }];
}

test("required reporter rejects optional, failed, absent and repeated results", { timeout: 10000 }, async () => {
	assert.deepEqual(await inspectRequiredResults(events(), required), []);
	for (const key of ["skip", "todo", "expectFailure"] as const) {
		for (const value of ["", false, 0, null, "reason", true]) {
			const input = events();
			input[0]!.data[key] = value;
			assert.ok((await inspectRequiredResults(input, required)).length, `${key}: ${value}`);
		}
	}
	for (const mutate of [
		(input: ResultEvent[]) => { input[0]!.type = "test:fail"; },
		(input: ResultEvent[]) => { input[0]!.data.name = "renamed"; },
		(input: ResultEvent[]) => { input.shift(); },
		(input: ResultEvent[]) => { input.push(input[0]!); },
		(input: ResultEvent[]) => { input.push(input[2]!); },
		(input: ResultEvent[]) => { input.pop(); },
		(input: ResultEvent[]) => { input[2]!.data.success = false; },
		(input: ResultEvent[]) => { delete input[2]!.data.counts; },
		(input: ResultEvent[]) => { input[0]!.data.details = { type: "suite" }; },
	]) {
		const input = events();
		mutate(input);
		assert.ok((await inspectRequiredResults(input, required)).length);
	}
	for (const key of ["tests", "passed", "failed", "cancelled", "skipped", "todo"] as const) {
		const input = events();
		input[2]!.data.counts![key]++;
		assert.ok((await inspectRequiredResults(input, required)).length, key);
	}
	assert.ok((await inspectRequiredResults([], required)).length);
	const extra = events();
	extra.push({ type: "test:pass", data: { file, name: "extra" } });
	assert.ok((await inspectRequiredResults(extra, required)).length);
	const unrelated = events();
	unrelated.push({ type: "test:pass", data: { file: "/unrelated.test.ts", name: "unrelated", skip: true } });
	assert.deepEqual(await inspectRequiredResults(unrelated, required), []);
});

test("required roster validates global uniqueness before platform selection", () => {
	assert.equal(selectRequiredFiles().size, process.platform === "darwin" ? 2 : 1);
	assert.equal(selectRequiredFiles(requiredRoster, "linux").size, 1);
	assert.equal(selectRequiredFiles(requiredRoster, "win32").size, 1);
	assert.equal(selectRequiredFiles(requiredRoster, "darwin").size, 2);
	assert.equal(requiredRoster.length, 2);
	assert.deepEqual(requiredRoster[1], { file: fileURLToPath(new URL(nativePath, source)),
		names: [nativeName], platforms: ["darwin"] });
	const entries = [{ file: "push", names: ["push"] },
		{ file: "native", names: ["native"], platforms: ["darwin"] }];
	assert.equal(selectRequiredFiles(entries, "win32").size, 1);
	assert.equal(selectRequiredFiles(entries, "darwin").size, 2);
	for (const roster of [[], [{ file: "", names: ["a"] }], [{ file: "a", names: [] }],
		[{ file: "a", names: [""] }], [{ file: "a", names: ["a", "a"] }],
		[{ file: "a", names: ["a"] }, { file: "a", names: ["b"] }],
		[{ file: "a", names: ["a"] }, { file: "b", names: ["a"], platforms: ["darwin"] }],
		[{ file: "a", names: ["a"], platforms: [] }],
		[{ file: "a", names: ["a"], platforms: ["darwin", "darwin"] }]]) {
		assert.throws(() => selectRequiredFiles(roster, "win32"), /required roster/);
	}
	assert.throws(() => selectRequiredFiles([entries[1]!], "win32"), /no cases/);
});

for (const [platform, args] of [["win32", jobArgs], ["darwin", macJobArgs]] as const) {
	test(`reviewed ${platform} job command rejects omission, filtering and optional suites`, { timeout: 30000 }, (t) => {
		const root = fixture(t, platform);
		const good = bodies("complete();");
		const workflow = readFileSync(new URL(".github/workflows/ci.yml", source), "utf8");
		const job = workflow.split(`  ${platform === "darwin" ? "macos" : "windows"}-notification-push:`)[1]!.split(/\n  [a-z][a-z-]+:/)[0]!;
		assert.deepEqual(job.match(/^        run: node .*$/gm), [`        run: node ${args.join(" ")}`]);
		assert.equal(execute(root, good, args).status, 0);
		for (const body of ["", "process.exit(0);", bodies("process.exit(0);"), bodies("complete();", "return;"),
			good.replace(names[0]!, "renamed"), good.split("\n").slice(0, 2).join("\n"),
			prefix + 'import { describe } from "node:test"; describe.skip("outer", () => {\n' + good.replace(prefix, "") + '\n});',
			prefix + 'import { describe } from "node:test"; describe.todo("outer", () => {\n' + good.replace(prefix, "") + '\n});']) {
			const result = execute(root, body, args);
			assert.notEqual(result.status, 0);
			assert.match(result.output, /REQUIRED CASE VERDICT: FAIL/);
		}
		for (const flag of ["--test-name-pattern=^portable push", "--test-skip-pattern=^portable push", "--test-only"]) {
			assert.notEqual(execute(root, good, [flag, ...args]).status, 0);
		}
		writeFileSync(join(root, "test/unrelated.test.ts"), 'import test from "node:test"; test("other", () => {});');
		for (const path of ["test/unrelated.test.ts", "test/missing*.test.ts", "test/missing.test.ts"]) {
			assert.notEqual(execute(root, good, [...jobArgs.slice(0, -1), path, ...args.slice(jobArgs.length)]).status, 0);
		}
		if (platform === "darwin") {
			assert.notEqual(execute(root, good, jobArgs).status, 0, "omitting the native file must fail");
			const nativeFile = join(root, nativePath), nativeGood = readFileSync(nativeFile, "utf8");
			for (const nativeBody of ["", "process.exit(0);", nativeGood.replace(nativeName, "renamed native"),
				nativeGood.replace("complete();", "return;"), nativeGood.replace("{},", "{ skip: true },"),
				nativeGood + "\n" + nativeGood.replace(prefix, "")]) {
				writeFileSync(nativeFile, nativeBody);
				const result = execute(root, good, args);
				assert.notEqual(result.status, 0);
				assert.match(result.output, /REQUIRED CASE VERDICT: FAIL/);
			}
		}
	});
}
