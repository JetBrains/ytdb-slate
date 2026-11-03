import assert from "node:assert/strict";
import { describe } from "node:test";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { requiredCase } from "./required-case.ts";
import { SAFE_RECORD_WRITE } from "../extension/paths.ts";

const names = [
	"safe record writes preserve exclusive creation and complete byte identity",
	"safe record writes reject unsafe leaves and retention aliases",
	"safe record writes report platform protections and checked fallback",
	"safe record writes detect changed identities before payload writes",
	"safe record writes retain partial bytes and primary failures",
	"safe record writes bound reports and guard the production interface",
];
const bytes = Buffer.alloc(150003, 77);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Report = { operation: string; code: string; stage: string; writeState: string; equal: boolean | null;
	sourceHash: string | null; destinationHash: string | null; expected: string; retainedVerified: boolean;
	protections: Record<string, string> };
function fixture(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), "slate-record space-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "-源 ' source"), destination = join(root, "destination");
	writeFileSync(source, bytes);
	return { root, source, destination };
}
function preload(root: string, body: string) {
	const path = join(root, "injection.cjs");
	writeFileSync(path, `const fs = require('node:fs');\n${body}\nrequire('node:module').syncBuiltinESMExports();\n`);
	return path;
}
async function run(args: string[], root: string, injection?: string, command = SAFE_RECORD_WRITE) {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const result = await subprocess(process.execPath, [...(injection ? ["--require", injection] : []), command, ...args], root, env);
	assert.ok(Buffer.byteLength(result.stdout) <= (args[0] === "--help" ? 1024 : 2048));
	assert.ok(Buffer.byteLength(result.stderr) <= 256);
	if (args[0] === "--help" && result.status === 0) {
		assert.equal(result.stderr, "");
		return { ...result, requestedOperation: "invalid", report: null as Report | null };
	}
	const report = JSON.parse(result.stdout) as Report;
	assert.equal(result.stdout.trim().split("\n").length, 1);
	assert.ok(!result.stdout.includes(root));
	assert.deepEqual(Object.keys(report.protections), ["exclusiveCreate", "noFollowOpen", "nonblockingOpen", "mode0600"]);
	for (const value of Object.values(report.protections)) assert.ok(["applied", "unavailable", "not-applicable"].includes(value));
	for (const value of [report.sourceHash, report.destinationHash]) if (value !== null) assert.match(value, /^[a-f0-9]{64}$/);
	return { ...result, requestedOperation: ["create", "preserve", "compare", "hash"].includes(args[0]!) ? args[0]! : "invalid", report };
}
function operation(op: string, source: string, destination?: string, expected?: string) {
	return [op, ...(expected ? ["--expected", expected] : []), "--", source, ...(destination ? [destination] : [])];
}
function expect(result: Awaited<ReturnType<typeof run>>, status: number, state = "not-created",
	stage = ({ 0: "complete", 2: "arguments", 3: "compare", 4: "compare", 5: "source", 6: "source", 7: "destination", 8: "destination" } as Record<number, string>)[status]) {
	const codes: Record<number, string> = { 0: "ok", 2: "usage", 3: "occupied", 4: "different", 5: "identity", 6: "io", 7: "changed", 8: "unsafe-file" };
	assert.equal(result.status, status, result.stdout + result.stderr);
	assert.equal(result.report!.code, codes[status]);
	assert.equal(result.report!.operation, result.requestedOperation);
	assert.equal(result.report!.stage, stage);
	assert.equal(result.report!.writeState, state);
	assert.equal(result.stderr, status === 0 ? "" : `safe-record-write: ${codes[status]}\n`);
	return result.report!;
}
async function subprocess(command: string, args: string[], cwd: string, env = { ...process.env }) {
	return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("child timeout")); }, 5000);
		let stdout = "", stderr = "";
		child.stdout.on("data", data => { stdout += data; if (Buffer.byteLength(stdout) > 8192) child.kill("SIGKILL"); });
		child.stderr.on("data", data => { stderr += data; if (Buffer.byteLength(stderr) > 8192) child.kill("SIGKILL"); });
		child.on("error", error => { clearTimeout(timer); reject(error); });
		child.on("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
	});
}
async function concurrent(args: string[], cwd: string) {
	return await new Promise<{ status: number | null; report: Report }>((resolve, reject) => {
		const child = spawn(process.execPath, [SAFE_RECORD_WRITE, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => { child.kill(); reject(new Error("child timeout")); }, 5000);
		let stdout = "";
		child.stdout.on("data", data => { stdout += data; });
		child.stderr.resume();
		child.on("error", reject);
		child.on("close", status => { clearTimeout(timer); resolve({ status, report: JSON.parse(stdout) as Report }); });
	});
}

describe("safe record command", { timeout: 60000 }, () => {
	requiredCase(names[0]!, { timeout: 12000 }, async (t, complete) => {
		const { root, source, destination } = fixture(t);
		const created = expect(await run(operation("create", source, destination, hash(bytes)), root), 0, "verified");
		assert.equal(created.expected, "agreed");
		assert.equal(created.equal, true);
		assert.equal(created.sourceHash, hash(bytes));
		assert.equal(created.destinationHash, hash(bytes));
		assert.deepEqual(readFileSync(destination), bytes);
		const occupied = expect(await run(operation("preserve", source, destination), root), 3);
		assert.equal(occupied.retainedVerified, true);
		assert.equal(expect(await run(operation("create", source, destination), root), 3).equal, true);
		assert.equal(expect(await run(operation("create", source, destination, "0".repeat(64)), root), 5).expected, "differs");
		assert.deepEqual(readFileSync(destination), bytes);
		writeFileSync(destination, "partial");
		assert.equal(expect(await run(operation("preserve", source, destination), root), 3).retainedVerified, false);
		assert.equal(expect(await run(operation("compare", source, destination), root), 4).equal, false);
		assert.equal(readFileSync(destination, "utf8"), "partial");
		const unequal = Buffer.from(bytes);
		unequal[0] = 0;
		writeFileSync(destination, unequal);
		const compared = expect(await run(operation("compare", source, destination), root), 4);
		assert.equal(compared.sourceHash, hash(bytes));
		assert.equal(compared.destinationHash, hash(unequal));
		assert.equal(expect(await run(operation("hash", source), root), 0).sourceHash, hash(bytes));
		assert.equal(expect(await run(operation("hash", source, undefined, "0".repeat(64)), root), 5).expected, "differs");
		const retained = join(root, "retained");
		expect(await run(operation("preserve", source, retained), root), 0, "verified");
		expect(await run(operation("compare", source, retained), root), 0);
		expect(await run(operation("hash", "-源 ' source"), root), 0);
		const race = join(root, "race");
		const results = await Promise.all([concurrent(operation("create", source, race), root), concurrent(operation("create", source, race), root)]);
		assert.equal(results.filter(r => r.status === 0).length, 1);
		assert.ok(results.every(r => r.status === 0 || r.status === 3 || r.status === 7));
		assert.deepEqual(results.map(r => r.report.writeState).sort(), ["not-created", "verified"]);
		assert.deepEqual(readFileSync(race), bytes);
		complete();
	});
	requiredCase(names[1]!, { timeout: 12000 }, async (t, complete) => {
		const { root, source, destination } = fixture(t);
		for (const alias of [source, join(root, "hard")]) {
			if (alias !== source) linkSync(source, alias);
			assert.equal(expect(await run(operation("preserve", source, alias), root), 3).retainedVerified, false);
		}
		const dangling = join(root, "dangling"), absent = join(root, "absent");
		symlinkSync(absent, dangling, "file");
		expect(await run(operation("create", source, dangling), root), 8);
		assert.throws(() => lstatSync(absent), /ENOENT/);
		const linked = join(root, "linked");
		symlinkSync(source, linked, "file");
		expect(await run(operation("hash", linked), root), 8, "not-created", "source");
		const directory = join(root, "directory");
		mkdirSync(directory);
		const junction = join(root, "junction");
		symlinkSync(directory, junction, process.platform === "win32" ? "junction" : "dir");
		for (const path of [directory, junction]) expect(await run(operation("create", source, path), root), 8);
		expect(await run(operation("hash", directory), root), 8, "not-created", "source");
		if (process.platform !== "win32") {
			const fifo = join(root, "fifo");
			assert.equal((await subprocess("mkfifo", [fifo], root)).status, 0);
			expect(await run(operation("hash", fifo), root), 8, "not-created", "source");
		}
		expect(await run(operation("create", source, join(root, "missing", "child")), root), 6, "not-created", "destination");
		assert.deepEqual(readFileSync(source), bytes);
		assert.throws(() => lstatSync(destination), /ENOENT/);
		complete();
	});
	requiredCase(names[2]!, { timeout: 12000 }, async (t, complete) => {
		const { root, source, destination } = fixture(t);
		for (const mode of [0o644, 0o666]) for (const mask of [0, 0o22]) {
			chmodSync(source, mode);
			const path = destination + mode + mask;
			const injection = preload(root, `process.umask(${mask});`);
			const report = expect(await run(operation("create", source, path), root, injection), 0, "verified");
			assert.equal(report.protections.exclusiveCreate, "applied");
			assert.equal(report.protections.mode0600, process.platform === "win32" ? "unavailable" : "applied");
			if (process.platform !== "win32") assert.equal(lstatSync(path).mode & 0o077, 0);
		}
		const injection = preload(root, `const open = fs.openSync; fs.openSync = (p, flags, mode) => {
		 if ((flags & (fs.constants.O_NOFOLLOW || 0)) || (flags & (fs.constants.O_NONBLOCK || 0))) throw Object.assign(new Error(), {code:'EINVAL'});
		 return open(p, flags, mode); };`);
		const reduced = expect(await run(operation("create", source, destination), root, injection), 0, "verified");
		assert.equal(reduced.protections.noFollowOpen, "unavailable");
		assert.equal(reduced.protections.nonblockingOpen, "unavailable");
		assert.equal(reduced.protections.exclusiveCreate, "applied");
		const unsupported = preload(root, `const open=fs.openSync; fs.openSync=(p,f,...a)=>{if(f & fs.constants.O_EXCL)throw Object.assign(new Error(),{code:"ENOTSUP"}); return open(p,f,...a);};`);
		const refused = expect(await run(operation("create", source, destination + "unsupported"), root, unsupported), 2, "not-created", "destination");
		assert.deepEqual(refused.protections, { exclusiveCreate: "unavailable", noFollowOpen: "unavailable",
			nonblockingOpen: "unavailable", mode0600: "not-applicable" });
		const loop = preload(root, `const open=fs.openSync; fs.openSync=(p,...a)=>{if(p===${JSON.stringify(source)})throw Object.assign(new Error(),{code:"ELOOP"}); return open(p,...a);};`);
		const blocked = expect(await run(operation("hash", source), root, loop), 8, "not-created", "source");
		assert.deepEqual(blocked.protections, { exclusiveCreate: "not-applicable",
			noFollowOpen: process.platform === "win32" ? "unavailable" : "applied",
			nonblockingOpen: process.platform === "win32" ? "unavailable" : "applied", mode0600: "not-applicable" });
		assert.throws(() => lstatSync(destination + "unsupported"), /ENOENT/);
		const broad = preload(root, `const stat = fs.fstatSync; fs.fstatSync = (...a) => {const s=stat(...a); s.mode |= 0o077n; return s;};`);
		assert.equal(expect(await run(operation("create", source, destination + "broad"), root, broad), 0, "verified").protections.mode0600, "unavailable");
		const readonly = expect(await run(operation("hash", source), root), 0);
		assert.equal(readonly.protections.exclusiveCreate, "not-applicable");
		assert.equal(readonly.protections.mode0600, "not-applicable");
		assert.equal(readonly.protections.noFollowOpen, process.platform === "win32" ? "unavailable" : "applied");
		complete();
	});
	requiredCase(names[3]!, { timeout: 12000 }, async (t, complete) => {
		const { root, source, destination } = fixture(t);
		for (const kind of ["identity", "link"]) {
			const path = destination + kind;
			const injection = preload(root, `const stat=fs.lstatSync; fs.lstatSync=(p,...a)=>{const s=stat(p,...a);
			 if(p===${JSON.stringify(path)}) { ${kind === "link" ? "s.isSymbolicLink=()=>true;" : "s.ino+=1n;"} } return s;};
			 fs.writeSync=()=>{throw new Error('payload write before safety check');};`);
			expect(await run(operation("create", source, path), root, injection), kind === "link" ? 8 : 7, "created-unverified");
			assert.equal(readFileSync(path).length, 0);
		}
		const big = preload(root, `const lstat=fs.lstatSync, fstat=fs.fstatSync;
		 fs.lstatSync=(...a)=>{const s=lstat(...a); s.ino=9007199254740993n; return s;};
		 fs.fstatSync=(...a)=>{const s=fstat(...a); s.ino=9007199254740992n; return s;};`);
		expect(await run(operation("hash", source), root, big), 7, "not-created", "source");
		const changing = preload(root, `const stat=fs.fstatSync; let n=0; fs.fstatSync=(...a)=>{const s=stat(...a); if(++n>3)s.mtimeNs+=1n; return s;};`);
		expect(await run(operation("hash", source), root, changing), 7, "not-created", "source");
		const reopen = preload(root, `const stat=fs.fstatSync, open=fs.openSync; let created;
		 fs.openSync=(p,f,...a)=>{const fd=open(p,f,...a); if(f & fs.constants.O_EXCL)created=fd; return fd;};
		 fs.fstatSync=(fd,...a)=>{const s=stat(fd,...a); if(created===fd)s.ino+=1n; return s;};`);
		expect(await run(operation("create", source, destination), root, reopen), 7, "created-unverified");
		assert.equal(readFileSync(destination).length, 0);
		const swapped = preload(root, `const stat=fs.lstatSync; let n=0; fs.lstatSync=(p,...a)=>{const s=stat(p,...a); if(p===${JSON.stringify(destination + "swap")} && ++n>=2)s.ino+=1n; return s;};`);
		expect(await run(operation("create", source, destination + "swap"), root, swapped), 7, "created-unverified", "copy");
		assert.deepEqual(readFileSync(destination + "swap"), bytes);
		const occupiedChange = preload(root, `const stat=fs.lstatSync; let n=0; fs.lstatSync=(p,...a)=>{const s=stat(p,...a); if(p===${JSON.stringify(destination + "swap")} && ++n===1)s.ino+=1n; return s;};`);
		expect(await run(operation("preserve", source, destination + "swap"), root, occupiedChange), 7);
		const changedName = preload(root, `const stat=fs.lstatSync; let n=0; fs.lstatSync=(p,...a)=>{const s=stat(p,...a); if(p===${JSON.stringify(source)} && ++n>=3)s.ino+=1n; return s;};`);
		expect(await run(operation("hash", source), root, changedName), 7, "not-created", "source");
		const replacement = destination + "replacement";
		const replace = preload(root, `const open=fs.openSync, close=fs.closeSync; let created;
		 fs.openSync=(p,f,...a)=>{const fd=open(p,f,...a); if(f & fs.constants.O_EXCL)created=fd; return fd;};
		 fs.closeSync=(fd)=>{close(fd); if(fd===created){created=undefined;
		 fs.renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(replacement + "original")});
		 fs.copyFileSync(${JSON.stringify(source)}, ${JSON.stringify(replacement)});}};`);
		const replaced = expect(await run(operation("create", source, replacement), root, replace), 7, "created-unverified", "copy");
		assert.equal(replaced.equal, null);
		assert.equal(replaced.destinationHash, null);
		assert.notEqual(lstatSync(replacement, { bigint: true }).ino, lstatSync(replacement + "original", { bigint: true }).ino);
		assert.deepEqual(readFileSync(replacement), bytes);
		const vanished = destination + "vanished";
		const rename = preload(root, `const open=fs.openSync; fs.openSync=(p,f,...a)=>{const fd=open(p,f,...a);
		 if(f & fs.constants.O_EXCL)fs.renameSync(p,p+"saved"); return fd;};`);
		expect(await run(operation("create", source, vanished), root, rename), 7, "created-unverified");
		assert.equal(readFileSync(vanished + "saved").length, 0);
		const rewrite = preload(root, `fs.utimesSync(${JSON.stringify(source)}, 1000000000, 1000000000);
		 const open=fs.openSync, close=fs.closeSync; let created;
		 fs.openSync=(p,f,...a)=>{const fd=open(p,f,...a); if(f & fs.constants.O_EXCL)created=fd; return fd;};
		 fs.closeSync=(fd)=>{close(fd); if(fd===created){created=undefined;
		 fs.writeFileSync(${JSON.stringify(source)}, Buffer.alloc(${bytes.length},78));
		 fs.utimesSync(${JSON.stringify(source)},1000000000,1000000000);}};`);
		const rewritten = expect(await run(operation("create", source, destination + "rewrite", hash(bytes)), root, rewrite), 7, "created-unverified", "compare");
		assert.equal(rewritten.expected, "agreed");
		assert.equal(rewritten.sourceHash, hash(Buffer.alloc(bytes.length, 78)));
		assert.equal(rewritten.destinationHash, hash(bytes));
		complete();
	});
	requiredCase(names[4]!, { timeout: 12000 }, async (t, complete) => {
		const { root, source, destination } = fixture(t);
		const partial = preload(root, `const write=fs.writeSync; let n=0; fs.writeSync=(...a)=>{if(++n===2)throw Object.assign(new Error(),{code:'EIO'}); return write(...a);};`);
		const failed = expect(await run(operation("preserve", source, destination), root, partial), 6, "created-unverified", "copy");
		assert.equal(readFileSync(destination).length, 65536);
		assert.equal(failed.equal, false);
		assert.equal(failed.destinationHash, hash(bytes.subarray(0, 65536)));
		const close = preload(root, `const open=fs.openSync, close=fs.closeSync; let dest;
		 fs.openSync=(p,f,...a)=>{const fd=open(p,f,...a); if(f & fs.constants.O_EXCL)dest=fd; return fd;};
		 fs.closeSync=(fd)=>{close(fd); if(fd===dest){dest=undefined; throw Object.assign(new Error(),{code:'EIO'});}};`);
		const closed = expect(await run(operation("create", source, destination + "close"), root, close), 6, "created-unverified", "copy");
		assert.equal(closed.equal, true);
		assert.deepEqual(readFileSync(destination + "close"), bytes);
		const foreign = destination + "foreign";
		const swapFailure = preload(root, `const open=fs.openSync, close=fs.closeSync; let created;
		 fs.openSync=(p,f,...a)=>{const fd=open(p,f,...a); if(f & fs.constants.O_EXCL)created=fd; return fd;};
		 fs.writeSync=()=>{throw Object.assign(new Error(),{code:"EIO"});};
		 fs.closeSync=(fd)=>{close(fd); if(fd===created){created=undefined;
		 fs.renameSync(${JSON.stringify(foreign)},${JSON.stringify(foreign + "original")});
		 fs.copyFileSync(${JSON.stringify(source)},${JSON.stringify(foreign)});}};`);
		const swappedFailure = expect(await run(operation("create", source, foreign), root, swapFailure), 6, "created-unverified", "copy");
		assert.equal(swappedFailure.equal, null);
		assert.equal(swappedFailure.destinationHash, null);
		const denied = preload(root, `const open=fs.openSync; fs.openSync=(p,...a)=>{if(p===${JSON.stringify(source)})throw Object.assign(new Error(),{code:'EACCES'}); return open(p,...a);};`);
		expect(await run(operation("create", source, destination + "denied", hash(bytes)), root, denied), 6);
		assert.throws(() => lstatSync(destination + "denied"), /ENOENT/);
		const interrupted = preload(root, `fs.writeSync=()=>{process.kill(process.pid,'SIGTERM'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);};`);
		const result = await subprocess(process.execPath, ["--require", interrupted, SAFE_RECORD_WRITE, ...operation("create", source, destination + "interrupted")], root);
		assert.notEqual(result.status, 0);
		assert.equal(result.stdout, "");
		assert.equal(readFileSync(destination + "interrupted").length, 0);
		assert.deepEqual(readFileSync(source), bytes);
		complete();
	});
	requiredCase(names[5]!, { timeout: 12000 }, async (t, complete) => {
		const { root, source } = fixture(t);
		const help = (await run(["--help"], root)).stdout;
		for (const name of ["create", "preserve", "compare", "hash"]) assert.match(help, new RegExp(name + ":"));
		for (const code of [0, 2, 3, 4, 5, 6, 7, 8]) assert.match(help, new RegExp("\\b" + code + " "));
		for (const args of [[], ["replace"], ["--help", "extra"], ["hash", "--", ""], ["hash", "--", source, source],
			["hash", "--expected", "bad", "--", source], ["compare", "--expected", hash(bytes), "--", source, source], ["hash", "--unknown", "--", source]]) expect(await run(args, root), 2);
		const broken = preload(root, `process.stdout.write=(s,cb)=>{cb(Object.assign(new Error(),{code:'EPIPE'})); return false;};`);
		const output = await subprocess(process.execPath, ["--require", broken, SAFE_RECORD_WRITE, ...operation("hash", source)], root);
		assert.equal(output.status, 6);
		assert.equal(output.stderr, "safe-record-write: io\n");
		assert.equal(output.stdout, "");
		const stderrFailure = preload(root, `process.stderr.write=(s,cb)=>{cb(Object.assign(new Error(),{code:"EPIPE"})); return false;};`);
		const lostDiagnostic = await subprocess(process.execPath, ["--require", stderrFailure, SAFE_RECORD_WRITE, "replace"], root);
		assert.equal(lostDiagnostic.status, 2);
		assert.equal(JSON.parse(lostDiagnostic.stdout).code, "usage");
		assert.equal(lostDiagnostic.stderr, "");
		const relocated = join(root, "installed space");
		mkdirSync(relocated);
		copyFileSync(SAFE_RECORD_WRITE, join(relocated, "safe-record-write.mjs"));
		copyFileSync(fileURLToPath(new URL("../extension/paths.ts", import.meta.url)), join(relocated, "paths.ts"));
		const resolver = join(root, "resolve.mjs");
		writeFileSync(resolver, `import { SAFE_RECORD_WRITE } from './installed space/paths.ts'; console.log(SAFE_RECORD_WRITE);`);
		const resolved = await subprocess(process.execPath, [resolver], root);
		assert.equal(resolved.status, 0);
		assert.equal(resolved.stdout.trim(), join(relocated, "safe-record-write.mjs"));
		expect(await run(operation("hash", source), root, undefined, resolved.stdout.trim()), 0);
		const production = readFileSync(SAFE_RECORD_WRITE, "utf8").replace(/\r\n/g, "\n");
		assert.ok(production.startsWith("#!/usr/bin/env node\n"));
		assert.doesNotMatch(production, /process\.env|child_process|\b(?:copyFile|cp|writeFile|unlink|rm|rename|chmod|fchmod|truncate|ftruncate|appendFile|createWriteStream)(?:Sync)?\s*\(/);
		assert.equal((production.match(/fs\.openSync\(/g) ?? []).length, 2);
		assert.match(production, /c\.O_RDWR \| c\.O_CREAT \| c\.O_EXCL : c\.O_RDONLY/);
		assert.match(production, /fs\.openSync\(path, base, 0o600\)/);
		assert.doesNotMatch(production, /openSync\([^\n]*['"](?:w|w\+|a|a\+)['"]/);
		const allowed = new Set(["constants", "fstatSync", "lstatSync", "openSync", "closeSync", "readSync", "writeSync"]);
		for (const match of production.matchAll(/\bfs\.([A-Za-z0-9_]+)/g)) assert.ok(allowed.has(match[1]!), match[0]);
		assert.doesNotMatch(production, /\bfs\s*\[|\b(?:require|import)\s*\(/);
		assert.deepEqual([...production.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map(m => m[1]), ["node:fs", "node:crypto"]);
		assert.doesNotMatch(production, /--(?:inject|fault|test)|process\.argv(?!\.slice\(2\))/);
		complete();
	});
});
