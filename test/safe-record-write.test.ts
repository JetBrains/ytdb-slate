import assert from "node:assert/strict";
import { describe } from "node:test";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { requiredCase } from "./required-case.ts";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { CHANGE_RECORDS_DOC, RECORD_WRITE_RECOVERY_DOC, SAFE_RECORD_WRITE_DOC, SAFE_RECORD_WRITE } from "../extension/paths.ts";

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

const precedenceRule = "Known exits 2, 5, 6, 8, unavailable exclusive creation and a command that cannot run take precedence.";

// This fixture interpreter checks the manual reference. It grants no runtime authority.
function checkWorkerReference(reference: string, common: string, recovery: string) {
	reference = reference.replace(/\r\n/g, "\n");
	common = common.replace(/\r\n/g, "\n");
	recovery = recovery.replace(/\r\n/g, "\n");
	const referenceRules = [
		"Every success requires exit 0, code ok and stage complete.",
		"Every success also requires expected agreed when a hash was supplied, otherwise not-supplied.",
		"Creation requires operation create, writeState verified, equal true, equal full sourceHash and destinationHash, retainedVerified false and protections.exclusiveCreate applied.",
		"When supplied, the expected hash must equal both reported hashes.",
		"Comparison requires writeState not-created, equal true, equal full hashes, retainedVerified false and expected not-supplied.",
		"Hashing requires writeState not-created, a full sourceHash, equal null, destinationHash null and retainedVerified false.",
	];
	const commonRules = [
		"Plan edits require the root log's eligible stored identity, verified preservation and the orchestrator decision's plan hash.",
		"After checked design/map/plan edits, report the full hash.",
		"Creation needs operation create, code ok, writeState verified, equal true, equal full hashes and any expected hash agreed, not exit 0 alone.",
	];
	const requireRules = (source: string, rules: readonly string[]) => {
		for (const rule of rules) assert.equal(source.split(rule).length, 2, rule);
	};
	for (const [source, rules] of [[reference, referenceRules], [common, commonRules]] as const) {
		requireRules(source, rules);
		for (const rule of rules) {
			assert.throws(() => requireRules(source.replace(rule, "Requires no proof."), rules));
			for (const word of rule.match(/\S+/g)!) {
				assert.throws(() => requireRules(source.replace(rule, rule.replace(word, "")), rules));
			}
		}
	}
	const precedence = "Known exits 2, 5, 6, 8, create exits 4/7, a command that cannot run and unavailable exclusive creation take precedence.";
	const ordered = (source: string) => {
		requireRules(source, [precedence]);
		assert.ok(source.indexOf(precedence) < source.indexOf("For create,"));
	};
	assert.equal(common.split(precedenceRule).length, 1);
	ordered(reference);
	assert.throws(() => ordered(reference.replace(precedence + "\n", "") + "\n" + precedence));
	for (const clause of ["2, ", "5, ", "6, ", "8, ", "unavailable exclusive creation", "a command that cannot run"]) {
		assert.throws(() => ordered(reference.replace(precedence, precedence.replace(clause, ""))));
	}
	const delegation = "Failed or unclear creation: only common command-result retries.";
	requireRules(recovery, [delegation]);
	assert.throws(() => requireRules(recovery.replace(delegation, ""), [delegation]));
	const command = readFileSync(SAFE_RECORD_WRITE, "utf8");
	const checkRange = (text: string, source: string) => {
		const range = /safe-record-write\.mjs:(\d+)–(\d+)/.exec(text)!;
		const lines = source.split(/\r?\n/);
		assert.equal(Number(range[1]), lines.findIndex(line => line === "/*") + 1);
		assert.equal(Number(range[2]), lines.findIndex(line => line === " */") + 1);
	};
	for (const newline of ["\n", "\r\n"]) {
		const source = command.replace(/\r?\n/g, newline);
		checkRange(reference, source);
		assert.throws(() => checkRange(reference.replace(":2–62", ":2–61"), source));
		assert.throws(() => checkRange(reference, source.replace(" */", ` * extra${newline} */`)));
	}
	const operations = ["create", "compare", "hash", "preserve", "invalid"];
	const exits = [0, 2, 3, 4, 5, 6, 7, 8];
	const classes = ["accept", "retry creation", "retry preservation", "pause occupied", "pause identity", "pause unknown"];
	function table(source: string) {
		const rows = source.split("\n").filter(line => line.startsWith("| ") && !line.startsWith("| Operation |") && !line.startsWith("| ---"))
			.map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
		assert.deepEqual(rows.map(row => row[0]), operations);
		assert.equal(new Set(rows.map(row => row[0])).size, 5);
		const header = source.split("\n").filter(line => line.startsWith("| Operation |"));
		assert.equal(header.length, 1);
		assert.deepEqual(header[0]!.split("|").slice(2, -1).map(cell => cell.trim()),
			["0 ok", "2 usage", "3 occupied", "4 different", "5 identity", "6 io", "7 changed", "8 unsafe-file"]);
		assert.ok(rows.every(row => row.length === 9 && row.slice(1).every(cell => [...classes, "accept retention or retry preservation"].includes(cell!))));
		return new Map(rows.map(row => [row[0]!, row.slice(1)]));
	}
	const routes = table(reference);
	const expected = [
		["accept", "pause unknown", "pause occupied", "pause unknown", "pause identity", "pause unknown", "pause unknown", "pause unknown"],
		["accept", ...Array(7).fill("pause unknown")],
		["accept", "pause unknown", "pause unknown", "pause unknown", "pause identity", "pause unknown", "pause unknown", "pause unknown"],
		["accept", "pause unknown", "accept retention or retry preservation", "pause unknown", "pause identity", "pause unknown", "pause unknown", "pause unknown"],
		Array(8).fill("pause unknown"),
	];
	for (const [i, op] of operations.entries()) assert.deepEqual(routes.get(op), expected[i]);
	const row = reference.split("\n").find(line => line.startsWith("| create |"))!;
	assert.throws(() => table(reference.replace(row, "")));
	assert.throws(() => table(reference.replace(row, row + "\n" + row)));
	assert.throws(() => table(reference.replace(row, row.replace("accept", "replace occupied"))));
	assert.throws(() => table(reference.replace(row, row + "\n" + row.replace("create", "replace"))));
	assert.throws(() => table(reference.replace("| 0 ok |", "| 0 ok | 0 ok |")));
	const digest = hash(bytes);
	const proof = { operation: "create", code: "ok", stage: "complete", writeState: "verified",
		equal: true, sourceHash: digest, destinationHash: digest, expected: "agreed", retainedVerified: false,
		protections: { exclusiveCreate: "applied" } };
	const accepts = (value: Record<string, unknown>, expected?: string) =>
		value.operation === "create" && value.code === "ok" && value.stage === "complete"
		&& value.writeState === "verified" && value.equal === true && value.retainedVerified === false
		&& typeof value.sourceHash === "string" && /^[a-f0-9]{64}$/.test(value.sourceHash)
		&& value.sourceHash === value.destinationHash && (!expected || expected === value.sourceHash)
		&& value.expected === (expected ? "agreed" : "not-supplied")
		&& (value.protections as Record<string, unknown>)?.exclusiveCreate === "applied";
	assert.ok(accepts(proof, digest));
	assert.ok(accepts({ ...proof, expected: "not-supplied" }));
	assert.equal(accepts(proof, "0".repeat(64)), false);
	for (const key of Object.keys(proof)) assert.equal(accepts({ ...proof, [key]: null }, digest), false, key);
	for (const key of ["sourceHash", "destinationHash"]) {
		assert.equal(accepts({ ...proof, [key]: "0".repeat(64) }, digest), false);
		assert.equal(accepts({ ...proof, [key]: digest.slice(0, 12) }, digest), false);
	}
	const codes = ["ok", "usage", "occupied", "different", "identity", "io", "changed", "unsafe-file"];
	const acceptsOperation = (op: string, value: Record<string, unknown>, expected?: string): boolean => {
		if (op === "create") return accepts(value, expected);
		if (op === "preserve") return route(op, value.code === "occupied" ? 3 : 0, [value], expected) === "accept";
		const fullHash = typeof value.sourceHash === "string" && /^[a-f0-9]{64}$/.test(value.sourceHash);
		const base = value.operation === op && value.code === "ok" && value.stage === "complete"
			&& value.writeState === "not-created" && value.retainedVerified === false && fullHash
			&& value.expected === (expected ? "agreed" : "not-supplied")
			&& (!expected || expected === value.sourceHash);
		return base && (op === "hash" ? value.equal === null && value.destinationHash === null
			: op === "compare" && !expected && value.equal === true && value.sourceHash === value.destinationHash);
	};
	let routeStopEvidence = true;
	function route(op: string, exit: number | null, reports: Record<string, unknown>[], expected?: string, canRun = true, exclusive = true, occupiedOnly = false, retryAllowed = false): string {
		if (["create", "preserve"].includes(op) && [4, 7].includes(exit!)) {
			routeStopEvidence = false;
			return "pause unknown";
		}
		if (exit === 5 && ["create", "preserve", "hash"].includes(op)) return "pause identity";
		if (!canRun || !exclusive || [2, 6, 8].includes(exit!)) return "pause unknown";
		const index = exits.indexOf(exit!);
		const report = reports[0];
		if (reports.length !== 1 || !report || report.operation !== op || report.code !== codes[index] || index < 0) {
			return op === "create" ? "retry creation" : "pause unknown";
		}
		if (op === "preserve") {
			const full = typeof report.sourceHash === "string" && /^[a-f0-9]{64}$/.test(report.sourceHash);
			const protections = report.protections as Record<string, unknown> | null;
			const validProtections = protections && Object.keys(protections).sort().join(",") === "exclusiveCreate,mode0600,noFollowOpen,nonblockingOpen"
				&& Object.values(protections).every(value => ["applied", "unavailable", "not-applicable"].includes(String(value)));
			const identity = full && validProtections && report.expected === (expected ? "agreed" : "not-supplied") && (!expected || expected === report.sourceHash);
			const occupied = exit === 3 && report.stage === "compare" && report.writeState === "not-created";
			const fresh = !occupiedOnly && exit === 0 && report.stage === "complete" && report.writeState === "verified"
				&& (report.protections as Record<string, unknown>)?.exclusiveCreate === "applied";
			if (identity && (occupied || fresh) && report.equal === true && report.sourceHash === report.destinationHash && report.retainedVerified === true) return "accept";
			if (!occupiedOnly && occupied && identity && report.equal === false && report.retainedVerified === false
				&& typeof report.destinationHash === "string" && /^[a-f0-9]{64}$/.test(report.destinationHash)
				&& report.sourceHash !== report.destinationHash && retryAllowed) return "retry preservation";
			return "pause unknown";
		}
		const selected = routes.get(op)?.[index] ?? "pause unknown";
		return selected === "accept" && !acceptsOperation(op, report, expected) ? "pause unknown" : selected;
	}
	for (const op of operations) for (const [i, exit] of exits.entries()) {
		const report = { ...proof, operation: op, code: codes[i],
			...(op === "hash" ? { writeState: "not-created", equal: null, destinationHash: null } : {}),
			...(op === "compare" ? { writeState: "not-created", expected: "not-supplied" } : {}) };
		if (op !== "preserve") assert.equal(route(op, exit, [report], op === "compare" ? undefined : digest), expected[operations.indexOf(op)]![i]);
		else {
			const retained = { ...report, protections: { exclusiveCreate: "applied", noFollowOpen: "applied", nonblockingOpen: "applied", mode0600: "applied" }, retainedVerified: true, stage: exit === 3 ? "compare" : "complete", writeState: exit === 3 ? "not-created" : "verified" };
			assert.equal(route(op, exit, [retained], digest), exit === 0 || exit === 3 ? "accept" : exit === 5 ? "pause identity" : "pause unknown");
		}
	}
	for (const bad of [[], [proof, proof], [{ ...proof, code: "bad" }]]) assert.equal(route("create", 0, bad, digest), "retry creation");
	for (const exit of [4, 7]) for (const reports of [[], [proof, proof], [{ ...proof, code: "bad" }]]) {
		routeStopEvidence = true;
		assert.equal(route("create", exit, reports, digest), "pause unknown");
		assert.equal(routeStopEvidence, false, `create exit ${exit} voids stop evidence despite invalid reports`);
	}
	assert.equal(route("create", null, [], digest), "retry creation");
	assert.equal(route("create", 3, [{ ...proof, code: "occupied" }], digest), "pause occupied");
	for (const exit of [2, 5, 6, 8]) for (const reports of [[], [proof, proof], [{ ...proof, code: "bad" }]]) {
		assert.equal(route("create", exit, reports, digest), exit === 5 ? "pause identity" : "pause unknown");
	}
	assert.equal(route("create", 127, [], digest, false), "pause unknown");
	assert.equal(route("create", null, [], digest, true, false), "pause unknown");
	const workerRoute = (reported: string[], op: string, value: Record<string, unknown>) =>
		reported.length !== 1 || !classes.includes(reported[0]!)
			|| reported[0] === "accept" && !acceptsOperation(op, value, digest) ? "pause unknown" : reported[0];
	for (const bad of [[], ["accept", "pause unknown"], ["invented"]]) assert.equal(workerRoute(bad, "create", proof), "pause unknown");
	assert.equal(workerRoute(["accept"], "create", proof), "accept");
	for (const key of Object.keys(proof)) assert.equal(workerRoute(["accept"], "create", { ...proof, [key]: null }), "pause unknown", key);
	for (const op of ["hash", "compare"]) assert.equal(route(op, 0, [{ operation: op, code: "ok" }]), "pause unknown");
	for (const verb of ["delete", "move", "rename", "truncate", "overwrite"]) {
		const ban = "Never delete, move, rename, truncate or overwrite a creation occupant as repair.";
		assert.ok(common.includes(ban));
		assert.equal(common.replace(ban, ban.replace(verb, "")).includes(ban), false, verb);
	}
	for (const [source, rule] of [
		[common, "Creation uses any available logged/approval source hash as expected."],
		[common, "Log only the agreed full hash and check the entry."],
		[recovery, "A logged interrupted edit stays an edit even when the destination vanishes."],
	]) {
		assert.equal(source!.split(rule!).length, 2);
		assert.equal(source!.replace(rule!, "").includes(rule!), false);
	}
	const preservation = { ...proof, operation: "preserve", retainedVerified: true, protections: {
		exclusiveCreate: "applied", noFollowOpen: "applied", nonblockingOpen: "applied", mode0600: "applied",
	} };
	const occupiedProof = { ...preservation, code: "occupied", stage: "compare", writeState: "not-created" };
	const unequalProof = { ...occupiedProof, equal: false, destinationHash: "0".repeat(64), retainedVerified: false };
	assert.equal(route("preserve", 0, [preservation], digest), "accept");
	assert.equal(workerRoute(["accept"], "preserve", preservation), "accept");
	assert.equal(workerRoute(["accept"], "preserve", { ...preservation, retainedVerified: false }), "pause unknown");
	assert.equal(route("preserve", 3, [occupiedProof], digest, true, true, true), "accept");
	assert.equal(route("preserve", 0, [preservation], digest, true, true, true), "pause unknown", "vanished occupied-only copy is not retention");
	assert.equal(route("preserve", 3, [unequalProof], digest, true, true, false, true), "retry preservation");
	assert.equal(route("preserve", 3, [unequalProof], digest), "pause unknown");
	assert.equal(route("preserve", 0, [{ ...preservation, expected: "not-supplied" }], digest), "pause unknown");
	for (const [i, exit] of exits.entries()) {
		const report = { ...occupiedProof, code: codes[i] };
		assert.equal(route("preserve", exit, [report], digest, true, true, true), exit === 3 ? "accept" : exit === 5 ? "pause identity" : "pause unknown", `occupied-only exit ${exit}`);
	}
	for (const key of Object.keys(preservation)) {
		assert.equal(route("preserve", 0, [{ ...preservation, [key]: null }], digest), "pause unknown", key);
		assert.equal(route("preserve", 3, [{ ...occupiedProof, [key]: null }], digest), "pause unknown", key);
	}
	for (const key of Object.keys(preservation.protections)) {
		const protections: Record<string, string> = { ...preservation.protections };
		delete protections[key];
		assert.equal(route("preserve", 3, [{ ...occupiedProof, protections }], digest), "pause unknown", key);
		assert.equal(route("preserve", 3, [{ ...occupiedProof, protections: { ...preservation.protections, [key]: "invented" } }], digest), "pause unknown", key);
	}
	for (const op of operations) for (const bad of [[], [proof, proof], [{ ...proof, code: "bad" }]]) {
		assert.equal(route(op, 0, bad, digest), op === "create" ? "retry creation" : "pause unknown");
		for (const exit of [2, 5, 6, 8]) assert.equal(route(op, exit, bad, digest), exit === 5 && ["create", "preserve", "hash"].includes(op) ? "pause identity" : "pause unknown");
	}
	const historyRules = [
		"Each allows first attempt + one next-name retry with first recorded identity as expected.",
		"Missing results consume attempts. Requests/sessions reset none. Only occupied proof against the copy's logged identity consumes no fresh-check attempt.",
		"Ordinary preservation uses the eligible hash. First recovery retention omits --expected and logs sourceHash as recovery-only before retry.",
		"Termination requests, tool/command returns, worker claims or missing thread results do not qualify. Only overlapping exclusive creations are exempt until occupied.",
	];
	requireRules(reference, historyRules);
	for (const rule of historyRules) assert.throws(() => requireRules(reference.replace(rule, ""), historyRules));
	type Attempt = { kind: "ordinary" | "recovery"; first?: string; expected?: string; result: boolean; request: string; session: string };
	const history: Attempt[] = [];
	let stopped = true;
	const attempt = (kind: Attempt["kind"], observed: string | undefined, supplied: string | undefined, result = true, request = "first", session = "first") => {
		const prior = history.filter(entry => entry.kind === kind);
		const identity = prior.length ? prior[0]!.first : kind === "ordinary" ? digest : undefined;
		if (prior.length >= 2 || prior.length && !identity || !stopped) return "pause unknown";
		if (identity && observed !== undefined && observed !== identity) { stopped = false; return "pause identity"; }
		if (supplied !== identity) return "pause unknown";
		history.push({ kind, first: observed, expected: supplied, result, request, session });
		return "attempt";
	};
	assert.equal(attempt("ordinary", digest, undefined), "pause unknown", "available expected hash cannot be omitted");
	assert.equal(attempt("ordinary", digest, digest, false), "attempt");
	assert.equal(attempt("ordinary", digest, digest, true, "new", "new"), "attempt", "missing result consumes first allowance");
	assert.equal(attempt("ordinary", digest, digest, true, "third", "third"), "pause unknown", "request/session changes cannot reset exhaustion");
	assert.equal(attempt("recovery", digest, undefined), "attempt", "recovery has its own allowance");
	assert.equal(attempt("recovery", digest, digest), "attempt");
	assert.equal(attempt("recovery", digest, digest, true, "new", "new"), "pause unknown");
	history.length = 0;
	assert.equal(attempt("recovery", undefined, undefined, false), "attempt");
	assert.equal(attempt("recovery", digest, undefined), "pause unknown", "lost first identity forbids retry");
	history.length = 0;
	assert.equal(attempt("recovery", digest, undefined), "attempt");
	assert.equal(attempt("recovery", "0".repeat(64), digest), "pause identity");
	assert.equal(stopped, false, "changed retry identity voids stop evidence");
	const observe = (op: string, exit: number, retryMismatch = false) => {
		if (op === "create" && [4, 7].includes(exit) || op === "preserve" && ([4, 7].includes(exit) || exit === 5 && retryMismatch)) stopped = false;
		return exit === 5 ? "pause identity" : "pause unknown";
	};
	for (const [op, exit, mismatch] of [["create", 4, false], ["create", 7, false], ["preserve", 4, false], ["preserve", 7, false], ["preserve", 5, true]] as const) {
		stopped = true;
		assert.equal(observe(op, exit, mismatch), exit === 5 ? "pause identity" : "pause unknown");
		assert.equal(stopped, false);
	}
	stopped = true;
	observe("preserve", 5);
	assert.equal(stopped, true, "first expected mismatch alone is not a successive observation");
	const stopEvidence = (evidence: string) => evidence === "user-confirmed session and all commands ended";
	for (const evidence of ["termination requested", "tool returned", "worker claim", "missing result", "live writer", "unavailable"]) {
		stopped = stopEvidence(evidence);
		history.length = 0;
		assert.equal(attempt("recovery", digest, undefined), "pause unknown", evidence);
	}
	stopped = stopEvidence("user-confirmed session and all commands ended");
	assert.equal(attempt("recovery", digest, undefined), "attempt");
	const exempt = (exclusive: boolean, occupied: boolean) => exclusive && !occupied;
	assert.equal(exempt(true, false), true);
	assert.equal(exempt(true, true), false);
	assert.equal(exempt(false, false), false);
	type PlanDecision = { id: string; planHash?: string; logged: boolean };
	const decision: PlanDecision = { id: "authorized", planHash: digest, logged: true };
	const planEdit = (stored: boolean, retained: boolean, binding: PlanDecision | undefined, payload = bytes) =>
		stored && retained && binding?.id === decision.id && binding.logged
		&& binding.planHash === hash(payload) && /^[a-f0-9]{64}$/.test(binding.planHash);
	assert.equal(planEdit(true, true, decision), true);
	assert.equal(planEdit(false, true, decision), false);
	assert.equal(planEdit(true, false, decision), false);
	assert.equal(planEdit(true, true, undefined), false);
	for (const binding of [
		{ ...decision, planHash: undefined }, { ...decision, planHash: digest.slice(0, 12) },
		{ ...decision, planHash: hash("decision text") }, { ...decision, planHash: hash("other plan") },
		{ ...decision, id: "another decision" }, { ...decision, logged: false },
	]) assert.equal(planEdit(true, true, binding), false);
	assert.equal(planEdit(true, true, decision, Buffer.from("different payload")), false);
	type Identity = { log: string; path: string; entry: number; kind: string; hash: string };
	const identities: Identity[] = [];
	const select = (log: string, path: string, boundary: number) => identities.filter(identity =>
		identity.log === log && identity.path === path && identity.entry <= boundary
		&& ["verified-write", "successor", "adoption"].includes(identity.kind)).at(-1)?.hash;
	for (const path of ["baseline-map", "source-only-implementation-map", "plan"]) {
		identities.push({ log: "owner", path, entry: 1, kind: "verified-write", hash: "old" },
			{ log: "owner", path, entry: 2, kind: "successor", hash: digest },
			...["recovery-only", "preserved-copy-only", "approval-only"].map((kind, i) => ({ log: "owner", path, entry: 3 + i, kind, hash: "excluded" })),
			{ log: "other", path, entry: 6, kind: "adoption", hash: "other-log" },
			{ log: "owner", path, entry: 8, kind: "adoption", hash: "later" });
		assert.equal(select("owner", path, 0), undefined);
		for (const [entry, before, at] of [[1, undefined, "old"], [2, "old", digest], [8, digest, "later"]] as const) {
			assert.equal(select("owner", path, entry - 1), before);
			assert.equal(select("owner", path, entry), at);
			assert.equal(select("owner", path, entry + 1), entry === 1 ? digest : at);
		}
		assert.equal(select("owner", path, 6), digest);
		assert.notEqual(select("owner", path, 6), "old");
		assert.equal(select("owner", path, 8), "later");
		assert.equal(select("other", path, 6), "other-log");
	}
}

