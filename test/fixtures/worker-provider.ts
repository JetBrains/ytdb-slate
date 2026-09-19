import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WORKER_PROVIDER_ID = "worker-owned-provider";

export default function workerProviderFixture(pi: ExtensionAPI): void {
	pi.registerProvider(WORKER_PROVIDER_ID, {
		name: "Worker-owned provider fixture",
		baseUrl: "memory://worker-owned",
		apiKey: "worker-owned-key",
		api: "fixture-api",
		models: [{
			id: "model",
			name: "model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1_000,
		}],
	});
}
