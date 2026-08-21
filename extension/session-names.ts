import { randomBytes } from "node:crypto";

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{4}$/;
const MINTED_NAME_PATTERN = /^([a-z]+)-([a-z]+)-([0-9a-f]{4})$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:-|$)/;

export const SESSION_ADJECTIVES = [
	"amber", "brisk", "calm", "clear", "cool", "crisp", "daring", "eager",
	"fair", "fleet", "fresh", "gentle", "glad", "grand", "keen", "kind",
	"lively", "merry", "mild", "neat", "nimble", "plain", "proud", "quick",
	"quiet", "rapid", "ready", "steady", "swift", "tidy", "warm", "wise",
] as const;

export const SESSION_NOUNS = [
	"badger", "bison", "cedar", "comet", "coral", "crane", "dolphin", "falcon",
	"fern", "finch", "forest", "fox", "heron", "lark", "lynx", "maple",
	"marten", "moth", "oak", "otter", "owl", "panda", "pine", "puffin",
	"raven", "river", "robin", "sparrow", "spruce", "swift", "tiger", "willow",
] as const;

export function isSlateSessionName(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 48) return false;
	if (!/^[\x00-\x7f]+$/.test(value) || Buffer.byteLength(value, "utf8") > 48) return false;
	return NAME_PATTERN.test(value) && !WINDOWS_RESERVED.test(value);
}

export function isMintedSlateSessionName(value: unknown): value is string {
	if (!isSlateSessionName(value)) return false;
	const parts = MINTED_NAME_PATTERN.exec(value);
	if (parts === null) return false;
	return (SESSION_ADJECTIVES as readonly string[]).includes(parts[1]!)
		&& (SESSION_NOUNS as readonly string[]).includes(parts[2]!);
}

export interface SlateMint {
	identityBytes: Buffer;
	nameBytes: Buffer;
}

/** The sole random source for identity and session-name candidates. */
export function drawSlateMint(byteCount: 12 | 4 = 12): SlateMint {
	const bytes = randomBytes(byteCount);
	return byteCount === 12
		? { identityBytes: bytes.subarray(0, 8), nameBytes: bytes.subarray(8, 12) }
		: { identityBytes: Buffer.alloc(0), nameBytes: bytes };
}

export function sessionNameFromBytes(bytes: Uint8Array): string {
	if (bytes.byteLength !== 4) throw new Error("slate session names require four random bytes");
	const name = `${SESSION_ADJECTIVES[bytes[0]! & 31]}-${SESSION_NOUNS[bytes[1]! & 31]}-${Buffer.from(bytes.subarray(2, 4)).toString("hex")}`;
	if (!isSlateSessionName(name)) throw new Error("slate generated an invalid session name");
	return name;
}
