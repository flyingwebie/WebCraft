import type { Database, Transaction } from "@webcraft/db";
import { authenticators, backupCodes, passkeys, people, sessions } from "@webcraft/db/schema";
import { and, asc, count, eq, isNull, lt, ne } from "drizzle-orm";

import { newBackupCodes, normaliseBackupCode } from "./backup-codes.ts";
import {
	AuthenticatorExistsError,
	SecondFactorNotFoundError,
	TwoFactorCodeInvalidError,
	TwoFactorOffError,
} from "./errors.ts";
import { matchingTotpStep, newTotpSecret, otpauthUri } from "./totp.ts";
import { type NewPasskey, PasskeyInvalidError } from "./webauthn.ts";

/** Which of a person's two authenticator secrets: the app they use, or one being added. */
export type SecretSlot = "active" | "pending";

/**
 * What second factors need from the Install: where authenticator secrets are kept (encrypted under
 * the Master key, in WebCraft's secret store) and the keyed hash of backup codes. `@webcraft/core`
 * provides both.
 */
export type SecondFactorKeys = {
	authenticatorSecret: {
		set(personId: string, slot: SecretSlot, secret: string): Promise<void>;
		/** Calls `use` with the secret, or answers null when the person has none in that slot. */
		useWith<Result>(
			personId: string,
			slot: SecretSlot,
			use: (secret: string) => Promise<Result>,
		): Promise<Result | null>;
		remove(personId: string, slot: SecretSlot): Promise<void>;
	};
	/** A keyed hash of a backup code (in the form `normaliseBackupCode` gives), safe to store. */
	hashBackupCode(code: string): Promise<string>;
};

/** A second factor a person can add: an authenticator app or a passkey. */
export type SecondFactorMethod = "authenticator" | "passkey";

/** A way to take the second step of signing in. */
export type SecondStepMethod = "authenticator" | "backupCode" | "passkey";

/** A passkey as its person sees it in Your account. */
export type PasskeySummary = {
	id: string;
	name: string;
	addedAt: Date;
	lastUsedAt: Date | null;
	/** Whether the passkey is synced to the person's other devices. */
	synced: boolean;
};

/** A person's second factors, as they see them in Your account. */
export type SecondFactorSummary = {
	authenticator: { addedAt: Date; lastUsedAt: Date | null } | null;
	passkeys: PasskeySummary[];
	/** Their backup codes not used yet. */
	backupCodesLeft: number;
};

/** Called inside the transaction that made a change, to record it with the change. */
export type AlsoInTransaction<Result> = (tx: Transaction, result: Result) => Promise<void>;

/** What adding or removing a second factor did. */
export type FactorChange = {
	/** The person's other sessions it ended. */
	signedOutSessions: number;
};

