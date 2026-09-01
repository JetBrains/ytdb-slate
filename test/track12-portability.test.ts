import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveCorpusProject } from "../extension/corpus.ts";
import { completeDurableHandoff, durableHandoffReference } from "../extension/durable-handoff.ts";
import {
	createDurableSession,
	readDurableSession,
	type CanonicalSlateRuntime,
} from "../extension/session-record.ts";

const ID = "20260828T120000Z-0123abcd0123abcd";
const NAME = "calm-otter-7f3a";
const SOURCE = "a".repeat(64);

function runtime(workerCostUsd: number): CanonicalSlateRuntime {
	return {
		threads: [],
		episodes: [],
		threadSeq: 0,
		slateSessionParentChain: [],
		orchestratorMode: true,
		paused: true,
		workerCostUsd,
		carriedCostUsd: 1,
	};
}

test("Track 12 validates and reads back stored records on a supported platform", () => {
	const root = mkdtempSync(join(tmpdir(), "slate-track12-portability."));
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agent);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		const project = resolveCorpusProject(cwd, "portability");
		const created = createDurableSession({
			project,
			cwd,
			identity: ID,
			name: NAME,
			creatorSessionDigest: SOURCE,
			runtime: runtime(3),
		});
		const result = completeDurableHandoff({
			project,
			cwd,
			reference: durableHandoffReference(created),
		});
		assert.equal(result.kind, "complete");
		assert.equal(result.record.state.lastWriterSessionDigest, SOURCE);
		assert.equal(result.record.state.runtime.workerCostUsd, 3);
		assert.deepEqual(readDurableSession({ project, name: NAME }), result.record);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
