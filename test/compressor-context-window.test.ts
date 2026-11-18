import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compressEpisode } from "../extension/episodes.ts";
import { createLogicalRuntime } from "../extension/logical-model-runtime.ts";

test("compression window reaches the real Pi Responses request without changing the registry", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "slate-compressor-window-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const payloads: Array<{ model: string; max_output_tokens: number }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    payloads.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: ' + JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg", role: "assistant", content: [] } }) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Compressed result." }) + '\n\n');
    res.end('data: ' + JSON.stringify({ type: "response.completed", response: {
      id: "fixture-response", status: "completed", output: [{ type: "message", role: "assistant",
        content: [{ type: "output_text", text: "Compressed result.", annotations: [] }] }],
      usage: { input_tokens: 300000, output_tokens: 3, total_tokens: 300003 },
    } }) + '\n\n');
  });
  server.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const host = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(host);
  const task = "x".repeat(1_100_000);
  assert.ok(estimateContextTokens([{ role: "user", content: task, timestamp: 0 }]).tokens > 272000);
  for (const [i, scenario] of [
    { provider: "openai", id: "gpt-6.2-sol", window: 272000, output: 4096, large: false },
    { provider: "openai", id: "gpt-6-luna", window: 272000, output: 4096, large: false },
    { provider: "openai", id: "gpt-5-x", window: 272000, output: 16, large: false },
    { provider: "other", id: "gpt-6-x", window: 272000, output: 16, large: false },
    { provider: "openai", id: "not-gpt-6", window: 272000, output: 16, large: false },
    { provider: "openai", id: "gpt-x6", window: 272000, output: 16, large: false },
    { provider: "openai", id: "gpt-10-x", window: 272000, output: 4096, large: false },
    { provider: "openai", id: "gpt-7-x", window: 2000000, output: 4096, large: true },
  ].entries()) {
    const model: Model<"openai-responses"> = { id: scenario.id, name: scenario.id, provider: scenario.provider,
      api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: true,
      thinkingLevelMap: { low: "low" }, input: ["text"], contextWindow: scenario.window, maxTokens: 128000,
      cost: { input: 2, output: 10, cacheRead: 1, cacheWrite: 0 } };
    registry.registerProvider(createProvider({ id: scenario.provider, models: [model], api: openAIResponsesApi(),
      auth: { apiKey: { name: "Fixture", async resolve() { return { auth: { apiKey: "loopback-only" }, source: "fixture" }; } } } }));
    const registered = registry.find(scenario.provider, scenario.id)!;
    const before = structuredClone(registered);
    const logicalRuntime = createLogicalRuntime({ trusted: true, projectConfig: { router: {
      models: { replace: [{ model: "sol-6.2", preferredProvider: scenario.provider, providers: { [scenario.provider]: scenario.id } }] },
      compressor: { models: [{ model: "sol-6.2", effort: "low" }] },
    } } });
    // The larger task distinguishes retaining two million from replacing it with 1.05 million.
    const result = await compressEpisode({ ctx: { cwd: root, hasUI: false, modelRegistry: registry } as ExtensionContext,
      episodeId: `t1.e${i + 1}`, threadId: "t1", threadName: "window", task: scenario.large ? task.repeat(4) : task,
      status: "ok", messages: [], observations: { stored: false, reason: "no-final-message", grammar: "absent" },
      logicalRuntime, admission: logicalRuntime.admit()!, retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0 } });
    assert.equal(payloads.length, i + 1, scenario.id);
    assert.equal(payloads[i]!.model, scenario.id);
    assert.equal(payloads[i]!.max_output_tokens, scenario.output, `${scenario.provider}/${scenario.id}`);
    assert.equal(result.compressor, `${scenario.provider}/${scenario.id}`, result.text.slice(-400));
    assert.match(result.text, /Compressed result/);
    assert.strictEqual(registry.find(scenario.provider, scenario.id), registered);
    assert.deepEqual(registered, before, "registry fields, costs and route identity stay unchanged");
  }
});
