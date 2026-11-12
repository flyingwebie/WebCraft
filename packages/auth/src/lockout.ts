import type { Database } from "@webcraft/db";
import { people, signInThrottles } from "@webcraft/db/schema";
import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

/** Wrong passwords or codes in a row, from one place, that stop further tries from it. */
export const LOCK_AFTER_FAILED_ATTEMPTS = 10;

/** How long tries stay stopped. */
export const LOCK_DURATION_MS = 15 * 60 * 1000;

/** Wrong passwords in a row from every network together that pause sign-in from unknown networks. */
export const ACCOUNT_PAUSE_AFTER_FAILED_ATTEMPTS = 50;

/** How long a network the person signed in from stays known to their account. */
export const KNOWN_NETWORK_MS = 90 * 24 * 60 * 60 * 1000;

/** Counters nobody touched for this long, that aren't a known network, are deleted. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * What was stopped: sign-in with a password from one `network`, or from every network the person
 * hasn't signed in from (`account`); confirming who you are in one `session`; or the second step of
 * signing in (`codes`).
 */
export type LockScope = "network" | "account" | "session" | "codes";

/** Tries that were just stopped, for whoever tells the person and records it. */
export type AccountLock = {
	personId: string;
	email: string;
	scope: LockScope;
	failedAttempts: number;
	lockedUntil: Date;
	/** Where the attempt that stopped them came from, if known. */
	clientAddress: string | null;
};

/**
 * Where a password or code being checked comes from: a network signing in (`network`, the value
 * `AuthOptions.networkOf` gives a client address), or an admin session confirming who its person is.
 */
export type AttemptOrigin = { network: string } | { sessionId: string };

/**
 * Too many wrong passwords or codes: nothing more is checked from there until `lockedUntil`, not
 * even the right one.
 */
export class AccountLockedError extends Error {
	override name = "AccountLockedError";
	readonly lockedUntil: Date;
	readonly retryAfterSeconds: number;
	constructor(lockedUntil: Date, now: Date) {
		super("Too many wrong passwords or codes. Try again later, or use a passkey.");
		this.lockedUntil = lockedUntil;
		this.retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
	}
}

/**
 * Lockout stops guessing without letting an outsider lock a person out. Only what can be guessed
 * is ever stopped (passwords and codes): passkeys, open sessions, API tokens and AI clients never
 * are.
 *
 * - `attempts`: wrong passwords (and, confirming who you are, wrong codes) are counted where they
 *   come from. 10 in a row from one network, or in one session, stop further tries from that
 *   network or session for 15 minutes; a right one starts the count again. Trying while stopped
 *   checks nothing and doesn't make it longer. Signing in also counts every network together: 50
 *   wrong passwords in a row pause sign-in for 15 minutes from networks the person hasn't signed in
 *   from in the last 90 days, so many networks guessing together are slowed down while the person
 *   still gets in from home or work.
 * - `secondStep`: wrong codes at the second step of signing in are counted for the account, 10 in a
 *   row lock the second step for 15 minutes. Only someone who knows the password gets that far.
 *
 * Signing in answers a stopped network exactly like a wrong password (`Auth.signIn`), so the answer
 * never tells which addresses have an account; the person learns of it from its email.
 */
export type Lockout = {
	attempts: {
		/** Throws `AccountLockedError` while tries from `origin` are stopped for the person. */
		assertAllowed(personId: string, origin: AttemptOrigin): Promise<void>;
		/**
		 * Counts a wrong password or code. When it is the one that stops `origin`, reports it and
		 * throws `AccountLockedError`; otherwise returns.
		 */
		recordFailure(personId: string, origin: AttemptOrigin, clientAddress: string | null): Promise<void>;
		/** A right one: the counts it belongs to start again. */
		recordSuccess(personId: string, origin: AttemptOrigin): Promise<void>;
	};
	secondStep: {
		/** Throws `AccountLockedError` while the person's second step is locked. */
		assertAllowed(personId: string): Promise<void>;
		/** Counts a wrong code. When it is the 10th in a row, locks, reports it and throws `AccountLockedError`. */
		recordFailure(personId: string, clientAddress: string | null): Promise<void>;
		/** A right code: the count starts again. */
		recordSuccess(personId: string): Promise<void>;
	};
	/** The person signed in from `network`: it is one of theirs for the next 90 days. */
	signedIn(personId: string, network: string): Promise<void>;
	/** Deletes counters nobody touched for a day (known networks: for 90 days); answers how many. */
	purge(): Promise<number>;
};

const ACCOUNT = "account";

function keyOf(origin: AttemptOrigin): string {
	return "network" in origin ? `network:${origin.network}` : `session:${origin.sessionId}`;
}

