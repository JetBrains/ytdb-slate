// Compat API fixture mapped by the optional verification/test-resolve-hooks.mjs loader.
// Tests that import compat can replace piAiCompatStub.complete.
export const piAiCompatStub = {
  async complete() {
    return {
      stopReason: "stop",
      content: [{ type: "text", text: "stub" }],
      usage: { cost: { total: 0 } },
    };
  },
};
export const complete = (...args) => piAiCompatStub.complete(...args);
export const completeSimple = (...args) => piAiCompatStub.complete(...args);
