import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { WriteStream } from "node:tty";
import { createTerminalNotificationChannels } from "../../extension/notification-terminal.ts";
import { queryTmuxClients, TMUX_CLIENT_FORMAT } from "../../extension/notification-tmux.ts";
import type { NotificationProtocol } from "../../extension/notification-config.ts";

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
	tty: string; tmux: string; socket: string; pane: string; failure: boolean;
	bell: boolean; protocols?: NotificationProtocol[]; nonce: string; unexpectedCSI: boolean; delayDelivery: boolean;
};
const guard = setTimeout(() => process.kill(process.pid, "SIGKILL"), 8000);
const stream = new WriteStream(openSync(config.tty, "w"));
const writes: string[] = [];
const environment = {
	TMUX: `${config.failure ? `${config.socket}.missing` : config.socket},1,0`,
	TMUX_PANE: config.pane, PATH: process.env.PATH, TERM_PROGRAM: "iTerm.app",
};
try {
	assert.equal(stream.isTTY, true, "delivery requires the real pane terminal device");
	const signal = new AbortController().signal;
	const start = performance.now();
	let clients: readonly string[] = [], rows = "";
	if (!config.failure) {
		clients = await queryTmuxClients(environment, signal);
		rows = execFileSync(config.tmux, ["-S", config.socket, "list-clients", "-t", config.pane, "-F", TMUX_CLIENT_FORMAT], { encoding: "utf8", timeout: 2000 });
	} else {
		await assert.rejects(queryTmuxClients(environment, signal), /query failed/);
	}
	const queryMs = performance.now() - start;
	const channels = createTerminalNotificationChannels({
		mode: "tui", settings: { sequences: config.protocols ?? "auto" }, environment,
		output: {
			isTTY: stream.isTTY, on: stream.on.bind(stream), removeListener: stream.removeListener.bind(stream),
			write: ((buffer: Buffer, callback: (error?: Error | null) => void) => {
				writes.push(buffer.toString("hex"));
				// The negative control inserts a request into the real passthrough payload.
				const forwarded = config.unexpectedCSI ? Buffer.concat([
					buffer.subarray(0, -2), Buffer.from("\x1b\x1b[8;1;1t"), buffer.subarray(-2),
				]) : buffer;
				return stream.write(forwarded, callback);
			}) as typeof stream.write,
		},
		warn(message) { throw new Error(message); },
	});
	const channel = channels.find((value) => value.name === (config.bell ? "bell" : "terminal"))!;
	const prepareStart = performance.now();
	const deliver = await channel.prepare({ title: `T-${config.nonce}`, body: `B-${config.nonce}` }, signal);
	const prepareMs = performance.now() - prepareStart;
	const delayStart = performance.now();
	if (config.delayDelivery) await new Promise((resolve) => setTimeout(resolve, 810));
	const deliveryDelayMs = performance.now() - delayStart;
	await deliver();
	await new Promise<void>((resolve) => stream.end(resolve));
	process.stdout.write(JSON.stringify({ clients, rows, writes, query_ms: queryMs, prepare_ms: prepareMs, delivery_delay_ms: deliveryDelayMs }));
} finally {
	clearTimeout(guard);
	stream.destroy();
}
