import type { Database, Transaction } from "@webcraft/db";
import { credentials, people, sessions, verifications } from "@webcraft/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";

import {
	hashPassword,
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	type PasswordCheck,
	verifyPassword,
} from "./passwords.ts";
import { createPerson, type NewPerson } from "./people.ts";

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
		headers: Headers,
	): Promise<{ personId: string; setCookie: string[] }>;
	/**
	 * The session a request carries, or null. A session unused for 7 days, or started more than 30
	 * days ago, has ended: it is deleted and `setCookie` clears the cookie. A session in use is
	 * renewed, so it lasts another 7 days from now.
	 */
	session(headers: Headers): Promise<{ session: Session | null; setCookie: string[] }>;
	/** Ends the session a request carries, if any, and answers the `Set-Cookie` values that clear it. */
	signOut(headers: Headers): Promise<{ setCookie: string[] }>;
	/** Creates a person who signs in with an email and password, inside the caller's transaction. */
	createPerson(tx: Transaction, person: NewPerson): Promise<{ personId: string }>;
};

export function createAuth(options: AuthOptions): Auth {
	const { database, clock, log } = options;
	const library = createLibrary(options);

	return {
		async signIn({ email, password }, headers) {
			try {
				const { headers: answer, response } = await library.api.signInEmail({
					body: { email: email.trim(), password },
					headers,
					returnHeaders: true,
				});
				return { personId: response.user.id, setCookie: answer.getSetCookie() };
			} catch (error) {
				if (error instanceof APIError && (error.statusCode === 401 || error.statusCode === 400)) {
					throw new InvalidCredentialsError();
				}
				throw error;
			}
		},

		async session(headers) {
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
				await database.db.update(sessions).set({ lastActiveAt: now }).where(eq(sessions.id, session.id));
				session.lastActiveAt = now;
			}
			return { session, setCookie: answer.getSetCookie() };
		},

		async signOut(headers) {
			const { headers: answer } = await library.api.signOut({ headers, returnHeaders: true });
			return { setCookie: answer.getSetCookie() };
		},

		createPerson(tx, person) {
			return createPerson(tx, person, { now: clock.now(), passwordChecks: options.passwordChecks });
		},
	};
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
