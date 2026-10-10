import { readFileSync, writeFileSync } from "node:fs";
import { createTerminalNotificationChannels } from "../../extension/notification-terminal.ts";
import { notificationText, type NotificationText } from "../../extension/notification-protocols.ts";
import { resolveNotificationSettings, type NotificationProtocol } from "../../extension/notification-config.ts";

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
	protocol: NotificationProtocol; screen: boolean; headless: boolean; generic: boolean;
	nonce: string; title: string; body: string;
};
// This guard belongs to the fixture. Production terminal writes have no separate deadline.
writeFileSync(`${process.argv[2]!}.pid`, String(process.pid));
const guard = setTimeout(() => process.kill(process.pid, "SIGKILL"), 12000);
const write = (value: string) => new Promise<void>((resolve, reject) => {
	process.stdout.write(value, (error) => error ? reject(error) : resolve());
});
const command = () => new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
try {
	if (!config.headless) {
		if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("SSH fixture requires a remote terminal");
		process.stdin.setRawMode(true);
		process.stdin.resume();
		const start = command();
		await write(`READY-${config.nonce}`);
		await start;
	} else if (process.stdout.isTTY) throw new Error("headless SSH unexpectedly allocated a terminal");
	const text: NotificationText = config.generic
		? notificationText("input-needed", resolveNotificationSettings(undefined, undefined, () => {}).detail, `/private/${config.nonce}`, config.body)
		: { title: config.title, body: config.body };
	const channels = createTerminalNotificationChannels({
		mode: "tui", settings: { sequences: [config.protocol] },
		environment: config.screen ? { STY: "test-screen-envelope" } : {},
		warn(message) { throw new Error(message); },
	});
	for (const channel of channels) await (await channel.prepare(text, new AbortController().signal))();
	if (!config.headless) {
		const finish = command();
		await write(`DONE-${config.nonce}`);
		await finish;
	}
} finally {
	clearTimeout(guard);
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	process.stdin.pause();
}