describe("safe record command", { timeout: 60000 }, () => {
	requiredCase(names[0]!, { timeout: 12000 }, async (t, complete) => {
		const { root, source, destination } = fixture(t);
		const mismatch = destination + "-identity";
		expect(await run(operation("create", source, mismatch, "0".repeat(64)), root), 5);
		assert.throws(() => lstatSync(mismatch), /ENOENT/);
		expect(await run(operation("create", source, mismatch, hash(bytes)), root), 0, "verified");
		expect(await run(operation("create", source, mismatch, "0".repeat(64)), root), 5);
		assert.deepEqual(readFileSync(mismatch), bytes);
		const noExpected = expect(await run(operation("create", source, destination + "-plain"), root), 0, "verified");
		assert.equal(noExpected.expected, "not-supplied");
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
		assert.equal(expect(await run(operation("hash", destination, undefined, created.destinationHash!), root), 5).expected, "differs");
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
		const reference = readFileSync(SAFE_RECORD_WRITE_DOC, "utf8");
		const recovery = readFileSync(RECORD_WRITE_RECOVERY_DOC, "utf8");
		const rules = [
			"Absent destination: pause and report for command-creation restoration.",
			"Compare regular non-link leaves only with the intended eligible logged restore copy. Never guess.",
			"Complete bound payload arrival: check/log without overwrite.",
			"Missing map report pauses whole edit recovery, including in-place edits, for the orchestrator decision.",
			"Vanished copy, including fresh-check exit 0: pause. Leave created bytes unchanged.",
		];
		const checkRules = (text: string) => {
			for (const rule of rules) assert.equal(text.split(rule).length, 2, rule);
		};
		checkRules(reference);
		for (const rule of rules) for (const word of rule.match(/\S+/g)!)
			assert.throws(() => checkRules(reference.replace(rule, rule.replace(word, ""))), word);
		assert.ok(recovery.includes("Missing report pauses whole edit recovery for the orchestrator decision, including in-place edits."));
		const restored = join(root, "restored");
		const sourceStat = lstatSync(retained);
		assert.ok(sourceStat.isFile() && !sourceStat.isSymbolicLink());
		expect(await run(operation("hash", retained, undefined, hash(bytes)), root), 0);
		// The orchestrator-selected creation restores only from the verified eligible copy.
		expect(await run(operation("create", retained, restored, hash(bytes)), root), 0, "verified");
		assert.deepEqual(readFileSync(restored), bytes);
		writeFileSync(restored, "occupied changed bytes");
		const beforeOccupied = readFileSync(restored);
		const restoration = expect(await run(operation("create", retained, restored, hash(bytes)), root), 3);
		assert.equal(restoration.equal, false);
		assert.deepEqual(readFileSync(restored), beforeOccupied, "occupied restoration returns to classification without replacement");
		const arrival = join(root, "payload-arrived");
		copyFileSync(source, arrival);
		const beforeArrival = lstatSync(arrival, { bigint: true });
		const agreed = expect(await run(operation("compare", source, arrival), root), 0);
		const logged: string[] = [];
		if (agreed.equal) logged.push(agreed.destinationHash!);
		assert.deepEqual(logged, [hash(bytes)]);
		const afterArrival = lstatSync(arrival, { bigint: true });
		for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const)
			assert.equal(afterArrival[field], beforeArrival[field], "complete payload arrival leaves " + field + " unchanged");
		const recoverMap = (sameAttemptReport: boolean, inPlace: boolean) =>
			!sameAttemptReport ? "pause whole edit recovery for orchestrator decision" : inPlace ? "authorized in-place repair" : "classify";
		for (const inPlace of [false, true])
			assert.equal(recoverMap(false, inPlace), "pause whole edit recovery for orchestrator decision");
		assert.equal(recoverMap(true, true), "authorized in-place repair");
		assert.equal(recoverMap(true, false), "classify");
		const freshCheck = async () => {
			const result = await run(operation("preserve", source, retained, hash(bytes)), root);
			return { result, accepted: result.status === 3 && result.report!.retainedVerified
				&& result.report!.equal && result.report!.expected === "agreed"
				&& result.report!.sourceHash === hash(bytes) && result.report!.destinationHash === hash(bytes) };
		};
		assert.equal((await freshCheck()).accepted, true);
		rmSync(retained);
		const vanished = await freshCheck();
		expect(vanished.result, 0, "verified");
		assert.equal(vanished.accepted, false, "creation after the intended copy vanishes pauses");
		assert.deepEqual(readFileSync(retained), bytes, "leave fresh-check-created bytes unchanged");
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
	requiredCase(names[5]!, { timeout: 20000 }, async (t, complete) => {
		const { root, source } = fixture(t);
		const help = (await run(["--help"], root)).stdout;
		const reference = readFileSync(SAFE_RECORD_WRITE_DOC, "utf8");
		const link = /\[safe-record-write\.mjs\]\(([^)]+)\)/.exec(reference)![1]!;
		assert.equal(fileURLToPath(new URL(link, pathToFileURL(SAFE_RECORD_WRITE_DOC))), SAFE_RECORD_WRITE);
		const common = readFileSync(CHANGE_RECORDS_DOC, "utf8");
		const recovery = readFileSync(RECORD_WRITE_RECOVERY_DOC, "utf8");
		for (const newline of ["\n", "\r\n"]) {
			checkWorkerReference(reference.replace(/\r?\n/g, newline), common.replace(/\r?\n/g, newline), recovery.replace(/\r?\n/g, newline));
			assert.throws(() => checkWorkerReference(reference, common + "\n" + precedenceRule, recovery));
			assert.throws(() => checkWorkerReference(reference, common, recovery.replace("Failed or unclear creation: only common command-result retries.", "")));
		}
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
		const ready = join(root, "abort-ready"), late = join(root, "late-write");
		const abortDestination = join(root, "abort-destination");
		const blocker = preload(root, `const write=fs.writeSync; fs.writeSync=(...a)=>{
		  fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
		  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
		  fs.writeFileSync(${JSON.stringify(late)}, "late"); return write(...a); };`);
		const controller = new AbortController();
		const invocation = createBashTool(root).execute("record-abort", {
			command: [process.execPath, "--require", blocker, SAFE_RECORD_WRITE,
				...operation("create", source, abortDestination, hash(bytes))].map(s => JSON.stringify(s)).join(" "),
		}, controller.signal);
		const outcome = invocation.then(() => false, () => true);
		try {
			const deadline = Date.now() + 3000;
			while (Date.now() < deadline) {
				try { readFileSync(ready); break; } catch {}
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			const pid = Number(readFileSync(ready, "utf8"));
			assert.ok(pid > 0);
			controller.abort();
			assert.equal(await outcome, true);
			const stopped = () => {
				try { process.kill(pid, 0); } catch { return true; }
				if (process.platform === "linux") {
					try { return /^State:\s+Z/m.test(readFileSync("/proc/" + pid + "/status", "utf8")); } catch { return true; }
				}
				return false;
			};
			const stopDeadline = Date.now() + 2000;
			while (!stopped() && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 20));
			assert.ok(stopped(), "aborted command child must be stopped before a retry");
			assert.equal(readFileSync(abortDestination).length, 0);
			assert.throws(() => lstatSync(late), /ENOENT/);
			assert.deepEqual(readFileSync(source), bytes);
			const retry = expect(await run(operation("create", source, abortDestination, hash(bytes)), root), 3);
			assert.notEqual(retry.writeState, "verified");
			assert.equal(readFileSync(abortDestination).length, 0);
		} finally { controller.abort(); await outcome; }
		const relocated = join(root, "installed space", "extension");
		mkdirSync(relocated, { recursive: true });
		copyFileSync(SAFE_RECORD_WRITE, join(relocated, "safe-record-write.mjs"));
		copyFileSync(fileURLToPath(new URL("../extension/paths.ts", import.meta.url)), join(relocated, "paths.ts"));
		mkdirSync(join(root, "installed space", "docs"));
		copyFileSync(SAFE_RECORD_WRITE_DOC, join(root, "installed space", "docs", "safe-record-write.md"));
		const relocatedDoc = join(root, "installed space", "docs", "safe-record-write.md");
		const relocatedLink = /\[safe-record-write\.mjs\]\(([^)]+)\)/.exec(readFileSync(relocatedDoc, "utf8"))![1]!;
		const commandRelative = /COMMAND is (\S+), relative to this document\./.exec(readFileSync(relocatedDoc, "utf8"))![1]!;
		assert.equal(commandRelative, relocatedLink);
		const expectedLink = fileURLToPath(new URL(relocatedLink, pathToFileURL(relocatedDoc)));
		assert.equal(expectedLink, join(relocated, "safe-record-write.mjs"));
		const resolver = join(root, "resolve.mjs");
		writeFileSync(resolver, `import { SAFE_RECORD_WRITE } from './installed space/extension/paths.ts'; console.log(SAFE_RECORD_WRITE);`);
		const resolved = await subprocess(process.execPath, [resolver], root);
		assert.equal(resolved.status, 0);
		assert.equal(resolved.stdout.trim(), expectedLink);
		const declaration = readFileSync(SAFE_RECORD_WRITE, "utf8").match(/const exits = \{([^}]+)\}/)![1]!;
		const exitKeys = [...declaration.matchAll(/['"]?([\w-]+)['"]?: (\d+)/g)].map(m => [m[1], Number(m[2])]);
		const operationList = readFileSync(SAFE_RECORD_WRITE, "utf8").match(/!\[([^\]]+)\]\.includes\(operation\)/)![1]!;
		assert.deepEqual([...operationList.matchAll(/'([^']+)'/g)].map(m => m[1]), ["create", "preserve", "compare", "hash"]);
		assert.deepEqual(exitKeys, [["ok", 0], ["usage", 2], ["occupied", 3], ["different", 4], ["identity", 5], ["io", 6], ["changed", 7], ["unsafe-file", 8]]);
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
