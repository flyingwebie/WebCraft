import type { Clock } from "../clock.ts";

/**
 * The time trap: every Form carries a token saying when its page was handed out, signed with a key
 * derived from the Master key, so a post that comes sooner after than a person could fill the Form in,
 * or without a token this Install made for the Site, is spam. Cached pages hold none: the Site
 * pipeline puts a new one in each time it answers a page (`FORM_TOKEN_MARK`). It names no visitor.
 *
 * A token is `<seconds since 1970, base 36>.<HMAC of the Site and the time, base64url>`.
 */
export type FormTokens = {
	/** A token for a page of the Site handed out now. */
	issue(siteId: string): Promise<string>;
	/** When a token of the Site was issued, or null when it isn't one this Install made for the Site. */
	issuedAt(siteId: string, token: string): Promise<Date | null>;
};

const TOKEN = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/;

export function createFormTokens({ key, clock }: { key: CryptoKey; clock: Clock }): FormTokens {
	const sign = async (siteId: string, seconds: number) => {
		const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${siteId}:${seconds}`));
		return Buffer.from(signature).toString("base64url");
	};
	return {
		async issue(siteId) {
			const seconds = Math.floor(clock.now().getTime() / 1000);
			return `${seconds.toString(36)}.${await sign(siteId, seconds)}`;
		},
		async issuedAt(siteId, token) {
			const match = TOKEN.exec(token);
			if (!match) return null;
			const seconds = Number.parseInt(match[1] ?? "", 36);
			const expected = await sign(siteId, seconds);
			// Compared in full, whatever the token, so the time taken says nothing about the signature.
			let difference = expected.length ^ (match[2] ?? "").length;
			for (let index = 0; index < expected.length; index++) {
				difference |= expected.charCodeAt(index) ^ (match[2]?.charCodeAt(index) ?? 0);
			}
			return difference === 0 ? new Date(seconds * 1000) : null;
		},
	};
}
