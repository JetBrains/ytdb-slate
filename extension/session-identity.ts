export const SLATE_SESSION_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/;
export const OWNER_SESSION_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function isSlateSessionId(value: unknown): value is string {
	return typeof value === "string" && SLATE_SESSION_ID_PATTERN.test(value);
}

export function isOwnerSessionDigest(value: unknown): value is string {
	return typeof value === "string" && OWNER_SESSION_DIGEST_PATTERN.test(value);
}
