import type { Database, Transaction } from "@webcraft/db";
import { credentials, people, sessions, verifications } from "@webcraft/db/schema";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import * as z from "zod";

import { type AccountLock, AccountLockedError, createLockout } from "./lockout.ts";
import {
	assertNewPasswordAllowed,
	hashPassword,
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	type PasswordCheck,
	verifyPassword,
} from "./passwords.ts";
import { createPerson, type NewPerson, normaliseEmail, PASSWORD_PROVIDER } from "./people.ts";
import { SignInExpiredError, TwoFactorCodeInvalidError } from "./two-factor/errors.ts";
import { createPasskeyStore } from "./two-factor/passkeys.ts";
import { base64url, createPendingSignIns } from "./two-factor/pending.ts";
import {
	type AlsoInTransaction,
	createSecondFactorStore,
	type FactorChange,
	type PasskeySummary,
	type SecondFactorKeys,
	type SecondFactorSummary,
	type SecondStepMethod,
} from "./two-factor/second-factors.ts";
import {
	type AssertionCredential,
	challengeOf,
	creationOptions,
	PasskeyInvalidError,
	type RegistrationCredential,
	type RelyingParty,
	requestOptions,
	verifyAssertion,
	verifyRegistration,
} from "./two-factor/webauthn.ts";

/** Sessions end after this long without being used. */
export const SESSION_IDLE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
/** Sessions end this long after sign-in, however much they are used. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A used session records its use at most this often, so most requests write nothing. */
const SESSION_RENEW_AFTER_MS = 10 * 60 * 1000;

/** What auth needs from a logger; `@webcraft/core`'s Logger fits. */
type AuthLog = {
	warn(msg: string, fields?: Record<string, unknown>): void;
	error(msg: string, fields?: Record<string, unknown>): void;
	debug(msg: string, fields?: Record<string, unknown>): void;
};

export type AuthOptions = {
	database: Database;
	/** Where the time comes from; sessions expire by this clock. */
	clock: { now(): Date };
	/**
	 * Where people reach the admin, such as `https://admin.example.com`. Session cookies belong to
	 * its hostname alone, and are `Secure` unless it is a plain-HTTP development origin.
	 */
	adminOrigin: string;
	/** Signs session cookies. Derived from the Master key, so every web process has the same one. */
	secret: string;
	log: AuthLog;
	/** Extra checks on new passwords, after the length rules (the leaked-password lookup plugs in here). */
	passwordChecks?: readonly PasswordCheck[];
	/**
	 * Called once when wrong passwords lock an account, before the attempt is refused: the person is
	 * told and the lock recorded there. A failure here is logged; the account stays locked.
	 */
	onAccountLocked?: (lock: AccountLock) => Promise<void>;
	/** Where authenticator secrets are kept and how backup codes are hashed (see `SecondFactorKeys`). */
	secondFactorKeys: SecondFactorKeys;
};

/**
 * What a right email and password lead to: a session (`personId`), or, for a person with a second
 * factor, the second step (`secondStep`, the ways they can take it). Either way `setCookie` holds
 * what the browser keeps: the session cookie, or the cookie that ties the second step to it.
 */
export type SignInResult =
	| { personId: string; secondStep: null; setCookie: string[] }
	| { personId: null; secondStep: { methods: SecondStepMethod[] }; setCookie: string[] };

/** How a person proves who they are again, for Sensitive actions: their password, authenticator app or a passkey. */
export type IdentityProof = { password: string } | { authenticatorCode: string } | { passkey: AssertionCredential };

/** Registration options for `navigator.credentials.create`, as JSON. */
export type PasskeyCreationOptions = ReturnType<typeof creationOptions>;

/** Options for `navigator.credentials.get`, as JSON. */
export type PasskeyRequestOptions = ReturnType<typeof requestOptions>;

