import type { Database, Transaction } from "@webcraft/db";
import { credentials, people, sessions, verifications } from "@webcraft/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { and, desc, eq, gt, ne } from "drizzle-orm";

import {
	assertNewPasswordAllowed,
	hashPassword,
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	type PasswordCheck,
	verifyPassword,
} from "./passwords.ts";
import { createPerson, type NewPerson, PASSWORD_PROVIDER } from "./people.ts";

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
};

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
	 * the session; throws `InvalidCredentialsError` when they don't match a person.
	 */
	signIn(
		input: { email: string; password: string },
		request: AuthRequest,
	): Promise<{ personId: string; setCookie: string[] }>;
	/**
	 * The session a request carries, or null. A session unused for 7 days, or started more than 30
	 * days ago, has ended: it is deleted and `setCookie` clears the cookie. A session in use is
	 * renewed, so it lasts another 7 days from now, and records the address it was used from.
	 */
	session(request: AuthRequest): Promise<{ session: Session | null; setCookie: string[] }>;
	/** Ends the session a request carries, if any, and answers the `Set-Cookie` values that clear it. */
	signOut(headers: Headers): Promise<{ setCookie: string[] }>;
	/**
	 * Checks the person's password again inside a session they are signed in with, and records the
	 * check on that session alone. Throws `InvalidCredentialsError` when the password is wrong.
	 */
	confirmIdentity(session: Session, proof: { password: string }): Promise<{ identityCheckedAt: Date }>;
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
};

export function createAuth(options: AuthOptions): Auth {
	const { database, clock, log } = options;
	const library = createLibrary(options);

	return {
		async signIn({ email, password }, { headers, clientAddress }) {
			try {
				const { headers: answer, response } = await library.api.signInEmail({
					body: { email: email.trim(), password },
					headers,
					returnHeaders: true,
				});
				// The library would read the address from headers any client can send; WebCraft's own is used.
				await database.db.update(sessions).set({ ipAddress: clientAddress }).where(eq(sessions.token, response.token));
				return { personId: response.user.id, setCookie: answer.getSetCookie() };
			} catch (error) {
				if (error instanceof APIError && (error.statusCode === 401 || error.statusCode === 400)) {
					throw new InvalidCredentialsError();
				}
				throw error;
			}
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

		async signOut(headers) {
			const { headers: answer } = await library.api.signOut({ headers, returnHeaders: true });
			return { setCookie: answer.getSetCookie() };
		},

		async confirmIdentity(session, { password }) {
			if (!(await passwordMatches(database, session.personId, password))) throw new InvalidCredentialsError();
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
	};
}

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
