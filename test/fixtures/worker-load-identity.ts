import { writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openWorkerSession, type WorkerSession } from "../../extension/worker.ts";

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("worker identity operation timed out")), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("load-probe", {
    api: "load-probe-api", apiKey: "fake", baseUrl: "http://127.0.0.1:9",
    models: [{ id: "worker", name: "worker", reasoning: false, input: ["text"],
      contextWindow: 100000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const done = context.messages.some(m => m.role === "toolResult");
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: done ? [{ type: "text", text: "done" }] : [
          { type: "toolCall", id: "identity-call", name: "codemode", arguments: { code: 'text("identity-ok")' } }],
        stopReason: done ? "stop" : "toolUse", timestamp: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: done ? "stop" : "toolUse", message });
      stream.end();
      return stream;
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    const sessions: WorkerSession[] = [];
    const warnings: string[] = [];
    const results: unknown[] = [];
    try {
      const workerCtx = { ...ctx, model: ctx.modelRegistry.find("load-probe", "worker") };
      const opened = await within(Promise.all(Array.from({ length: 3 }, async () => {
        try {
          const session = await within(openWorkerSession({ ctx: workerCtx, tools: ["read"],
            report: message => warnings.push(message),
            onCreated: session => { sessions.push(session); } }));
          return { session };
        } catch (error) { return { error: String(error) }; }
      })));
      for (const opening of opened) {
        if (!opening.session) { results.push(opening); continue; }
        const session = opening.session;
        const path = session.getAllTools().find(tool => tool.name === "codemode")?.sourceInfo?.path;
        const active = session.getActiveToolNames().includes("codemode");
        const hook = await within(session.extensionRunner!.emitToolCall({
          type: "tool_call", toolName: "codemode", toolCallId: "identity-check",
          input: { code: 'text("identity-ok")' },
        }));
        await within(session.prompt("execute identity probe"));
        results.push({ path, active, hook, messages: session.messages.filter(m => m.role === "toolResult") });
      }
    } catch (error) { results.push({ error: String(error) }); }
    finally {
      const cleanup = await Promise.allSettled(sessions.map(session => within(session.shutdownWorker())));
      writeFileSync(process.env.SLATE_IDENTITY_RESULT!, JSON.stringify({ results, warnings,
        cleanup: cleanup.map(result => result.status) }));
    }
  });
}
