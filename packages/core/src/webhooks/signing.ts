/**
 * How a Webhook delivery is signed, so its receiver can tell it came from this Install and wasn't
 * changed or replayed (documented for receivers in `docs/webhooks.md`):
 *
 *     WebCraft-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the signing secret>
 *
 * The secret's UTF-8 bytes are the HMAC key, the body is the exact bytes sent, and `t` is when this
 * attempt was signed: a receiver checks the HMAC (in constant time) and refuses a `t` more than 5
 * minutes from its own clock, so a captured delivery can't be sent again later. The body carries the
 * delivery id, which stays the same on every attempt, so the receiver can drop a copy.
 */

/** The headers every delivery carries, in lower case. */
export const WEBHOOK_HEADERS = {
	signature: "webcraft-signature",
	delivery: "webcraft-delivery",
	event: "webcraft-event",
} as const;

/** The value of the signature header for a body, signed with `secret` at `timestamp` (Unix seconds). */
export async function signatureHeader(secret: string, timestamp: number, body: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
	return `t=${timestamp},v1=${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A new signing secret: 32 random bytes, base64url (43 characters). */
export function newSigningSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Buffer.from(bytes).toString("base64url");
}

/** The name of a Webhook's signing secret among its Site's secrets. */
export function signingSecretName(webhookId: string): string {
	return `webhook:${webhookId}:signing`;
}
