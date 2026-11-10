import type { Database } from "@webcraft/db";
import { passkeys, verifications } from "@webcraft/db/schema";
import { and, asc, eq, like, lt } from "drizzle-orm";

import { randomToken, sha256 } from "./pending.ts";

/** How long a passkey ceremony may take, from its options to its answer. */
const CHALLENGE_MS = 5 * 60 * 1000;

const IDENTIFIER = "passkey:";

/** What a challenge was given for: adding a passkey, signing in, or confirming who you are. */
export type ChallengePurpose = "register" | "sign-in" | "identity";

/** A stored passkey, as the ceremonies need it. */
export type StoredPasskey = {
	id: string;
	personId: string;
	credentialId: string;
	publicKey: Uint8Array;
	signCount: number;
	transports: string[];
	name: string;
};

/**
 * Passkey challenges and stored passkeys. Each challenge is random, works once and for 5 minutes,
 * and remembers what it was given for and to whom (the person adding a passkey or confirming who
 * they are; the person whose sign-in waits for its second step; nobody for a sign-in with a passkey
 * alone). Only its SHA-256 hash is kept, in `verifications`.
 */
export function createPasskeyStore({ database, clock }: { database: Database; clock: { now(): Date } }) {
	const { db } = database;

	return {
		async newChallenge(purpose: ChallengePurpose, personId: string | null): Promise<string> {
			const now = clock.now();
			await db
				.delete(verifications)
				.where(and(like(verifications.identifier, `${IDENTIFIER}%`), lt(verifications.expiresAt, now)));
			const challenge = randomToken();
			await db.insert(verifications).values({
				identifier: IDENTIFIER + (await sha256(challenge)),
				value: JSON.stringify({ purpose, personId }),
				expiresAt: new Date(now.getTime() + CHALLENGE_MS),
				createdAt: now,
				updatedAt: now,
			});
			return challenge;
		},

		/**
		 * Uses a challenge up: answers who it was given to when it was given for `purpose` and is still
		 * valid, null otherwise. Either way it never works again.
		 */
		async takeChallenge(challenge: string, purpose: ChallengePurpose): Promise<{ personId: string | null } | null> {
			const [row] = await db
				.delete(verifications)
				.where(eq(verifications.identifier, IDENTIFIER + (await sha256(challenge))))
				.returning({ value: verifications.value, expiresAt: verifications.expiresAt });
			if (!row || row.expiresAt.getTime() <= clock.now().getTime()) return null;
			const given = JSON.parse(row.value) as { purpose: ChallengePurpose; personId: string | null };
			return given.purpose === purpose ? { personId: given.personId } : null;
		},

		async ofPerson(personId: string): Promise<StoredPasskey[]> {
			return db
				.select({
					id: passkeys.id,
					personId: passkeys.personId,
					credentialId: passkeys.credentialId,
					publicKey: passkeys.publicKey,
					signCount: passkeys.signCount,
					transports: passkeys.transports,
					name: passkeys.name,
				})
				.from(passkeys)
				.where(eq(passkeys.personId, personId))
				.orderBy(asc(passkeys.createdAt), asc(passkeys.id));
		},

		async byCredentialId(credentialId: string): Promise<StoredPasskey | null> {
			const [row] = await db
				.select({
					id: passkeys.id,
					personId: passkeys.personId,
					credentialId: passkeys.credentialId,
					publicKey: passkeys.publicKey,
					signCount: passkeys.signCount,
					transports: passkeys.transports,
					name: passkeys.name,
				})
				.from(passkeys)
				.where(eq(passkeys.credentialId, credentialId));
			return row ?? null;
		},

		/**
		 * Records a use: the new signature count, when, and the backup state. Answers false when another
		 * request moved the count past it meanwhile (the same assertion twice).
		 */
		async recordUse(passkey: StoredPasskey, use: { signCount: number; backedUp: boolean }): Promise<boolean> {
			const updated = await db
				.update(passkeys)
				.set({ signCount: use.signCount, backedUp: use.backedUp, lastUsedAt: clock.now() })
				.where(and(eq(passkeys.id, passkey.id), eq(passkeys.signCount, passkey.signCount)))
				.returning({ id: passkeys.id });
			return updated.length > 0;
		},
	};
}

export type PasskeyStore = ReturnType<typeof createPasskeyStore>;
