/**
 * One-time tokens sent to people (setup tokens, invite links). Only the token's hash is stored, so
 * a copy of the database can't be used to claim anything.
 */

/** 32 random bytes, base64url: 43 characters. */
export function newToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Buffer.from(bytes).toString("base64url");
}

/** The SHA-256 hash of a token, in hexadecimal: what is stored and looked up. */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token.trim()));
	return Buffer.from(digest).toString("hex");
}