/** A signed-in session, as WebCraft sees it. */
export type Session = {
	id: string;
	personId: string;
	startedAt: Date;
	lastActiveAt: Date;
	/**
	 * When the person last proved who they are in this session: signing in, or confirming their
	 * password since (later: a passkey or 2FA code). Sensitive actions need it to be recent.
	 */
	identityCheckedAt: Date | null;
};

/** What auth needs to know about a request: its headers (the session cookie) and where it came from. */
export type AuthRequest = {
	headers: Headers;
	/** The address of the client, as the web process saw it; null when it can't tell. */
	clientAddress: string | null;
};

/** A session in the person's list of sessions: where it was last used from, and from which browser. */
export type SessionDetails = Session & {
	/** The client address it was last renewed from (or signed in from), if known. */
	clientAddress: string | null;
	/** The `User-Agent` of the browser that signed in, if it sent one. */
	userAgent: string | null;
};

/** The email and password don't match a person. The message never says which one was wrong. */
export class InvalidCredentialsError extends Error {
	override name = "InvalidCredentialsError";
	constructor() {
		super("The email or password is wrong.");
	}
}

/**
 * WebCraft's sign-in interface. The rest of WebCraft signs people in, reads and ends sessions only
 * through it; the library behind it is never imported anywhere else.
 */
