import type { WorkerRequestContract } from "../extension/worker.ts";

interface FakeWorkerRequestSession {
	model?: { provider?: unknown; id?: unknown };
	thinkingLevel?: unknown;
	prompt(text: string): Promise<void>;
}

const BASE_PROMPTS = new WeakMap<object, (text: string) => Promise<void>>();

/** Make a fake worker cross the same action-local acceptance owner as a real Pi worker. */
export function bindFakeWorkerRequest<T extends FakeWorkerRequestSession>(session: T, contract: WorkerRequestContract): T {
	let prompt = BASE_PROMPTS.get(session);
	if (prompt === undefined) {
		prompt = session.prompt.bind(session);
		BASE_PROMPTS.set(session, prompt);
	}
	session.prompt = async (text: string) => {
		const reasoning = session.thinkingLevel === "off" ? undefined : session.thinkingLevel;
		await contract.accept(session.model ?? {}, reasoning, undefined, () => prompt(text));
	};
	return session;
}
