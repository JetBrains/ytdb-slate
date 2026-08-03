// Provides isContextOverflow and isRetryableAssistantError for
// extension/failover.ts. Tests can replace either implementation through
// piAiStub to inject SDK classification results.
export const piAiStub = {
  isContextOverflow: () => false,
  isRetryableAssistantError: () => false,
};
export const isContextOverflow = (...args) => piAiStub.isContextOverflow(...args);
export const isRetryableAssistantError = (...args) => piAiStub.isRetryableAssistantError(...args);
