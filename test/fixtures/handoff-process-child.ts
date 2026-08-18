import { existsSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BaseModelTracker } from "../../extension/base-model.ts";
import { registerSlateHandoff } from "../../extension/handoff.ts";
import { SlateStore } from "../../extension/state.ts";

const [, , mode, cwd, resultFile, readyFile, goFile, sessionId] = process.argv;
if (!mode || !cwd || !resultFile || !readyFile || !goFile || !sessionId) {
  throw new Error("usage: handoff-process-child <race|hold> <cwd> <result> <ready> <go> <session-id>");
}

const appended: Array<Record<string, unknown>> = [];
const store = new SlateStore({
  appendEntry(_type: string, data: Record<string, unknown>) {
    appended.push(data);
    if (mode === "hold") {
      writeFileSync(readyFile, "claimed");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
} as unknown as ExtensionAPI);

let handler: ((event: unknown, ctx: ExtensionContext) => Promise<unknown>) | undefined;
const pi = {
  on(event: string, candidate: typeof handler) {
    if (event === "session_start" && handler === undefined) handler = candidate;
  },
  sendMessage() {},
} as unknown as ExtensionAPI;
registerSlateHandoff(pi, store, () => ({}), () => ({} as BaseModelTracker));
if (!handler) throw new Error("session_start handler was not registered");

if (mode === "race") {
  writeFileSync(readyFile, "ready");
  while (!existsSync(goFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

const sessionFile = `${resultFile}.jsonl`;
const ctx = {
  cwd,
  hasUI: false,
  model: undefined,
  isProjectTrusted: () => true,
  sessionManager: {
    getHeader: () => ({ parentSession: "/tmp/parent.jsonl" }),
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
  },
} as unknown as ExtensionContext;

await handler({}, ctx);
writeFileSync(resultFile, JSON.stringify({
  adoptions: appended.length,
  slateSessionId: store.slateSessionId,
  ownerSessionDigest: store.ownerSessionDigest,
}));
