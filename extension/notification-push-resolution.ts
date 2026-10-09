import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { getDefaultResultOrder, type LookupAddress } from "node:dns";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { isIP, type Socket } from "node:net";
import type { RequestOptions } from "node:http";

type PushAddressOrder = "ipv4first" | "ipv6first" | "verbatim";
export interface PushResolverRuntime {
	readonly releaseName: string;
	readonly bun: boolean;
	readonly sea: boolean;
}

/** A plain Node CLI supports the child resolver, including Pi's Node shebang launcher. */
export function pushResolverRuntime(): PushResolverRuntime {
	let sea = "sea" in process.features && process.features.sea === true;
	try {
		sea ||= process.getBuiltinModule?.("node:sea")?.isSea() === true;
	} catch {}
	return {
		releaseName: process.release?.name ?? "",
		bun: !!process.versions.bun, sea,
	};
}

export function canSpawnPushResolver(runtime: PushResolverRuntime): boolean {
	return runtime.releaseName === "node" && !runtime.bun && !runtime.sea;
}

// System lookup preserves hosts-file entries. Its worker threads belong only to this child.
export const PUSH_RESOLVER_SCRIPT = `
const dns = require('node:dns');
const timer = setTimeout(() => process.kill(process.pid, 'SIGKILL'), Number(process.argv[2]));
const order = process.argv[3];
if (!['ipv4first', 'ipv6first', 'verbatim'].includes(order)) process.exit(1);
// Node lib/net.js uses ADDRCONFIG for an unspecified family on non-Windows platforms.
dns.lookup(process.argv[1], { all: true, order, hints: process.platform === 'win32' ? 0 : dns.ADDRCONFIG }, (error, addresses) => {
  if (error) process.exit(1);
  else process.stdout.write(JSON.stringify(addresses), () => process.exit(0));
});
`;
// Silence worker output before loading resolver code, including on Bun without stdio isolation.
const PUSH_DNS_WORKER_SILENCE = `
process.stdout.write = process.stderr.write = () => true;
process.emitWarning = () => {};
process.removeAllListeners('warning');
`;
// Each DNS query uses the worker's event loop, not the host's shared system lookup pool.
export const PUSH_DNS_WORKER_SCRIPT = `
const { Resolver } = require('node:dns');
const { parentPort, workerData } = require('node:worker_threads');
const { host, timeoutMs, servers } = workerData;
const resolver = new Resolver({ timeout: Math.max(1, timeoutMs), tries: 1 });
if (servers) resolver.setServers(servers);
const answers = [[], []];
let pending = 2;
for (const [index, family] of [4, 6].entries()) {
  const callback = (error, addresses) => {
    if (!error) answers[index] = addresses.map(address => ({ address, family }));
    if (--pending === 0) { parentPort.postMessage(answers.flat()); parentPort.close(); }
  };
  if (family === 4) resolver.resolve4(host, callback);
  else resolver.resolve6(host, callback);
}
`;
export interface PushResolverOptions {
	readonly script?: string;
	readonly start?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
	/** Supply runtime evidence, worker code or private DNS servers in tests. */
	readonly runtime?: PushResolverRuntime;
	readonly dnsServers?: readonly string[];
	readonly workerScript?: string;
	readonly startWorker?: (script: string, options: WorkerOptions) => Worker;
}

function effectiveOrder(): PushAddressOrder {
	const order = getDefaultResultOrder();
	return order === "ipv4first" || order === "ipv6first" ? order : "verbatim";
}

function orderAddresses(addresses: LookupAddress[], order: PushAddressOrder): LookupAddress[] {
	if (order !== "verbatim") addresses.sort((a, b) => order === "ipv4first" ? a.family - b.family : b.family - a.family);
	return addresses;
}

