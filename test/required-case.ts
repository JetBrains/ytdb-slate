import assert from "node:assert/strict";
import test from "node:test";

/** Only the case body calls complete, after its last required assertion. */
export function requiredCase(
	name: string,
	options: test.TestOptions,
	run: (t: test.TestContext, complete: () => void) => void | Promise<void>,
) {
	for (const key of ["skip", "todo"] as const) {
		assert.ok(options[key] === undefined || options[key] === false, `${name} must not enable ${key}`);
	}
	return test(name, options, async (t) => {
		let completed = false;
		let forbiddenCall: Error | undefined;
		const forbid = (method: string): never => {
			forbiddenCall ??= new Error(`${name} must not call t.${method}()`);
			throw forbiddenCall;
		};
		t.skip = () => forbid("skip");
		t.todo = () => forbid("todo");
		const verify = () => {
			if (forbiddenCall) throw forbiddenCall;
			assert.ok(completed, `${name} did not reach its terminal completion marker`);
		};
		await run(t, () => { completed = true; });
		t.after(verify);
		verify();
	});
}
