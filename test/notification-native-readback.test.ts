import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { dirname } from "node:path";
import { notificationText } from "../extension/notification-protocols.ts";

const service = `
import asyncio, json, sys
from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, method
records = []
class Notifications(ServiceInterface):
    def __init__(self):
        super().__init__('org.freedesktop.Notifications')
    @method()
    def GetCapabilities(self) -> 'as':
        return ['body', 'body-markup']
    @method()
    def GetServerInformation(self) -> 'ssss':
        return ['Slate test', 'test', '1', '1.2']
    @method()
    def Notify(self, app: 's', replacement: 'u', icon: 's', title: 's', body: 's', actions: 'as', hints: 'a{sv}', expiry: 'i') -> 'u':
        records.append({'title': title, 'body': body})
        return len(records)
async def main():
    bus = await MessageBus().connect()
    bus.export('/org/freedesktop/Notifications', Notifications())
    await bus.request_name('org.freedesktop.Notifications')
    child = await asyncio.create_subprocess_exec(sys.argv[1], '--input-type=module', '-e', sys.argv[2], stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        stdout, stderr = await asyncio.wait_for(child.communicate(), 15)
        if child.returncode != 0:
            raise RuntimeError(stderr.decode())
        print(json.dumps(records))
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
        bus.disconnect()
asyncio.run(main())
`;

test("real notify-send preserves literal backslashes at the D-Bus service", { timeout: 20000 }, (t) => {
	if (process.platform !== "linux") { t.skip("Linux notify-send read-back requires Linux"); return; }
	const unavailable = (message: string) => {
		if (/^(true|1|yes|on)$/i.test(process.env.CI?.trim() ?? "")) assert.fail(`${message} in CI`);
		t.skip(message);
	};
	const tools: Record<string, string> = {};
	for (const tool of ["dbus-run-session", "dbus-daemon", "notify-send", "python3"]) {
		const result = childProcess.spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8", timeout: 2000 });
		if (result.status !== 0) { unavailable(`native read-back requires ${tool}`); return; }
		tools[tool] = result.stdout.trim();
	}
	const python = childProcess.spawnSync(tools.python3!, ["-c", "import dbus_next"], { encoding: "utf8", timeout: 2000 });
	if (python.status !== 0) { unavailable("native read-back requires the Python dbus_next module"); return; }
	const texts = [String.raw`C:\new\file`, String.raw`\074b\076`, String.raw`before\033after`, String.raw`before\000after`, String.raw`before\377after`].map((body) => ({ title: String.raw`summary\074b\076`, body }));
	texts.push(notificationText("input-needed", "project", String.raw`/folder\033name`, ""));
	const source = `
		import { createNativeNotificationChannel } from ${JSON.stringify(new URL("../extension/notification-native.ts", import.meta.url).href)};
		const keep = setInterval(() => {}, 10000);
		try {
			const channel = createNativeNotificationChannel({mode:'tui', projectDirectory:process.cwd(), platform:'linux', environment:{PATH:${JSON.stringify(dirname(tools["notify-send"]!))}, DISPLAY:':1', DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}});
			for (const text of ${JSON.stringify(texts)}) await (await channel.prepare(text, new AbortController().signal))();
		} finally { clearInterval(keep); }
	`;
	const result = childProcess.spawnSync(tools["dbus-run-session"]!, ["--", tools.python3!, "-c", service, process.execPath, source], { encoding: "utf8", timeout: 18000 });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), texts.map(({ title, body }) => ({ title, body })),  "the real notification service receives literal text, not decoded markup or controls");
});
