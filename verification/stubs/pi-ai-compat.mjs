// Provides complete for extension/episodes.ts. Tests can replace
// piAiCompatStub.complete to script compression success or failure.
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
