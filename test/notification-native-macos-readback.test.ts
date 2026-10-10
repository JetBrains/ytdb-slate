import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createNativeNotificationChannel } from "../extension/notification-native.ts";
import { requiredCase } from "./required-case.ts";

const caseName = "macOS native notification retains exact unique text in a new operating system store record";
const pollLimitMs = 30000;
const outputLimitBytes = 1024 * 1024;
const bounded = (value: unknown) => String(value).slice(0, 2000);

// Other platforms register no native case. The required roster selects darwin only.
if (process.platform === "darwin") requiredCase(caseName, { timeout: 60000 }, async (t, complete) => {
	const tried: string[] = [], childErrors: string[] = [];
	let store = "not selected", schema = "not read", highest = "not read", polls = 0;
	function command(executable: string, args: string[], input?: Buffer, timeout = 2000) {
		const result = spawnSync(executable, args, {
			input, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: outputLimitBytes,
			shell: false, stdio: ["pipe", "pipe", "pipe"],
		});
		if (result.error || result.status !== 0) {
			const message = `${executable}: status=${result.status} signal=${result.signal} error=${bounded(result.error ?? "none")} stderr=${bounded(result.stderr)}`;
			childErrors.push(message);
			throw new Error(message);
		}
		return result.stdout;
	}
	function query(sql: string, timeout = 2000): Record<string, unknown>[] {
		// Each child opens a fresh read-only connection. Normal reads include write-ahead log data.
		const output = command("/usr/bin/sqlite3", ["-readonly", "-json", "-cmd", ".timeout 1000", store, sql], undefined, timeout);
		const rows: unknown = JSON.parse(output || "[]");
		assert.ok(Array.isArray(rows), "the notification store query must return rows");
		assert.ok(rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row)), "store rows must be objects");
		return rows;
	}
	async function exists(path: string) {
		tried.push(path);
		try {
			assert.ok((await stat(path)).isFile(), `notification store is not a regular file: ${path}`);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw new Error(`cannot inspect notification store ${path}: ${bounded(error)}`, { cause: error });
		}
	}
	try {
		const home = process.env.HOME;
		assert.ok(home && isAbsolute(home), "macOS native read-back requires an absolute HOME");
		for (const executable of ["/usr/bin/osascript", "/usr/bin/sqlite3", "/usr/bin/plutil"]) {
			await access(executable, constants.X_OK).catch((error: unknown) => {
				throw new Error(`macOS native read-back requires ${executable}: ${bounded(error)}`, { cause: error });
			});
		}
		const modern = join(home, "Library/Group Containers/group.com.apple.usernoted/db2/db");
		if (await exists(modern)) store = modern;
		else {
			const userDirectory = command("/usr/bin/getconf", ["DARWIN_USER_DIR"]).trim();
			assert.ok(isAbsolute(userDirectory), "getconf must return an absolute DARWIN_USER_DIR");
			const legacy = join(userDirectory, "com.apple.notificationcenter/db2/db");
			assert.ok(await exists(legacy), `no macOS notification store exists at either tried path: ${tried.join(", ")}`);
			store = legacy;
		}
		const recordColumns = query("PRAGMA table_info(record);"), appColumns = query("PRAGMA table_info(app);");
		schema = JSON.stringify({ record: recordColumns.map(({ name, type }) => ({ name, type })),
			app: appColumns.map(({ name, type }) => ({ name, type })) });
		for (const [table, columns, required] of [
			["record", recordColumns, ["rec_id", "app_id", "data"]],
			["app", appColumns, ["app_id", "identifier"]],
		] as const) for (const name of required) {
			assert.ok(columns.some((column) => column.name === name), `notification store schema mismatch: ${table}.${name} is missing`);
		}
		const titleMarker = randomUUID(), bodyMarker = randomUUID();
		const text = { title: `Slate ${titleMarker} "quoted" \\ <&> café`,
			body: `Read-back ${bodyMarker} "body" \\ <&> café` };
		// Binary plists can encode string markers as ASCII or UTF-16 big-endian.
		const markerHex = [titleMarker, bodyMarker].flatMap((marker) => [
			Buffer.from(marker, "ascii").toString("hex"), Buffer.from(marker, "utf16le").swap16().toString("hex"),
		]);
		const containsMarker = markerHex.map((hex) => `instr(hex(record.data), '${hex.toUpperCase()}') > 0`).join(" OR ");
		const baseline = query(`SELECT COALESCE(MAX(rec_id), 0) AS highest, COUNT(CASE WHEN ${containsMarker} THEN 1 END) AS matches FROM record;`);
		assert.equal(baseline.length, 1, "the baseline query must return exactly one aggregate row");
		assert.equal(baseline[0]!.matches, 0, "both unique text markers must be absent before sending");
		const maximum = baseline[0]!.highest;
		assert.ok(typeof maximum === "number" && Number.isSafeInteger(maximum) && maximum >= 0, "the highest record id must be a safe nonnegative integer");
		highest = String(maximum);
		const controller = new AbortController();
		// The product does not keep its delivery child referenced. The case owns this timer.
		const keepAlive = setInterval(() => {}, 1000);
		t.after(() => { clearInterval(keepAlive); controller.abort(); });
		const channel = createNativeNotificationChannel({ mode: "tui", projectDirectory: process.cwd(), environment: { HOME: home } });
		const send = await channel.prepare(text, controller.signal);
		await send();
		const deadline = performance.now() + pollLimitMs;
		const remaining = () => {
			const milliseconds = Math.floor(deadline - performance.now());
			assert.ok(milliseconds > 0, `native notification read-back exceeded ${pollLimitMs} ms`);
			return Math.min(2000, milliseconds);
		};
		let found: { id: number; identifier: string } | undefined;
		while (performance.now() < deadline && !found) {
			polls++;
			const rows = query(`SELECT record.rec_id AS id, app.identifier AS identifier, hex(record.data) AS data FROM record LEFT JOIN app ON record.app_id = app.app_id WHERE record.rec_id > ${maximum} AND (${containsMarker}) ORDER BY record.rec_id;`, remaining());
			for (const row of rows) {
				assert.ok(typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id > maximum, "read-back must use a new record id");
				assert.ok(typeof row.data === "string" && row.data.length > 0 && row.data.length % 2 === 0 && /^[0-9A-F]+$/.test(row.data), "the candidate record must contain a hexadecimal plist");
				const plist = Buffer.from(row.data, "hex");
				const decode = (key: string) => command("/usr/bin/plutil", ["-extract", key, "raw", "-expect", "string", "-n", "-o", "-", "-"], plist, remaining());
				const title = decode("req.titl"), body = decode("req.body");
				assert.equal(title, text.title, "the new notification record must retain the exact title");
				assert.equal(body, text.body, "the new notification record must retain the exact body");
				assert.ok(typeof row.identifier === "string" && row.identifier.length > 0, "the new notification record must have an app.identifier");
				found = { id: row.id, identifier: row.identifier };
				break;
			}
			if (!found) await delay(Math.min(500, Math.max(0, deadline - performance.now())));
		}
		assert.ok(found, `no new notification record retained the exact title and body within ${pollLimitMs} ms`);
		t.diagnostic(`macOS native store read-back: record=${found.id} app.identifier=${JSON.stringify(found.identifier)} store=${store} polls=${polls}`);
		complete();
	} catch (error) {
		const diagnostic = (executable: string, args: string[]) => {
			try { return bounded(command(executable, args)); }
			catch (failure) { return bounded(failure); }
		};
		t.diagnostic(`macOS native read-back failure: ${bounded(error)}`);
		t.diagnostic(`sw_vers: ${diagnostic("/usr/bin/sw_vers", [])}`);
		t.diagnostic(`arch: ${diagnostic("/usr/bin/arch", [])}`);
		t.diagnostic(bounded(`store=${store} tried=${JSON.stringify(tried)} highest=${highest} polls=${polls}`));
		t.diagnostic(`schema: ${bounded(schema)}`);
		t.diagnostic(`child errors: ${bounded(childErrors.join("\n"))}`);
		throw error;
	}
});
