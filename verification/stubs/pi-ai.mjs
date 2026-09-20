// Provides isContextOverflow and isRetryableAssistantError for
// extension/failover.ts. Tests can replace either implementation through
// piAiStub to inject SDK classification results.
export const piAiStub = {
  isContextOverflow: () => false,
  isRetryableAssistantError: (message) => message?.stopReason === "error" && /429|timeout|temporary|transient|unavailable/i.test(message.errorMessage ?? ""),
};
export const isContextOverflow = (...args) => piAiStub.isContextOverflow(...args);
export const isRetryableAssistantError = (...args) => piAiStub.isRetryableAssistantError(...args);
export function getSupportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  const map = model.thinkingLevelMap;
  return ["minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => map?.[level] !== null);
}
export async function retryAssistantCall(produce, policy, signal, callbacks) {
  const max = policy?.enabled ? policy.maxRetries : 0;
  let attempt = 0;
  for (;;) {
    const response = await produce();
    if (response.stopReason !== "error" || !isRetryableAssistantError(response) || attempt >= max) {
      if (attempt > 0) await callbacks?.onRetryFinished?.(response.stopReason !== "error", attempt, response.errorMessage);
      return response;
    }
    attempt++;
    await callbacks?.onRetryScheduled?.(attempt, max, policy.baseDelayMs * 2 ** (attempt - 1), response.errorMessage ?? "Unknown error");
    if (signal?.aborted) {
      await callbacks?.onRetryFinished?.(false, attempt, response.errorMessage);
      const { errorMessage: _ignored, ...rest } = response;
      return { ...rest, stopReason: "aborted" };
    }
    await callbacks?.onRetryAttemptStart?.();
  }
}