export type Auth = {
	/**
	 * Checks an email and password and starts a session. Answers the `Set-Cookie` values that carry
	 * the session; throws `InvalidCredentialsError` when they don't match a person, and also while
	 * the account is locked (and when this wrong password locks it), so the answer never tells which
	 * addresses have an account.
	 */
	signIn(input: { email: string; password: string }, request: AuthRequest): Promise<SignInResult>;
	/**
	 * The second step of signing in, in the browser a right password started it in (within 5
	 * minutes): a code from the person's authenticator app, or one of their backup codes, which is
	 * then used up. Starts the session. Throws `SignInExpiredError` without a waiting sign-in,
	 * `TwoFactorCodeInvalidError` for a wrong code (which counts towards the lockout, like a wrong
	 * password) and `AccountLockedError` when the account is locked (the person knows the password).
	 */
	secondStep(
		input: { method: "authenticator" | "backupCode"; code: string },
		request: AuthRequest,
	): Promise<{ personId: string; method: "authenticator" | "backupCode"; setCookie: string[] }>;
	/**
	 * The session a request carries, or null. A session unused for 7 days, or started more than 30
	 * days ago, has ended: it is deleted and `setCookie` clears the cookie. A session in use is
	 * renewed, so it lasts another 7 days from now, and records the address it was used from.
	 */
	session(request: AuthRequest): Promise<{ session: Session | null; setCookie: string[] }>;
	/**
	 * A session by its id, or null once it has ended: signed out, revoked, unused for 7 days or
	 * started more than 30 days ago. Reading it doesn't renew it. For checks made away from the
	 * admin's own hostname, which never sees the session cookie (Edit mode on a Site's domain).
	 * `sessionId` is an id WebCraft stored, never one a request gave.
	 */
	activeSession(sessionId: string): Promise<Session | null>;
	/** Ends the session a request carries, if any, and answers the `Set-Cookie` values that clear it. */
	signOut(headers: Headers): Promise<{ setCookie: string[] }>;
	/**
	 * Checks the person's password again inside a session they are signed in with, and records the
	 * check on that session alone. Throws `InvalidCredentialsError` when the password is wrong, and
	 * `AccountLockedError` when the account is locked: wrong passwords here count towards the lock too.
	 * (The person is signed in, so saying so tells nobody anything new.)
	 */
	confirmIdentity(
		session: Session,
		proof: IdentityProof,
		request: Pick<AuthRequest, "clientAddress">,
	): Promise<{ identityCheckedAt: Date }>;
	/** The person's sessions that haven't ended, most recently used first. */
	listSessions(personId: string): Promise<SessionDetails[]>;
	/** Ends one of the person's sessions; false when they have no such session. */
	revokeSession(personId: string, sessionId: string): Promise<boolean>;
	/** Ends every session of the person except `keep`, and answers how many it ended. */
	revokeOtherSessions(keep: Session): Promise<number>;
	/**
	 * Changes the person's password and ends every other session of theirs, together. Refuses a
	 * password the rules don't allow with `PasswordRefusedError`, changing nothing. `also` runs in
	 * the same transaction, to record the change with it.
	 */
	changePassword(
		session: Session,
		newPassword: string,
		also?: (tx: Transaction, result: { signedOutSessions: number }) => Promise<void>,
	): Promise<{ signedOutSessions: number }>;
	/** Creates a person who signs in with an email and password, inside the caller's transaction. */
	createPerson(tx: Transaction, person: NewPerson): Promise<{ personId: string }>;

	/** The person's second factors and how many backup codes they have left. */
	secondFactors(personId: string): Promise<SecondFactorSummary>;
	/** Whether the person has a second factor: an authenticator app or a passkey. */
	hasSecondFactor(personId: string): Promise<boolean>;
	/**
	 * Starts adding an authenticator app: a new secret, shown to the person (as text and as the
	 * address in a QR code) and kept until a code from the app confirms it. Throws
	 * `AuthenticatorExistsError` when they have one.
	 */
	startAuthenticator(
		personId: string,
		label: { issuer: string; accountName: string },
	): Promise<{ secret: string; uri: string }>;
	/**
	 * Adds the authenticator app being added once `code` comes from it (`TwoFactorCodeInvalidError`
	 * otherwise), and ends every other session of the person. Answers the backup codes, made when it
	 * is their first second factor (null otherwise). `also` runs in the same transaction.
	 */
	confirmAuthenticator(
		session: Session,
		code: string,
		also?: AlsoInTransaction<FactorChange>,
	): Promise<FactorChange & { backupCodes: string[] | null }>;
	/**
	 * Removes the person's authenticator app and ends their other sessions; their backup codes go
	 * too when it was their last second factor. `also` runs in the same transaction.
	 */
	removeAuthenticator(
		session: Session,
		also?: AlsoInTransaction<FactorChange & { last: boolean }>,
	): Promise<FactorChange & { last: boolean }>;
	/**
	 * Starts adding a passkey: options for the person's device, with the admin's hostname as the
	 * relying party (`rpName` is what the device shows), their passkeys excluded, user verification
	 * required and no attestation asked for.
	 */
	passkeyRegistrationOptions(
		personId: string,
		user: { name: string; displayName: string },
		rpName: string,
	): Promise<PasskeyCreationOptions>;
	/**
	 * Adds the passkey the device made for those options (`PasskeyInvalidError` when its answer
	 * doesn't check out), ends every other session of the person, and answers their backup codes when
	 * it is their first second factor. `also` runs in the same transaction.
	 */
	addPasskey(
		session: Session,
		credential: RegistrationCredential,
		name: string,
		also?: AlsoInTransaction<FactorChange>,
	): Promise<FactorChange & { passkey: PasskeySummary; backupCodes: string[] | null }>;
	/** Removes one of the person's passkeys and ends their other sessions (`SecondFactorNotFoundError` for any other). */
	removePasskey(
		session: Session,
		passkeyId: string,
		also?: AlsoInTransaction<FactorChange & { last: boolean; name: string }>,
	): Promise<FactorChange & { last: boolean; name: string }>;
	/**
	 * Options for signing in with a passkey. After a right password in this browser (the second
	 * step) they list that person's passkeys; otherwise none, and the device offers its own.
	 */
	passkeySignInOptions(request: AuthRequest): Promise<PasskeyRequestOptions>;
	/**
	 * Signs in with a passkey: it counts as both factors, as the device verified the person. Ends a
	 * waiting second step. Throws `PasskeyInvalidError` when the answer doesn't check out (an unknown
	 * passkey, another hostname or page, no user verification, a used challenge, a signature count
	 * that went backwards) and `AccountLockedError` while the account is locked.
	 */
	signInWithPasskey(
		credential: AssertionCredential,
		request: AuthRequest,
	): Promise<{ personId: string; setCookie: string[] }>;
	/** Options for confirming who the person is with one of their passkeys. */
	identityPasskeyOptions(session: Session): Promise<PasskeyRequestOptions>;
	/** Replaces the person's backup codes with 10 new ones, answered once. */
	regenerateBackupCodes(personId: string, also?: AlsoInTransaction<undefined>): Promise<string[]>;
	/**
	 * Removes every second factor of a person (a reset: by the Superadmin, their Staff, or the
	 * server's `reset-2fa` command), ends all their sessions and lifts a lock on their account.
	 */
	resetSecondFactors(
		personId: string,
		also?: AlsoInTransaction<{ authenticator: boolean; passkeys: number; signedOutSessions: number }>,
	): Promise<{ authenticator: boolean; passkeys: number; signedOutSessions: number }>;
};

