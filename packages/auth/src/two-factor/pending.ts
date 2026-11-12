import type { Database, Transaction } from "@webcraft/db";
import { verifications } from "@webcraft/db/schema";
import { and, eq, like, lt } from "drizzle-orm";

/** How long a right password waits for the second step. */
export const SECOND_STEP_MS = 5 * 60 * 1000;

const IDENTIFIER = "sign-in:";

/**
 * Sign-ins waiting for their second step: a right password started one, in one browser, for 5
 * minutes. The browser holds a random token in an `HttpOnly` cookie; only its SHA-256 hash is kept
 * (in `verifications`), with the person it is for. Finishing the second step uses it up.
 */
export type PendingSignIns = {
	/** Starts one for the person and answers the `Set-Cookie` line that hands the browser its token. */
	start(personId: string): Promise<string>;
	/** The person the request's sign-in is waiting for, or null (none, or more than 5 minutes old). */
	personOf(headers: Headers): Promise<string | null>;
	/** Ends the request's waiting sign-in, if any, and answers the `Set-Cookie` line that clears its cookie. */
	finish(headers: Headers): Promise<string>;
	/** Ends every sign-in waiting for the person's second step: the password that started them is no longer theirs. */
	endFor(tx: Database["db"] | Transaction, personId: string): Promise<void>;
};

export function createPendingSignIns({
	database,
	clock,
	secure,
}: {
	database: Database;
	clock: { now(): Date };
	secure: boolean;
}): PendingSignIns {
	const { db } = database;
	// `__Host-` keeps the cookie to this exact host, over HTTPS; a plain-HTTP development host can't use it.
	const name = secure ? "__Host-webcraft-second-step" : "webcraft-second-step";
	const attributes = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

	const tokenOf = (headers: Headers) => cookieValue(headers.get("cookie"), name);

	return {
		async start(personId) {
			const now = clock.now();
			// Old ones are cleared as new ones come, so the table never fills up.
			await db
				.delete(verifications)
				.where(and(like(verifications.identifier, `${IDENTIFIER}%`), lt(verifications.expiresAt, now)));
			const token = randomToken();
			await db.insert(verifications).values({
				identifier: IDENTIFIER + (await sha256(token)),
				value: personId,
				expiresAt: new Date(now.getTime() + SECOND_STEP_MS),
				createdAt: now,
				updatedAt: now,
			});
			return `${name}=${token}; ${attributes}; Max-Age=${SECOND_STEP_MS / 1000}`;
		},

		async personOf(headers) {
			const token = tokenOf(headers);
			if (!token) return null;
			const [row] = await db
				.select({ personId: verifications.value, expiresAt: verifications.expiresAt })
				.from(verifications)
				.where(eq(verifications.identifier, IDENTIFIER + (await sha256(token))));
			if (!row || row.expiresAt.getTime() <= clock.now().getTime()) return null;
			return row.personId;
		},

		async finish(headers) {
			const token = tokenOf(headers);
			if (token) await db.delete(verifications).where(eq(verifications.identifier, IDENTIFIER + (await sha256(token))));
			return `${name}=; ${attributes}; Max-Age=0`;
		},

		async endFor(tx, personId) {
			await tx
				.delete(verifications)
				.where(and(like(verifications.identifier, `${IDENTIFIER}%`), eq(verifications.value, personId)));
		},
	};
}

/** 32 random bytes, base64url. */
export function randomToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError("Not base64url.");
	const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** One cookie's value from a `Cookie` header. */
function cookieValue(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim() || null;
	}
	return null;
}
