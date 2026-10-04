import { writeFileSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type TranscriptContext, type Model, type ToolCall } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const evidence: Array<{ kind: string; tools: string[]; messages: unknown[] }> = [];
let failFactory = false;
const originalExtensions = DefaultResourceLoader.prototype.getExtensions;
DefaultResourceLoader.prototype.getExtensions = function () {
  const loaded = originalExtensions.call(this);
  return failFactory ? { ...loaded, extensions: loaded.extensions.filter((extension) => extension.path !== "<inline:slate-worker-record>") } : loaded;
};
function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}
function stream(model: Model<any>, context: TranscriptContext) {
  const tools = getCurrentTools(context.messages).map((tool) => tool.name);
  const texts = context.messages.map((message) => text(message.content));
  const compressor = texts.some((value) => value.includes("You are compressing one completed action"));
  const kind = compressor ? "compressor" : tools.includes("thread") ? "host" : texts.some((value) => value.includes("RECORD_WORKER_A")) ? "A" : "B";
  const ordinal = evidence.filter((call) => call.kind === kind).length;
  evidence.push({ kind, tools, messages: context.messages.map((message) => ({ ...message, content: text(message.content) })) });
  writeFileSync(process.env.SLATE_RECORD_EVIDENCE!, JSON.stringify(evidence));
  const call = (id: string, name: string, args: ToolCall["arguments"]) => ({ type: "toolCall" as const, id, name, arguments: args });
  let content: AssistantMessage["content"];
  if (kind === "host" && ordinal === 0) content = [call("start", "slate_change", { action: "start" })];
  else if (kind === "host" && ordinal === 1) content = [
    call("thread-A", "thread", { type: "implementer", trackNumber: "2.4", task: "RECORD_WORKER_A", model: "fixture", reason: "record worker integration" }),
    call("thread-B", "thread", { type: "general", records: ["status.md"], task: "RECORD_WORKER_B", model: "fixture", reason: "independent assignment" }),
  ];
  else if (kind === "host" && ordinal === 2) { failFactory = true; content = [call("missing-factory", "thread", { type: "researcher", task: "RECORD_FACTORY_FAILURE", model: "fixture", reason: "visible internal failure" })]; }
  else if (kind === "host") content = [{ type: "text", text: "RECORD_WORKER_HOST_DONE" }];
  else if (kind === "compressor") content = [{ type: "text", text: "## Intent\nOffline integration.\n## Key Findings\nCompleted.\n## Open Issues\nNone." }];
  else {
    const record = kind === "A" ? "track-2.4-implementer-report.md" : "status.md";
    const other = kind === "A" ? "status.md" : "track-2.4-implementer-report.md";
    const folder = process.env.SLATE_RECORD_PROJECT! + "/slate-changes/";
    // Dispatch guidance supplies the current folder, never record payload text.
    const system = texts.join("\n");
    const current = /slate-changes\/(change-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{32})\//.exec(system)?.[1];
    const payload = kind === "A" ? "REPORT_A" : "STATUS_B";
    if (ordinal === 0 && kind === "A") symlinkSync(`${folder}${current}/missing-record.md`, process.env.SLATE_RECORD_PROJECT! + "/dangling-record");
    if (ordinal === 0) content = [...(kind === "A" ? [call("guard-unresolved", "write", { path: "dangling-record", content: "FORBIDDEN" }),
      call("invalid-A", "slate_record", { record, mode: "bogus", payload: "PRIVATE_INVALID_PAYLOAD" })] : []), call(`guard-${kind}`, "write", { path: `${folder}${current ?? "missing"}/${record}`, content: "FORBIDDEN" }),
      call(`create-${kind}`, "slate_record", { record, mode: "create", payload }),
      call(`wrong-${kind}`, "slate_record", { record: other, mode: "create", payload: "FORBIDDEN" })];
    else if (kind === "A" && ordinal === 1) {
      const expectedHash = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
      content = [call("append-one", "slate_record", { record, mode: "append", payload: "+ONE", expectedHash }), call("append-two", "slate_record", { record, mode: "append", payload: "+TWO", expectedHash })];
    } else content = [{ type: "text", text: `RECORD_WORKER_${kind}_DONE` }];
  }
  const toolUse = content.some((part) => part.type === "toolCall");
  const output: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
    stopReason: toolUse ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => { events.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message: output }); events.end(); });
  return events;
}
const originalCreate = ModelRuntime.create;
ModelRuntime.create = async function (...args) { const runtime = await originalCreate.apply(ModelRuntime, args); runtime.registerProvider("record-fake", { api: "record-test-api", streamSimple: stream }); return runtime; };
export default function (pi: ExtensionAPI) {
  pi.registerProvider("record-fake", { api: "record-test-api", streamSimple: stream });
  pi.on("session_shutdown", () => { ModelRuntime.create = originalCreate; DefaultResourceLoader.prototype.getExtensions = originalExtensions; });
}