/** Unreferenced inline workers isolate DNS handles. Settlement waits for worker exit. */
function resolvePushDns(host: string, signal: AbortSignal, timeoutMs: number, order: PushAddressOrder, options: PushResolverOptions): Promise<unknown> {
	if (signal.aborted) return Promise.resolve(undefined);
	// RFC 6761 reserves localhost and all names below it for loopback without DNS queries.
	if (/(?:^|\.)localhost\.?$/i.test(host)) {
		return Promise.resolve(orderAddresses([{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }], order));
	}
	return new Promise((done) => {
		let worker: Worker | undefined, stopped = false, settled = false, terminating = false;
		let answers: LookupAddress[] | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
			done(stopped || !answers ? undefined : orderAddresses(answers, order));
		};
		const stop = () => {
			stopped = true;
			if (!worker || terminating || settled) return;
			terminating = true;
			try { void worker.terminate().catch(() => {}); } catch {}
			// Node terminate() refs the worker. Cleanup must not hold the host open.
			worker.unref();
		};
		const timer = setTimeout(stop, timeoutMs);
		timer.unref();
		signal.addEventListener("abort", stop, { once: true });
		try {
			worker = (options.startWorker ?? ((script, config) => new Worker(script, config)))(PUSH_DNS_WORKER_SILENCE + (options.workerScript ?? PUSH_DNS_WORKER_SCRIPT), {
				eval: true, execArgv: [], env: {},
				...(!process.versions.bun ? { stdout: true, stderr: true } : {}),
				workerData: { host, timeoutMs, servers: options.dnsServers },
			});
			worker.on("error", stop);
			worker.on("messageerror", stop);
			worker.once("message", (data: unknown) => {
				if (stopped || settled) return;
				if (!Array.isArray(data) || data.length > 1024) { stop(); return; }
				const validated = data.map((item) => selectPushAddress([item], false));
				if (validated.some((item) => !item)) { stop(); return; }
				answers = validated as LookupAddress[];
			});
			worker.once("exit", (code) => { if (code !== 0) stopped = true; finish(); });
			worker.unref();
			if (signal.aborted || stopped) stop();
		} catch { stop(); if (!worker) finish(); }
	});
}

/** Resolve outside the host worker pool. Child settlement waits for child and pipe close. */
export function resolvePushAddresses(host: string, signal: AbortSignal, timeoutMs: number, options: PushResolverOptions = {}): Promise<unknown> {
	const order = effectiveOrder();
	if (!canSpawnPushResolver(options.runtime ?? pushResolverRuntime())) return resolvePushDns(host, signal, timeoutMs, order, options);
	return new Promise((done) => {
		if (signal.aborted) { done(undefined); return; }
		let child: ChildProcess | undefined, output = "", stopped = false, terminating = false, settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
			let addresses: unknown;
			if (!stopped) { try { addresses = JSON.parse(output); } catch {} }
			done(addresses);
		};
		const stop = () => {
			stopped = true;
			if (!child || terminating || settled) return;
			terminating = true;
			// The child's own SIGKILL deadline bounds a refused parent kill. Keep the slot until close.
			try { child.kill("SIGKILL"); } catch {}
		};
		const timer = setTimeout(stop, timeoutMs);
		timer.unref();
		signal.addEventListener("abort", stop, { once: true });
		try {
			// No credentials or Node startup options cross this boundary.
			const env: NodeJS.ProcessEnv = {};
			const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
			if (systemRoot !== undefined) env.SystemRoot = systemRoot;
			child = (options.start ?? spawn)(process.execPath,
				["--input-type=commonjs", "-e", options.script ?? PUSH_RESOLVER_SCRIPT, "--", host, String(timeoutMs), order],
				{ env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
			child.on("error", stop);
			child.once("close", (code) => { if (code !== 0) stopped = true; finish(); });
			child.stdout?.on("error", stop);
			child.stdout?.on("data", (chunk: Buffer) => {
				if (Buffer.byteLength(output) + chunk.length > 65536) stop();
				else output += chunk.toString("utf8");
			});
			child.unref();
			(child.stdout as Socket | null)?.unref();
			if (signal.aborted || stopped) stop();
		} catch { stop(); if (!child) finish(); }
	});
}

/** Check canonical IP forms, including IPv4-mapped IPv6 addresses. Return false for scoped addresses. */
export function isPushLoopback(address: string): boolean {
	if (address.includes("%")) return false;
	if (isIP(address) === 4) return address.startsWith("127.");
	if (isIP(address) !== 6) return false;
	try {
		const canonical = new URL(`http://[${address}]/`).hostname;
		return canonical === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical);
	} catch { return false; }
}

/** Pick one validated address. Never give Node an alternate connection candidate. */
export function selectPushAddress(addresses: unknown, loopbackOnly: boolean): LookupAddress | undefined {
	if (!Array.isArray(addresses)) return undefined;
	for (const item of addresses) {
		if (item === null || typeof item !== "object") continue;
		const { address, family } = item as Record<string, unknown>;
		if (typeof address === "string" && !address.includes("%") && (family === 4 || family === 6) && isIP(address) === family
			&& (!loopbackOnly || isPushLoopback(address))) return { address, family };
	}
	return undefined;
}

/** Supply both Node lookup callback shapes without another system lookup. */
export function pinnedPushLookup(address: LookupAddress): NonNullable<RequestOptions["lookup"]> {
	return (_host, options, callback) => {
		if (typeof options === "object" && options.all) callback(null, [address]);
		else callback(null, address.address, address.family);
	};
}