export function createSecondFactorStore({
	database,
	clock,
	keys,
}: {
	database: Database;
	clock: { now(): Date };
	keys: SecondFactorKeys;
}) {
	const { db } = database;
	type Executor = typeof db | Transaction;

	const hasAuthenticator = async (executor: Executor, personId: string) =>
		(
			await executor
				.select({ id: authenticators.personId })
				.from(authenticators)
				.where(eq(authenticators.personId, personId))
		).length > 0;
	const passkeyCount = async (executor: Executor, personId: string) =>
		(await executor.select({ n: count() }).from(passkeys).where(eq(passkeys.personId, personId)))[0]?.n ?? 0;
	const unusedBackupCodes = async (executor: Executor, personId: string) =>
		(
			await executor
				.select({ n: count() })
				.from(backupCodes)
				.where(and(eq(backupCodes.personId, personId), isNull(backupCodes.usedAt)))
		)[0]?.n ?? 0;

	/** Replaces the person's backup codes with 10 new ones, and answers them. */
	const writeBackupCodes = async (tx: Transaction, personId: string): Promise<string[]> => {
		const codes = newBackupCodes();
		const now = clock.now();
		await tx.delete(backupCodes).where(eq(backupCodes.personId, personId));
		const hashes = await Promise.all(codes.map((code) => keys.hashBackupCode(normaliseBackupCode(code) ?? code)));
		await tx.insert(backupCodes).values(hashes.map((codeHash) => ({ personId, codeHash, createdAt: now })));
		return codes;
	};

	/** Ends the person's sessions but `keep` (all of them without one), and answers how many. */
	/** Takes the person's row, so their second factors change one at a time. */
	const lockPerson = async (tx: Transaction, personId: string): Promise<void> => {
		await tx.select({ id: people.id }).from(people).where(eq(people.id, personId)).for("update");
	};
	const endSessions = async (tx: Transaction, personId: string, keep: string | null) => {
		const ended = await tx
			.delete(sessions)
			.where(keep ? and(eq(sessions.personId, personId), ne(sessions.id, keep)) : eq(sessions.personId, personId))
			.returning({ id: sessions.id });
		return ended.length;
	};

	return {
		writeBackupCodes,
		endSessions,
		hasAuthenticator,
		passkeyCount,

		async summary(personId: string): Promise<SecondFactorSummary> {
			const [authenticator] = await db
				.select({ addedAt: authenticators.createdAt, lastUsedAt: authenticators.lastUsedAt })
				.from(authenticators)
				.where(eq(authenticators.personId, personId));
			const rows = await db
				.select({
					id: passkeys.id,
					name: passkeys.name,
					addedAt: passkeys.createdAt,
					lastUsedAt: passkeys.lastUsedAt,
					synced: passkeys.backedUp,
				})
				.from(passkeys)
				.where(eq(passkeys.personId, personId))
				.orderBy(asc(passkeys.createdAt), asc(passkeys.id));
			return {
				authenticator: authenticator ?? null,
				passkeys: rows,
				backupCodesLeft: await unusedBackupCodes(db, personId),
			};
		},

		/** Whether the person has an authenticator app or a passkey. */
		async isOn(personId: string): Promise<boolean> {
			return (await hasAuthenticator(db, personId)) || (await passkeyCount(db, personId)) > 0;
		},

		/** The ways the person can take the second step of signing in; none when they have no second factor. */
		async secondStepMethods(personId: string): Promise<SecondStepMethod[]> {
			const methods: SecondStepMethod[] = [];
			const withApp = await hasAuthenticator(db, personId);
			const withPasskeys = (await passkeyCount(db, personId)) > 0;
			if (!withApp && !withPasskeys) return methods;
			if (withApp) methods.push("authenticator");
			if ((await unusedBackupCodes(db, personId)) > 0) methods.push("backupCode");
			if (withPasskeys) methods.push("passkey");
			return methods;
		},

		/**
		 * Uses a code from the person's authenticator app: right now (or a step either side) and newer
		 * than the last one used, which it then becomes. Answers whether it was accepted.
		 */
		async useAuthenticatorCode(personId: string, code: string): Promise<boolean> {
			const [row] = await db
				.select({ lastUsedStep: authenticators.lastUsedStep })
				.from(authenticators)
				.where(eq(authenticators.personId, personId));
			if (!row) return false;
			const now = clock.now();
			const step = await keys.authenticatorSecret.useWith(personId, "active", (secret) =>
				matchingTotpStep(secret, code, now, row.lastUsedStep),
			);
			if (step === null) return false;
			// Two requests with the same code at once: only one moves the step on.
			const claimed = await db
				.update(authenticators)
				.set({ lastUsedStep: step, lastUsedAt: now })
				.where(and(eq(authenticators.personId, personId), lt(authenticators.lastUsedStep, step)))
				.returning({ step: authenticators.lastUsedStep });
			return claimed.length > 0;
		},

		/** Uses one of the person's backup codes up. Answers whether it was one of their unused codes. */
		async useBackupCode(personId: string, code: string): Promise<boolean> {
			const plain = normaliseBackupCode(code);
			if (!plain) return false;
			const codeHash = await keys.hashBackupCode(plain);
			const used = await db
				.update(backupCodes)
				.set({ usedAt: clock.now() })
				.where(and(eq(backupCodes.personId, personId), eq(backupCodes.codeHash, codeHash), isNull(backupCodes.usedAt)))
				.returning({ id: backupCodes.id });
			return used.length > 0;
		},

		/** Starts adding an authenticator app: a new secret, kept until a code from it confirms it. */
		async startAuthenticator(personId: string, label: { issuer: string; accountName: string }) {
			if (await hasAuthenticator(db, personId)) throw new AuthenticatorExistsError();
			const secret = newTotpSecret();
			await keys.authenticatorSecret.set(personId, "pending", secret);
			return { secret, uri: otpauthUri(secret, label.issuer, label.accountName) };
		},

		/**
		 * Adds the authenticator app being added once `code` comes from it, ends the person's other
		 * sessions, and gives them backup codes when it is their first second factor.
		 */
		async confirmAuthenticator(
			personId: string,
			keepSession: string,
			code: string,
			also?: AlsoInTransaction<FactorChange>,
		): Promise<FactorChange & { backupCodes: string[] | null }> {
			if (await hasAuthenticator(db, personId)) throw new AuthenticatorExistsError();
			const now = clock.now();
			const step = await keys.authenticatorSecret.useWith(personId, "pending", (secret) =>
				matchingTotpStep(secret, code, now, null),
			);
			if (step === null) throw new TwoFactorCodeInvalidError("setup");
			await keys.authenticatorSecret.useWith(personId, "pending", (secret) =>
				keys.authenticatorSecret.set(personId, "active", secret),
			);
			const result = await db.transaction(async (tx) => {
				// One change to a person's second factors at a time.
				await lockPerson(tx, personId);
				if (await hasAuthenticator(tx, personId)) throw new AuthenticatorExistsError();
				const first = (await passkeyCount(tx, personId)) === 0;
				await tx.insert(authenticators).values({ personId, lastUsedStep: step, createdAt: now });
				const codes = first ? await writeBackupCodes(tx, personId) : null;
				const change = { signedOutSessions: await endSessions(tx, personId, keepSession) };
				await also?.(tx, change);
				return { ...change, backupCodes: codes };
			});
			await keys.authenticatorSecret.remove(personId, "pending");
			return result;
		},

		/**
		 * Removes the person's authenticator app (and their backup codes when it was their last second
		 * factor) and ends their other sessions.
		 */
		async removeAuthenticator(
			personId: string,
			keepSession: string,
			also?: AlsoInTransaction<FactorChange & { last: boolean }>,
		): Promise<FactorChange & { last: boolean }> {
			const result = await db.transaction(async (tx) => {
				await lockPerson(tx, personId);
				const removed = await tx
					.delete(authenticators)
					.where(eq(authenticators.personId, personId))
					.returning({ id: authenticators.personId });
				if (removed.length === 0) throw new SecondFactorNotFoundError("authenticator");
				const last = (await passkeyCount(tx, personId)) === 0;
				if (last) await tx.delete(backupCodes).where(eq(backupCodes.personId, personId));
				const change = { signedOutSessions: await endSessions(tx, personId, keepSession), last };
				await also?.(tx, change);
				return change;
			});
			await keys.authenticatorSecret.remove(personId, "active");
			await keys.authenticatorSecret.remove(personId, "pending");
			return result;
		},

		/**
		 * Stores a verified passkey for the person, ends their other sessions, and gives them backup
		 * codes when it is their first second factor. A passkey already stored (on anyone) is refused.
		 */
		async addPasskey(
			personId: string,
			keepSession: string,
			passkey: NewPasskey & { name: string },
			also?: AlsoInTransaction<FactorChange>,
		): Promise<FactorChange & { passkey: PasskeySummary; backupCodes: string[] | null }> {
			const now = clock.now();
			return db.transaction(async (tx) => {
				await lockPerson(tx, personId);
				const first = !(await hasAuthenticator(tx, personId)) && (await passkeyCount(tx, personId)) === 0;
				const [row] = await tx
					.insert(passkeys)
					.values({
						personId,
						credentialId: passkey.credentialId,
						publicKey: Buffer.from(passkey.publicKey),
						algorithm: passkey.algorithm,
						signCount: passkey.signCount,
						transports: passkey.transports,
						backedUp: passkey.backedUp,
						name: passkey.name,
						createdAt: now,
					})
					.onConflictDoNothing({ target: passkeys.credentialId })
					.returning({ id: passkeys.id });
				if (!row) throw new PasskeyInvalidError("passkey already stored", "setup");
				const codes = first ? await writeBackupCodes(tx, personId) : null;
				const change = { signedOutSessions: await endSessions(tx, personId, keepSession) };
				await also?.(tx, change);
				return {
					...change,
					passkey: { id: row.id, name: passkey.name, addedAt: now, lastUsedAt: null, synced: passkey.backedUp },
					backupCodes: codes,
				};
			});
		},

		/**
		 * Removes one of the person's passkeys (and their backup codes when it was their last second
		 * factor) and ends their other sessions.
		 */
		async removePasskey(
			personId: string,
			keepSession: string,
			passkeyId: string,
			also?: AlsoInTransaction<FactorChange & { last: boolean; name: string }>,
		): Promise<FactorChange & { last: boolean; name: string }> {
			return db.transaction(async (tx) => {
				await lockPerson(tx, personId);
				const [removed] = await tx
					.delete(passkeys)
					.where(and(eq(passkeys.id, passkeyId), eq(passkeys.personId, personId)))
					.returning({ name: passkeys.name });
				if (!removed) throw new SecondFactorNotFoundError("passkey");
				const last = !(await hasAuthenticator(tx, personId)) && (await passkeyCount(tx, personId)) === 0;
				if (last) await tx.delete(backupCodes).where(eq(backupCodes.personId, personId));
				const change = { signedOutSessions: await endSessions(tx, personId, keepSession), last, name: removed.name };
				await also?.(tx, change);
				return change;
			});
		},

		/** Replaces the person's backup codes with 10 new ones. Only for people with a second factor. */
		async regenerateBackupCodes(personId: string, also?: AlsoInTransaction<undefined>): Promise<string[]> {
			return db.transaction(async (tx) => {
				await lockPerson(tx, personId);
				if (!(await hasAuthenticator(tx, personId)) && (await passkeyCount(tx, personId)) === 0) {
					throw new TwoFactorOffError();
				}
				const codes = await writeBackupCodes(tx, personId);
				await also?.(tx, undefined);
				return codes;
			});
		},

		/**
		 * Removes every second factor of the person and their backup codes, ends all their sessions and
		 * lifts a lock on their account, so they sign in with their password alone and set it up again.
		 */
		async reset(
			personId: string,
			also?: AlsoInTransaction<{ authenticator: boolean; passkeys: number; signedOutSessions: number }>,
		) {
			const result = await db.transaction(async (tx) => {
				await lockPerson(tx, personId);
				const app = await tx
					.delete(authenticators)
					.where(eq(authenticators.personId, personId))
					.returning({ id: authenticators.personId });
				const keysRemoved = await tx
					.delete(passkeys)
					.where(eq(passkeys.personId, personId))
					.returning({ id: passkeys.id });
				await tx.delete(backupCodes).where(eq(backupCodes.personId, personId));
				await tx.update(people).set({ failedAttempts: 0, lockedUntil: null }).where(eq(people.id, personId));
				const change = {
					authenticator: app.length > 0,
					passkeys: keysRemoved.length,
					signedOutSessions: await endSessions(tx, personId, null),
				};
				await also?.(tx, change);
				return change;
			});
			await keys.authenticatorSecret.remove(personId, "active");
			await keys.authenticatorSecret.remove(personId, "pending");
			return result;
		},
	};
}

export type SecondFactorStore = ReturnType<typeof createSecondFactorStore>;
