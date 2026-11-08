import type { Database } from "@webcraft/db";
import { people } from "@webcraft/db/schema";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

/** Wrong passwords in a row that lock an account. */
export const LOCK_AFTER_FAILED_ATTEMPTS = 10;

/** How long a locked account stays locked. */
export const LOCK_DURATION_MS = 15 * 60 * 1000;

/** An account that just locked, for whoever tells the person and records it. */
export type AccountLock = {
	personId: string;
	email: string;
	failedAttempts: number;
	lockedUntil: Date;
	/** Where the attempt that locked it came from, if known. */
	clientAddress: string | null;
};

/**
 * The account is locked after too many wrong passwords in a row: nothing is checked until
 * `lockedUntil`, not even the right password.
 */
export class AccountLockedError extends Error {
	override name = "AccountLockedError";
	readonly lockedUntil: Date;
	readonly retryAfterSeconds: number;
	constructor(lockedUntil: Date, now: Date) {
		super("This account is locked for a while after too many wrong passwords. Try again later.");
		this.lockedUntil = lockedUntil;
		this.retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
	}
}

/**
 * Lockout: 10 wrong passwords in a row (signing in, or confirming who you are) lock the account for
 * 15 minutes. The count is the person's, wherever the attempts come from; a right password starts
 * it again, and so does the lock. Trying while locked checks nothing and doesn't make the lock
 * longer. Addresses nobody signs in with are never locked, so the answer never tells which exist.
 */
export type Lockout = {
	/** Throws `AccountLockedError` while the person's account is locked. */
	assertUnlocked(personId: string): Promise<void>;
	/**
	 * Counts a wrong password. When it is the 10th in a row, locks the account, reports the lock and
	 * throws `AccountLockedError`; otherwise returns.
	 */
	recordFailure(personId: string, clientAddress: string | null): Promise<void>;
	/** A right password: the count starts again. */
	recordSuccess(personId: string): Promise<void>;
};

export function createLockout(options: {
	database: Database;
	clock: { now(): Date };
	onLocked: (lock: AccountLock) => Promise<void>;
}): Lockout {
	const { db } = options.database;
	const { clock } = options;
	const notLocked = (now: Date) => or(isNull(people.lockedUntil), lte(people.lockedUntil, now));

	const assertUnlocked = async (personId: string) => {
		const now = clock.now();
		const [locked] = await db
			.select({ lockedUntil: people.lockedUntil })
			.from(people)
			.where(and(eq(people.id, personId), gt(people.lockedUntil, now)));
		if (locked?.lockedUntil) throw new AccountLockedError(locked.lockedUntil, now);
	};

	return {
		assertUnlocked,

		async recordFailure(personId, clientAddress) {
			const now = clock.now();
			const until = new Date(now.getTime() + LOCK_DURATION_MS);
			const reachesLimit = sql`${people.failedAttempts} + 1 >= ${LOCK_AFTER_FAILED_ATTEMPTS}`;
			// One statement, so attempts at the same moment count one after another and only one locks.
			const [row] = await db
				.update(people)
				.set({
					failedAttempts: sql`case when ${reachesLimit} then 0 else ${people.failedAttempts} + 1 end`,
					lockedUntil: sql`case when ${reachesLimit} then ${until.toISOString()}::timestamptz else null end`,
				})
				.where(and(eq(people.id, personId), notLocked(now)))
				.returning({ email: people.email, failedAttempts: people.failedAttempts, lockedUntil: people.lockedUntil });
			// Locked in the meantime by another attempt.
			if (!row) return assertUnlocked(personId);
			if (!row.lockedUntil) return;
			await options.onLocked({
				personId,
				email: row.email,
				failedAttempts: LOCK_AFTER_FAILED_ATTEMPTS,
				lockedUntil: row.lockedUntil,
				clientAddress,
			});
			throw new AccountLockedError(row.lockedUntil, now);
		},

		async recordSuccess(personId) {
			await db
				.update(people)
				.set({ failedAttempts: 0, lockedUntil: null })
				.where(and(eq(people.id, personId), gt(people.failedAttempts, 0)));
		},
	};
}