export function createAuth(options: AuthOptions): Auth {
	const { database, clock, log } = options;
	const library = createLibrary(options);
	const secure = new URL(options.adminOrigin).protocol === "https:";
	const factors = createSecondFactorStore({ database, clock, keys: options.secondFactorKeys });
	const pending = createPendingSignIns({ database, clock, secure });
	const passkeys = createPasskeyStore({ database, clock });
	const adminUrl = new URL(options.adminOrigin);
	const relyingParty = (name = "WebCraft"): RelyingParty => ({ id: adminUrl.hostname, origin: adminUrl.origin, name });

	/** Logs why a passkey was refused (people see one plain message), and refuses it. */
	const refusePasskey = (error: PasskeyInvalidError): never => {
		log.warn("A passkey was refused", { reason: error.reason, during: error.during });
		throw error;
	};

	/**
	 * Checks an assertion: its challenge (given for `purpose`, and to `personId` when it names one),
	 * the stored passkey it names, its signature and count; records the use and answers the passkey.
	 */
	const checkAssertion = async (
		credential: AssertionCredential,
		purpose: "sign-in" | "identity",
		personId: string | null,
	) => {
		const refuse = (reason: string) => refusePasskey(new PasskeyInvalidError(reason, purpose));
		const challenge = challengeOf(credential.response.clientDataJSON);
		if (!challenge) return refuse("no challenge in the client data");
		const given = await passkeys.takeChallenge(challenge, purpose);
		if (!given) return refuse("challenge unknown, used or expired");
		const stored = await passkeys.byCredentialId(credential.rawId);
		if (!stored) return refuse("no such passkey");
		const owner = personId ?? given.personId;
		if ((given.personId && given.personId !== stored.personId) || (owner && owner !== stored.personId)) {
			return refuse("another person's passkey");
		}
		const handle = credential.response.userHandle;
		if (handle && handle !== base64url(new TextEncoder().encode(stored.personId))) return refuse("user handle differs");
		await lockout.assertUnlocked(stored.personId);
		try {
			const use = await verifyAssertion(credential, { challenge, rp: relyingParty(), during: purpose }, stored);
			if (!(await passkeys.recordUse(stored, use))) return refuse("used meanwhile");
		} catch (error) {
			if (error instanceof PasskeyInvalidError) return refusePasskey(error);
			throw error;
		}
		return stored;
	};

	/** Starts a session for a person who proved who they are, recording the address WebCraft saw. */
	const startSession = async (personId: string, { headers, clientAddress }: AuthRequest) => {
		const { headers: answer, response } = await library.api.startSessionFor({
			body: { personId },
			headers,
			returnHeaders: true,
		});
		await database.db.update(sessions).set({ ipAddress: clientAddress }).where(eq(sessions.token, response.token));
		return answer.getSetCookie();
	};
	const lockout = createLockout({
		database,
		clock,
		onLocked: async (lock) => {
			log.warn("An account was locked after too many wrong passwords", {
				personId: lock.personId,
				lockedUntil: lock.lockedUntil,
				clientAddress: lock.clientAddress,
			});
			try {
				await options.onAccountLocked?.(lock);
			} catch (error) {
				log.error("Telling a person their account was locked failed", { error, personId: lock.personId });
			}
		},
	});

	return {
		async signIn({ email, password }, { headers, clientAddress }) {
			const [person] = await database.db
				.select({ id: people.id })
				.from(people)
				.where(eq(people.email, normaliseEmail(email)));
			// While locked, not even the right password gets in. The answer is the same as for a wrong
			// password, and costs a password hash like one, so it never tells which addresses have an
			// account; the person learns of the lock from its email.
			if (person) {
				try {
					await lockout.assertUnlocked(person.id);
				} catch (error) {
					if (!(error instanceof AccountLockedError)) throw error;
					await hashPassword(password);
					throw new InvalidCredentialsError();
				}
			}
			const methods = person ? await factors.secondStepMethods(person.id) : [];
			if (person && methods.length > 0) {
				if (!(await passwordMatches(database, person.id, password))) {
					await lockout.recordFailure(person.id, clientAddress).catch((lockError: unknown) => {
						if (!(lockError instanceof AccountLockedError)) throw lockError;
					});
					throw new InvalidCredentialsError();
				}
				// The count of wrong attempts goes on until the second step is right too, so a guesser who
				// knows the password can't start it again by signing in between wrong codes.
				return { personId: null, secondStep: { methods }, setCookie: [await pending.start(person.id)] };
			}
			try {
				const { headers: answer, response } = await library.api.signInEmail({
					body: { email: email.trim(), password },
					headers,
					returnHeaders: true,
				});
				// The library would read the address from headers any client can send; WebCraft's own is used.
				await database.db.update(sessions).set({ ipAddress: clientAddress }).where(eq(sessions.token, response.token));
				await lockout.recordSuccess(response.user.id);
				return { personId: response.user.id, secondStep: null, setCookie: answer.getSetCookie() };
			} catch (error) {
				if (error instanceof APIError && (error.statusCode === 401 || error.statusCode === 400)) {
					if (person) {
						// The wrong password that locks the account answers like any other.
						await lockout.recordFailure(person.id, clientAddress).catch((lockError: unknown) => {
							if (!(lockError instanceof AccountLockedError)) throw lockError;
						});
					}
					throw new InvalidCredentialsError();
				}
				throw error;
			}
		},

		async secondStep({ method, code }, request) {
			const personId = await pending.personOf(request.headers);
			if (!personId) throw new SignInExpiredError();
			await lockout.assertUnlocked(personId);
			const accepted =
				method === "authenticator"
					? await factors.useAuthenticatorCode(personId, code)
					: await factors.useBackupCode(personId, code);
			if (!accepted) {
				await lockout.recordFailure(personId, request.clientAddress);
				throw new TwoFactorCodeInvalidError("sign-in");
			}
			await lockout.recordSuccess(personId);
			const finished = await pending.finish(request.headers);
			return { personId, method, setCookie: [...(await startSession(personId, request)), finished] };
		},

		async session({ headers, clientAddress }) {
			const { headers: answer, response } = await library.api.getSession({
				headers,
				query: { disableRefresh: true },
				returnHeaders: true,
			});
			if (!response) return { session: null, setCookie: answer.getSetCookie() };
			const session: Session = {
				id: response.session.id,
				// The library names the person's id `userId`; the column is `person_id`.
				personId: response.session.userId,
				startedAt: new Date(response.session.startedAt),
				lastActiveAt: new Date(response.session.lastActiveAt),
				identityCheckedAt: toDate(response.session.identityCheckedAt),
			};
			const now = clock.now();
			const idle = now.getTime() - session.lastActiveAt.getTime();
			const age = now.getTime() - session.startedAt.getTime();
			if (idle >= SESSION_IDLE_LIMIT_MS || age >= SESSION_MAX_AGE_MS) {
				// signOut deletes the session and answers the headers that clear its cookie.
				const ended = await this.signOut(headers);
				log.debug("A session ended", { sessionId: session.id, reason: age >= SESSION_MAX_AGE_MS ? "max-age" : "idle" });
				return { session: null, setCookie: ended.setCookie };
			}
			if (idle >= SESSION_RENEW_AFTER_MS) {
				const renewed = clientAddress ? { lastActiveAt: now, ipAddress: clientAddress } : { lastActiveAt: now };
				await database.db.update(sessions).set(renewed).where(eq(sessions.id, session.id));
				session.lastActiveAt = now;
			}
			return { session, setCookie: answer.getSetCookie() };
		},

		async activeSession(sessionId) {
			const [row] = await database.db.select().from(sessions).where(eq(sessions.id, sessionId));
			if (!row) return null;
			const now = clock.now().getTime();
			if (now - row.lastActiveAt.getTime() >= SESSION_IDLE_LIMIT_MS) return null;
			if (now - row.startedAt.getTime() >= SESSION_MAX_AGE_MS) return null;
			return {
				id: row.id,
				personId: row.personId,
				startedAt: row.startedAt,
				lastActiveAt: row.lastActiveAt,
				identityCheckedAt: row.identityCheckedAt,
			};
		},

		async signOut(headers) {
			const { headers: answer } = await library.api.signOut({ headers, returnHeaders: true });
			return { setCookie: answer.getSetCookie() };
		},

		async confirmIdentity(session, proof, { clientAddress }) {
			await lockout.assertUnlocked(session.personId);
			if ("passkey" in proof) {
				// A passkey can't be guessed, so a refused one doesn't count towards the lockout.
				await checkAssertion(proof.passkey, "identity", session.personId);
			} else if ("password" in proof) {
				if (!(await passwordMatches(database, session.personId, proof.password))) {
					await lockout.recordFailure(session.personId, clientAddress);
					throw new InvalidCredentialsError();
				}
			} else if (!(await factors.useAuthenticatorCode(session.personId, proof.authenticatorCode))) {
				await lockout.recordFailure(session.personId, clientAddress);
				throw new TwoFactorCodeInvalidError("identity");
			}
			await lockout.recordSuccess(session.personId);
			const identityCheckedAt = clock.now();
			await database.db
				.update(sessions)
				.set({ identityCheckedAt })
				.where(and(eq(sessions.id, session.id), eq(sessions.personId, session.personId)));
			return { identityCheckedAt };
		},

		async listSessions(personId) {
			const now = clock.now().getTime();
			const rows = await database.db
				.select()
				.from(sessions)
				.where(
					and(
						eq(sessions.personId, personId),
						gt(sessions.lastActiveAt, new Date(now - SESSION_IDLE_LIMIT_MS)),
						gt(sessions.startedAt, new Date(now - SESSION_MAX_AGE_MS)),
					),
				)
				.orderBy(desc(sessions.lastActiveAt), desc(sessions.startedAt));
			return rows.map((row) => ({
				id: row.id,
				personId: row.personId,
				startedAt: row.startedAt,
				lastActiveAt: row.lastActiveAt,
				identityCheckedAt: row.identityCheckedAt,
				clientAddress: row.ipAddress || null,
				userAgent: row.userAgent || null,
			}));
		},

		async revokeSession(personId, sessionId) {
			const ended = await database.db
				.delete(sessions)
				.where(and(eq(sessions.id, sessionId), eq(sessions.personId, personId)))
				.returning({ id: sessions.id });
			return ended.length > 0;
		},

		async revokeOtherSessions(keep) {
			const ended = await database.db
				.delete(sessions)
				.where(and(eq(sessions.personId, keep.personId), ne(sessions.id, keep.id)))
				.returning({ id: sessions.id });
			return ended.length;
		},

		async changePassword(session, newPassword, also) {
			await assertNewPasswordAllowed(newPassword, options.passwordChecks);
			const hash = await hashPassword(newPassword);
			const now = clock.now();
			return database.db.transaction(async (tx) => {
				const changed = await tx
					.update(credentials)
					.set({ password: hash, updatedAt: now })
					.where(and(eq(credentials.personId, session.personId), eq(credentials.providerId, PASSWORD_PROVIDER)))
					.returning({ id: credentials.id });
				if (changed.length === 0) {
					await tx.insert(credentials).values({
						personId: session.personId,
						accountId: session.personId,
						providerId: PASSWORD_PROVIDER,
						password: hash,
						createdAt: now,
						updatedAt: now,
					});
				}
				const ended = await tx
					.delete(sessions)
					.where(and(eq(sessions.personId, session.personId), ne(sessions.id, session.id)))
					.returning({ id: sessions.id });
				const result = { signedOutSessions: ended.length };
				await also?.(tx, result);
				return result;
			});
		},

		createPerson(tx, person) {
			return createPerson(tx, person, { now: clock.now(), passwordChecks: options.passwordChecks });
		},

		secondFactors: (personId) => factors.summary(personId),
		hasSecondFactor: (personId) => factors.isOn(personId),
		startAuthenticator: (personId, label) => factors.startAuthenticator(personId, label),
		confirmAuthenticator: (session, code, also) =>
			factors.confirmAuthenticator(session.personId, session.id, code, also),
		removeAuthenticator: (session, also) => factors.removeAuthenticator(session.personId, session.id, also),
		regenerateBackupCodes: (personId, also) => factors.regenerateBackupCodes(personId, also),
		resetSecondFactors: (personId, also) => factors.reset(personId, also),

		async passkeyRegistrationOptions(personId, user, rpName) {
			const challenge = await passkeys.newChallenge("register", personId);
			return creationOptions(
				relyingParty(rpName),
				{ id: personId, ...user },
				challenge,
				await passkeys.ofPerson(personId),
			);
		},

		async addPasskey(session, credential, name, also) {
			const challenge = challengeOf(credential.response?.clientDataJSON ?? "");
			const given = challenge ? await passkeys.takeChallenge(challenge, "register") : null;
			if (!challenge || !given || given.personId !== session.personId) {
				return refusePasskey(new PasskeyInvalidError("challenge unknown, used, expired or another person's", "setup"));
			}
			let verified: Awaited<ReturnType<typeof verifyRegistration>>;
			try {
				verified = await verifyRegistration(credential, { challenge, rp: relyingParty() });
			} catch (error) {
				if (error instanceof PasskeyInvalidError) return refusePasskey(error);
				throw error;
			}
			return factors.addPasskey(session.personId, session.id, { ...verified, name }, also);
		},

		removePasskey: (session, passkeyId, also) => factors.removePasskey(session.personId, session.id, passkeyId, also),

		async passkeySignInOptions({ headers }) {
			const personId = await pending.personOf(headers);
			const challenge = await passkeys.newChallenge("sign-in", personId);
			return requestOptions(relyingParty(), challenge, personId ? await passkeys.ofPerson(personId) : []);
		},

		async signInWithPasskey(credential, request) {
			const waiting = await pending.personOf(request.headers);
			const stored = await checkAssertion(credential, "sign-in", waiting);
			await lockout.recordSuccess(stored.personId);
			const finished = await pending.finish(request.headers);
			return { personId: stored.personId, setCookie: [...(await startSession(stored.personId, request)), finished] };
		},

		async identityPasskeyOptions(session) {
			const challenge = await passkeys.newChallenge("identity", session.personId);
			return requestOptions(relyingParty(), challenge, await passkeys.ofPerson(session.personId));
		},
	};
}