export function createLockout(options: {
	database: Database;
	clock: { now(): Date };
	onLocked: (lock: AccountLock) => Promise<void>;
}): Lockout {
	const { db } = options.database;
	const { clock } = options;

	const report = async (lock: Omit<AccountLock, "email">) => {
		const [person] = await db.select({ email: people.email }).from(people).where(eq(people.id, lock.personId));
		if (person) await options.onLocked({ ...lock, email: person.email });
	};

	/**
	 * Counts one wrong try under `origin`, in one statement, so tries at the same moment count one
	 * after another and only one locks. Answers until when it is now locked (null: not yet), or
	 * `undefined` when it was locked already and nothing was counted.
	 */
	const count = async (personId: string, origin: string, limit: number, now: Date) => {
		const until = new Date(now.getTime() + LOCK_DURATION_MS);
		const reachesLimit = sql`${signInThrottles.failedAttempts} + 1 >= ${limit}`;
		const [row] = await db
			.insert(signInThrottles)
			.values({ personId, origin, failedAttempts: 1, updatedAt: now })
			.onConflictDoUpdate({
				target: [signInThrottles.personId, signInThrottles.origin],
				set: {
					failedAttempts: sql`case when ${reachesLimit} then 0 else ${signInThrottles.failedAttempts} + 1 end`,
					lockedUntil: sql`case when ${reachesLimit} then ${until.toISOString()}::timestamptz else null end`,
					updatedAt: now,
				},
				setWhere: or(isNull(signInThrottles.lockedUntil), lte(signInThrottles.lockedUntil, now)),
			})
			.returning({ lockedUntil: signInThrottles.lockedUntil });
		return row ? row.lockedUntil : undefined;
	};

	const assertAllowed = async (personId: string, origin: AttemptOrigin) => {
		const now = clock.now();
		const own = keyOf(origin);
		const rows = await db
			.select({
				origin: signInThrottles.origin,
				lockedUntil: signInThrottles.lockedUntil,
				knownAt: signInThrottles.knownAt,
			})
			.from(signInThrottles)
			.where(and(eq(signInThrottles.personId, personId), inArray(signInThrottles.origin, [own, ACCOUNT])));
		const from = rows.find((row) => row.origin === own);
		if (from?.lockedUntil && from.lockedUntil > now) throw new AccountLockedError(from.lockedUntil, now);
		if (!("network" in origin)) return;
		// The pause for every network never reaches one the person signed in from: an outsider can
		// keep it going, and must not keep the person out with it.
		if (from?.knownAt && now.getTime() - from.knownAt.getTime() < KNOWN_NETWORK_MS) return;
		const account = rows.find((row) => row.origin === ACCOUNT);
		if (account?.lockedUntil && account.lockedUntil > now) throw new AccountLockedError(account.lockedUntil, now);
	};

	const secondStepAllowed = async (personId: string) => {
		const now = clock.now();
		const [locked] = await db
			.select({ lockedUntil: people.lockedUntil })
			.from(people)
			.where(and(eq(people.id, personId), gt(people.lockedUntil, now)));
		if (locked?.lockedUntil) throw new AccountLockedError(locked.lockedUntil, now);
	};

	return {
		attempts: {
			assertAllowed,

			async recordFailure(personId, origin, clientAddress) {
				const now = clock.now();
				const locked = await count(personId, keyOf(origin), LOCK_AFTER_FAILED_ATTEMPTS, now);
				if ("network" in origin) {
					const paused = await count(personId, ACCOUNT, ACCOUNT_PAUSE_AFTER_FAILED_ATTEMPTS, now);
					if (paused) {
						await report({
							personId,
							scope: "account",
							failedAttempts: ACCOUNT_PAUSE_AFTER_FAILED_ATTEMPTS,
							lockedUntil: paused,
							clientAddress,
						});
					}
				}
				// Stopped in the meantime by another attempt.
				if (locked === undefined) return assertAllowed(personId, origin);
				if (!locked) return;
				await report({
					personId,
					scope: "network" in origin ? "network" : "session",
					failedAttempts: LOCK_AFTER_FAILED_ATTEMPTS,
					lockedUntil: locked,
					clientAddress,
				});
				throw new AccountLockedError(locked, now);
			},

			async recordSuccess(personId, origin) {
				const origins = "network" in origin ? [keyOf(origin), ACCOUNT] : [keyOf(origin)];
				await db
					.update(signInThrottles)
					.set({ failedAttempts: 0, lockedUntil: null, updatedAt: clock.now() })
					.where(
						and(
							eq(signInThrottles.personId, personId),
							inArray(signInThrottles.origin, origins),
							gt(signInThrottles.failedAttempts, 0),
						),
					);
			},
		},

		secondStep: {
			assertAllowed: secondStepAllowed,

			async recordFailure(personId, clientAddress) {
				const now = clock.now();
				const until = new Date(now.getTime() + LOCK_DURATION_MS);
				const reachesLimit = sql`${people.failedAttempts} + 1 >= ${LOCK_AFTER_FAILED_ATTEMPTS}`;
				const [row] = await db
					.update(people)
					.set({
						failedAttempts: sql`case when ${reachesLimit} then 0 else ${people.failedAttempts} + 1 end`,
						lockedUntil: sql`case when ${reachesLimit} then ${until.toISOString()}::timestamptz else null end`,
					})
					.where(and(eq(people.id, personId), or(isNull(people.lockedUntil), lte(people.lockedUntil, now))))
					.returning({ lockedUntil: people.lockedUntil });
				// Locked in the meantime by another attempt.
				if (!row) return secondStepAllowed(personId);
				if (!row.lockedUntil) return;
				await report({
					personId,
					scope: "codes",
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
		},

		async signedIn(personId, network) {
			const now = clock.now();
			await db
				.insert(signInThrottles)
				.values({ personId, origin: keyOf({ network }), knownAt: now, updatedAt: now })
				.onConflictDoUpdate({
					target: [signInThrottles.personId, signInThrottles.origin],
					set: { failedAttempts: 0, lockedUntil: null, knownAt: now, updatedAt: now },
				});
		},

		async purge() {
			const now = clock.now();
			const deleted = await db
				.delete(signInThrottles)
				.where(
					and(
						lt(signInThrottles.updatedAt, new Date(now.getTime() - STALE_AFTER_MS)),
						or(isNull(signInThrottles.lockedUntil), lte(signInThrottles.lockedUntil, now)),
						or(
							isNull(signInThrottles.knownAt),
							lt(signInThrottles.knownAt, new Date(now.getTime() - KNOWN_NETWORK_MS)),
						),
					),
				)
				.returning({ personId: signInThrottles.personId });
			return deleted.length;
		},
	};
}
