/** Classify a main run from its final response and observed cancellation evidence. */
export function classifyRunOutcome(message: { stopReason?: unknown } | undefined, cancelled = false): "cancelled" | "error" | "success" | "unknown" {
	if (cancelled || message?.stopReason === "aborted") return "cancelled";
	if (message?.stopReason === "error") return "error";
	if (typeof message?.stopReason === "string" && ["stop", "length", "toolUse"].includes(message.stopReason)) return "success";
	return "unknown";
}