/**
 * WebCraft's own endpoint in the sign-in library, called only from this file (the library's HTTP
 * endpoints are never served): starts a session for a person who already proved who they are, such
 * as after the second step of signing in, with the library's own session cookie.
 */
const sessionStarter = {
	id: "webcraft-sessions",
	endpoints: {
		startSessionFor: createAuthEndpoint.serverOnly(
			{ method: "POST", body: z.object({ personId: z.string() }) },
			async (ctx) => {
				const user = await ctx.context.internalAdapter.findUserById(ctx.body.personId);
				if (!user) throw new APIError("BAD_REQUEST", { message: "No such person." });
				const session = await ctx.context.internalAdapter.createSession(user.id);
				if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "The session was not saved." });
				await setSessionCookie(ctx, { session, user });
				return { token: session.token };
			},
		),
	},
} satisfies BetterAuthPlugin;

/** Whether `password` is the person's password. People without one never match. */
async function passwordMatches(database: Database, personId: string, password: string): Promise<boolean> {
	const [credential] = await database.db
		.select({ hash: credentials.password })
		.from(credentials)
		.where(and(eq(credentials.personId, personId), eq(credentials.providerId, PASSWORD_PROVIDER)));
	if (!credential?.hash) return false;
	return verifyPassword(credential.hash, password);
}

