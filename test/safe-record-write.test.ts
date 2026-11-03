import assert from "node:assert/strict";
import { describe } from "node:test";
import { spawn, spawnSync } from "node:child_process";
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
function run(args: string[], root: string, injection?: string, command = SAFE_RECORD_WRITE) {
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(process.execPath, [...(injection ? ["--require", injection] : []), command, ...args],
		{ cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 8192, env });
	assert.equal(result.error, undefined);
	assert.ok(Buffer.byteLength(result.stdout) <= (args[0] === "--help" ? 1024 : 2048));
	assert.ok(Buffer.byteLength(result.stderr) <= 256);
	if (args[0] === "--help" && result.status === 0) {
		assert.equal(result.stderr, "");
		return { ...result, report: null as Report | null };
	}
	const report = JSON.parse(result.stdout) as Report;
	assert.equal(result.stdout.trim().split("\n").length, 1);
	assert.ok(!result.stdout.includes(root));
	assert.deepEqual(Object.keys(report.protections), ["exclusiveCreate", "noFollowOpen", "nonblockingOpen", "mode0600"]);
	for (const value of Object.values(report.protections)) assert.ok(["applied", "unavailable", "not-applicable"].includes(value));
	for (const value of [report.sourceHash, report.destinationHash]) if (value !== null) assert.match(value, /^[a-f0-9]{64}$/);
	assert.equal(result.stderr, result.status === 0 ? "" : `safe-record-write: ${report.code}\n`);
	return { ...result, report };
}
function operation(op: string, source: string, destination?: string, expected?: string) {
	return [op, ...(expected ? ["--expected", expected] : []), "--", source, ...(destination ? [destination] : [])];
}
function expect(result: ReturnType<typeof run>, status: number, state = "not-created") {
	assert.equal(result.status, status, result.stdout + result.stderr);
	assert.equal(result.report!.writeState, state);
	return result.report!;
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
		const created = expect(run(operation("create", source, destination, hash(bytes)), root), 0, "verified");
		assert.equal(created.expected, "agreed");
		assert.equal(created.equal, true);
		assert.equal(created.sourceHash, hash(bytes));
		assert.equal(created.destinationHash, hash(bytes));
		assert.deepEqual(readFileSync(destination), bytes);
		const occupied = expect(run(operation("preserve", source, destination), root), 3);
		assert.equal(occupied.retainedVerified, true);
		assert.equal(expect(run(operation("create", source, destination), root), 3).equal, true);
		assert.equal(expect(run(operation("create", source, destination, "0".repeat(64)), root), 5).expected, "differs");
		assert.deepEqual(readFileSync(destination), bytes);
		writeFileSync(destination, "partial");
		assert.equal(expect(run(operation("preserve", source, destination), root), 3).retainedVerified, false);
		assert.equal(expect(run(operation("compare", source, destination), root), 4).equal, false);
		assert.equal(readFileSync(destination, "utf8"), "partial");
		const unequal = Buffer.from(bytes);
		unequal[0] = 0;
		writeFileSync(destination, unequal);
		const compared = expect(run(operation("compare", source, destination), root), 4);
		assert.equal(compared.sourceHash, hash(bytes));
		assert.equal(compared.destinationHash, hash(unequal));
		assert.equal(expect(run(operation("hash", source), root), 0).sourceHash, hash(bytes));
		assert.equal(expect(run(operation("hash", source, undefined, "0".repeat(64)), root), 5).expected, "differs");
		const retained = join(root, "retained");
		expect(run(operation("preserve", source, retained), root), 0, "verified");
		expect(run(operation("compare", source, retained), root), 0);
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
			assert.equal(expect(run(operation("preserve", source, alias), root), 3).retainedVerified, false);
		}
		const dangling = join(root, "dangling"), absent = join(root, "absent");
		symlinkSync(absent, dangling, "file");
		expect(run(operation("create", source, dangling), root), 8);
		assert.throws(() => lstatSync(absent), /ENOENT/);
		const linked = join(root, "linked");
		symlinkSync(source, linked, "file");
		expect(run(operation("hash", linked), root), 8);
		const directory = join(root, "directory");
		mkdirSync(directory);
		const junction = join(root, "junction");
		symlinkSync(directory, junction, process.platform === "win32" ? "junction" : "dir");
		for (const path of [directory, junction]) expect(run(operation("create", source, path), root), 8);
		expect(run(operation("hash", directory), root), 8);
		if (process.platform !== "win32") {
			const fifo = join(root, "fifo");
			assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
			expect(run(operation("hash", fifo), root), 8);
		}
		expect(run(operation("create", source, join(root, "missing", "child")), root), 6);
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
			const report = expect(run(operation("create", source, path), root, injection), 0, "verified");
			assert.equal(report.protections.exclusiveCreate, "applied");
			assert.equal(report.protections.mode0600, process.platform === "win32" ? "unavailable" : "applied");
			if (process.platform !== "win32") assert.equal(lstatSync(path).mode & 0o077, 0);
		}
		const injection = preload(root, `const open = fs.openSync; fs.openSync = (p, flags, mode) => {
		 if ((flags & (fs.constants.O_NOFOLLOW || 0)) || (flags & (fs.constants.O_NONBLOCK || 0))) throw Object.assign(new Error(), {code:'EINVAL'});
		 return open(p, flags, mode); };`);
		const reduced = expect(run(operation("create", source, destination), root, injection), 0, "verified");
		assert.equal(reduced.protections.noFollowOpen, "unavailable");
		assert.equal(reduced.protections.nonblockingOpen, "unavailable");
		assert.equal(reduced.protections.exclusiveCreate, "applied");
		const unsupported = preload(root, `const open=fs.openSync; fs.openSync=(p,f,...a)=>{if(f & fs.constants.O_EXCL)throw Object.assign(new Error(),{code:"ENOTSUP"}); return open(p,f,...a);};`);
		expect(run(operation("create", source, destination + "unsupported"), root, unsupported), 2);
		assert.throws(() => lstatSync(destination + "unsupported"), /ENOENT/);
		const broad = preload(root, `const stat = fs.fstatSync; fs.fstatSync = (...a) => {const s=stat(...a); s.mode |= 0o077n; return s;};`);
		assert.equal(expect(run(operation("create", source, destination + "broad"), root, broad), 0, "verified").protections.mode0600, "unavailable");
		const readonly = expect(run(operation("hash", source), root), 0);
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
			expect(run(operation("create", source, path), root, injection), kind === "link" ? 8 : 7, "created-unverified");
			assert.equal(readFileSync(path).length, 0);
		}
		const big = preload(root, `const lstat=fs.lstatSync, fstat=fs.fstatSync;
		 fs.lstatSync=(...a)=>{const s=lstat(...a); s.ino=9007199254740993n; return s;};
		 fs.fstatSync=(...a)=>{const s=fstat(...a); s.ino=9007199254740992n; return s;};`);
		expect(run(operation("hash", source), root, big), 7);
		const changing = preload(root, `const stat=fs.fstatSync; let n=0; fs.fstatSync=(...a)=>{const s=stat(...a); if(++n>3)s.mtimeNs+=1n; return s;};`);
		expect(run(operation("hash", source), root, changing), 7);
		const reopen = preload(root, `const stat=fs.fstatSync, open=fs.openSync; let created;
		 fs.openSync=(p,f,...a)=>{const fd=open(p,f,...a); if(f & fs.constants.O_EXCL)created=fd; return fd;};
		 fs.fstatSync=(fd,...a)=>{const s=stat(fd,...a); if(created===fd)s.ino+=1n; return s;};`);
		expect(run(operation("create", source, destination), root, reopen), 7, "created-unverified");
		assert.equal(readFileSync(destination).length, 0);
		const swapped = preload(root, `const stat=fs.lstatSync; let n=0; fs.lstatSync=(p,...a)=>{const s=stat(p,...a); if(p===${JSON.stringify(destination + "swap")} && ++n>=2)s.ino+=1n; return s;};`);
		expect(run(operation("create", source, destination + "swap"), root, swapped), 7, "created-unverified");
		assert.deepEqual(readFileSync(destination + "swap"), bytes);
		const occupiedChange = preload(root, `const stat=fs.lstatSync; let n=0; fs.lstatSync=(p,...a)=>{const s=stat(p,...a); if(p===${JSON.stringify(destination + "swap")} && ++n===1)s.ino+=1n; return s;};`);
		expect(run(operation("preserve", source, destination + "swap"), root, occupiedChange), 7);
		const changedName = preload(root, `const stat=fs.lstatSync; let n=0; fs.lstatSync=(p,...a)=>{const s=stat(p,...a); if(p===${JSON.stringify(source)} && ++n>=3)s.ino+=1n; return s;};`);
		expect(run(operation("hash", source), root, changedName), 7);
		assert.deepEqual(readFileSync(source), bytes);
		complete();
	});
	requiredCase(names[4]!, { timeout: 12000 }, async (t, complete) => {
		const { root, source, destination } = fixture(t);
		const partial = preload(root, `const write=fs.writeSync; let n=0; fs.writeSync=(...a)=>{if(++n===2)throw Object.assign(new Error(),{code:'EIO'}); return write(...a);};`);
		const failed = expect(run(operation("preserve", source, destination), root, partial), 6, "created-unverified");
		assert.equal(readFileSync(destination).length, 65536);
		assert.equal(failed.equal, false);
		assert.equal(failed.destinationHash, hash(bytes.subarray(0, 65536)));
		const close = preload(root, `const open=fs.openSync, close=fs.closeSync; let dest;
		 fs.openSync=(p,f,...a)=>{const fd=open(p,f,...a); if(f & fs.constants.O_EXCL)dest=fd; return fd;};
		 fs.closeSync=(fd)=>{close(fd); if(fd===dest){dest=undefined; throw Object.assign(new Error(),{code:'EIO'});}};`);
		const closed = expect(run(operation("create", source, destination + "close"), root, close), 6, "created-unverified");
		assert.equal(closed.equal, true);
		assert.deepEqual(readFileSync(destination + "close"), bytes);
		const denied = preload(root, `const open=fs.openSync; fs.openSync=(p,...a)=>{if(p===${JSON.stringify(source)})throw Object.assign(new Error(),{code:'EACCES'}); return open(p,...a);};`);
		expect(run(operation("create", source, destination + "denied", hash(bytes)), root, denied), 6);
		assert.throws(() => lstatSync(destination + "denied"), /ENOENT/);
		const interrupted = preload(root, `fs.writeSync=()=>{process.kill(process.pid,'SIGTERM'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);};`);
		const result = spawnSync(process.execPath, ["--require", interrupted, SAFE_RECORD_WRITE, ...operation("create", source, destination + "interrupted")], { timeout: 3000, encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.equal(result.stdout, "");
		assert.equal(readFileSync(destination + "interrupted").length, 0);
		assert.deepEqual(readFileSync(source), bytes);
		complete();
	});
	requiredCase(names[5]!, { timeout: 12000 }, async (t, complete) => {
		const { root, source } = fixture(t);
		assert.match(run(["--help"], root).stdout, /exclusive creation/);
		for (const args of [[], ["replace"], ["--help", "extra"], ["hash", "--", ""], ["hash", "--", source, source],
			["hash", "--expected", "bad", "--", source], ["compare", "--expected", hash(bytes), "--", source, source], ["hash", "--unknown", "--", source]]) expect(run(args, root), 2);
		const broken = preload(root, `process.stdout.write=(s,cb)=>{cb(Object.assign(new Error(),{code:'EPIPE'})); return false;};`);
		const output = spawnSync(process.execPath, ["--require", broken, SAFE_RECORD_WRITE, ...operation("hash", source)], { encoding: "utf8", timeout: 5000 });
		assert.equal(output.status, 6);
		assert.equal(output.stderr, "safe-record-write: io\n");
		assert.equal(output.stdout, "");
		const relocated = join(root, "installed space");
		mkdirSync(relocated);
		copyFileSync(SAFE_RECORD_WRITE, join(relocated, "safe-record-write.mjs"));
		copyFileSync(fileURLToPath(new URL("../extension/paths.ts", import.meta.url)), join(relocated, "paths.ts"));
		const resolver = join(root, "resolve.mjs");
		writeFileSync(resolver, `import { SAFE_RECORD_WRITE } from './installed space/paths.ts'; console.log(SAFE_RECORD_WRITE);`);
		const resolved = spawnSync(process.execPath, [resolver], { encoding: "utf8", timeout: 5000 });
		assert.equal(resolved.status, 0);
		assert.equal(resolved.stdout.trim(), join(relocated, "safe-record-write.mjs"));
		expect(run(operation("hash", source), root, undefined, resolved.stdout.trim()), 0);
		const production = readFileSync(SAFE_RECORD_WRITE, "utf8");
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