function toDate(value: unknown): Date | null {
	if (value === null || value === undefined) return null;
	const date = new Date(value as string | number | Date);
	return Number.isNaN(date.getTime()) ? null : date;
}

function createLibrary({ database, clock, adminOrigin, secret, log }: AuthOptions) {
	const origin = new URL(adminOrigin).origin;
	const secure = origin.startsWith("https:");
	const now = () => clock.now();

	return betterAuth({
		appName: "WebCraft",
		baseURL: origin,
		secret,
		trustedOrigins: [origin],
		database: drizzleAdapter(database.db, {
			provider: "pg",
			schema: { people, sessions, credentials, verifications },
		}),
		user: { modelName: "people" },
		session: {
			modelName: "sessions",
			fields: { userId: "personId" },
			// WebCraft's own rules (7 days unused, 30 days at most) are applied by `Auth.session` with
			// WebCraft's clock. The library's own expiry is the 30-day cap, and it never extends it.
			expiresIn: SESSION_MAX_AGE_MS / 1000,
			disableSessionRefresh: true,
			additionalFields: {
				startedAt: { type: "date", required: true, input: false, defaultValue: now },
				lastActiveAt: { type: "date", required: true, input: false, defaultValue: now },
				// Every session starts with a sign-in, which checks who the person is.
				identityCheckedAt: { type: "date", required: false, input: false, defaultValue: now },
			},
		},
		account: { modelName: "credentials", fields: { userId: "personId" } },
		verification: { modelName: "verifications" },
		emailAndPassword: {
			enabled: true,
			// People are created by WebCraft (the setup wizard, invites), never by signing up.
			disableSignUp: true,
			minPasswordLength: MIN_PASSWORD_LENGTH,
			maxPasswordLength: MAX_PASSWORD_LENGTH,
			password: {
				hash: hashPassword,
				verify: ({ hash, password }) => verifyPassword(hash, password),
			},
		},
		advanced: {
			cookiePrefix: "webcraft",
			useSecureCookies: secure,
			database: { generateId: "uuid" },
			defaultCookieAttributes: { sameSite: "lax", httpOnly: true, secure },
			// Sessions record the client address WebCraft itself saw (see `signIn`), never a header.
			ipAddress: { disableIpTracking: true },
		},
		plugins: [sessionStarter],
		// Rate limits and lockout are WebCraft's own, on its own endpoints.
		rateLimit: { enabled: false },
		telemetry: { enabled: false },
		logger: {
			log: (level, message, ...args) => {
				const fields = args.length > 0 ? { details: args } : undefined;
				if (level === "error") log.error(`Sign-in library: ${message}`, fields);
				else if (level === "warn") log.warn(`Sign-in library: ${message}`, fields);
				else log.debug(`Sign-in library: ${message}`, fields);
			},
		},
	});
}
