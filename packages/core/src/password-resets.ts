import { type Auth, normaliseEmail } from "@webcraft/auth";
import type { Database } from "@webcraft/db";
import { passwordResets, people } from "@webcraft/db/schema";
import { and, eq, gt, lte } from "drizzle-orm";
import { z } from "zod";

import { type AuditVia, recordAudit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { Email } from "./email/index.ts";
import { defineJob, type JobQueue } from "./jobs/define.ts";
import type { Logger } from "./log.ts";
import { RateLimitedError, type RateLimitRule, type RateLimits } from "./rate-limits.ts";
import { hashToken, newToken } from "./tokens.ts";

/** How long a reset link works. */
export const PASSWORD_RESET_MS = 30 * 60 * 1000;

/** Reset links one person is sent: at most 3 an hour, however often they are asked for. */
export const PASSWORD_RESET_PERSON_LIMIT: RateLimitRule = { limit: 3, windowMs: 60 * 60 * 1000 };

/** Requests for a reset link from one client address: at most 5 in 15 minutes, whoever they are for. */
export const PASSWORD_RESET_ADDRESS_LIMIT: RateLimitRule = { limit: 5, windowMs: 15 * 60 * 1000 };

/** The command a reset from the server is recorded under. */
const RESET_COMMAND = "reset-password";

/** The reset link doesn't work: unknown, used, replaced by a newer one, or older than 30 minutes. */
export class PasswordResetInvalidError extends Error {
	override name = "PasswordResetInvalidError";
	constructor() {
		super("This reset link doesn't work any more. Ask for a new one.");
	}
}

/**
 * Password recovery (`GLOSSARY.md` › System email): a person who forgot their password asks for a
 * link by email and chooses a new one with it.
 *
 * - Asking never tells whether an address has an account: the request only queues a job, the same
 *   for every address, and the job finds the person and emails them, or does nothing.
 * - The link's token is 32 random bytes; only its hash is kept. It works once, for 30 minutes, and
 *   a newer link replaces it.
 * - Choosing the new password ends every session of the person (`Auth.resetPassword`) and is
 *   recorded. Their second factors stay: the next sign-in still needs one, so a mailbox alone never
 *   opens an account that has two-factor authentication.
 */
export type PasswordResets = {
	/**
	 * Asks for a reset link for whoever signs in with `email`. Throws `RateLimitedError` once the
	 * client address asked too often; otherwise answers nothing, account or not.
	 */
	request(email: string, clientAddress: string | null): Promise<void>;
	/** What the `password-resets.send` job does: emails the person a new link, if there is one to email. */
	send(email: string): Promise<void>;
	/** Until when a link's token works. Throws `PasswordResetInvalidError` when it doesn't. */
	check(token: string): Promise<{ expiresAt: Date }>;
	/** Gives the link's person the new password, ends their sessions and uses the link up. */
	complete(token: string, newPassword: string, via: AuditVia): Promise<{ signedOutSessions: number }>;
	/**
	 * `webcraft admin reset-password <email>`: gives anyone a new password from the server, such as
	 * a Superadmin whose email doesn't arrive. Answers who it was, or null for an unknown address.
	 */
	resetByCommand(email: string, newPassword: string): Promise<{ personId: string; email: string } | null>;
};

export function createPasswordResets({
	database,
	auth,
	clock,
	email,
	jobs,
	rateLimits,
	log,
}: {
	database: Database;
	auth: Auth;
	clock: Clock;
	email: Email;
	jobs: JobQueue;
	rateLimits: RateLimits;
	log: Logger;
}): PasswordResets {
	const { db } = database;

	const find = async (token: string) => {
		const [row] = await db
			.select()
			.from(passwordResets)
			.where(and(eq(passwordResets.tokenHash, await hashToken(token)), gt(passwordResets.expiresAt, clock.now())));
		if (!row) throw new PasswordResetInvalidError();
		return row;
	};

	const personByEmail = async (address: string) => {
		const [person] = await db
			.select({ id: people.id, email: people.email })
			.from(people)
			.where(eq(people.email, normaliseEmail(address)));
		return person ?? null;
	};

	return {
		async request(address, clientAddress) {
			const within = await rateLimits.tally(
				`password-reset:address:${clientAddress ?? "unknown"}`,
				PASSWORD_RESET_ADDRESS_LIMIT,
			);
			if (!within.within) {
				const wait = within.resetsAt.getTime() - clock.now().getTime();
				throw new RateLimitedError(Math.max(1, Math.ceil(wait / 1000)));
			}
			await jobs.send(passwordResetsSend, { email: normaliseEmail(address) });
		},

		async send(address) {
			const now = clock.now();
			// Links past their end are cleared as new ones are asked for, so the table never fills up.
			await db.delete(passwordResets).where(lte(passwordResets.expiresAt, now));
			const person = await personByEmail(address);
			if (!person) return;
			if (!(await rateLimits.count(`password-reset:person:${person.id}`, PASSWORD_RESET_PERSON_LIMIT))) {
				log.warn("A person was asked a reset link for too often: no more are sent this hour", {
					personId: person.id,
				});
				return;
			}
			const token = newToken();
			await db.transaction(async (tx) => {
				await tx.delete(passwordResets).where(eq(passwordResets.personId, person.id));
				await tx.insert(passwordResets).values({
					personId: person.id,
					tokenHash: await hashToken(token),
					expiresAt: new Date(now.getTime() + PASSWORD_RESET_MS),
					createdAt: now,
				});
			});
			await email.send({
				type: "password-reset",
				to: [{ personId: person.id }],
				data: {
					resetPath: `/reset-password?token=${encodeURIComponent(token)}`,
					expiresInMinutes: PASSWORD_RESET_MS / 60_000,
				},
				related: { kind: "person", id: person.id },
			});
		},

		async check(token) {
			return { expiresAt: (await find(token)).expiresAt };
		},

		async complete(token, newPassword, via) {
			const link = await find(token);
			return auth.resetPassword(link.personId, newPassword, async (tx, { signedOutSessions }) => {
				// The link is used up with the change: of two people using it at once, one finds it gone.
				const used = await tx
					.delete(passwordResets)
					.where(and(eq(passwordResets.id, link.id), gt(passwordResets.expiresAt, clock.now())))
					.returning({ id: passwordResets.id });
				if (used.length === 0) throw new PasswordResetInvalidError();
				await recordAudit(tx, clock.now(), {
					personId: link.personId,
					via,
					workspaceId: null,
					siteId: null,
					action: "password.reset",
					details: { by: "email", signedOutSessions },
				});
			});
		},

		async resetByCommand(address, newPassword) {
			const person = await personByEmail(address);
			if (!person) return null;
			await auth.resetPassword(person.id, newPassword, async (tx, { signedOutSessions }) => {
				await tx.delete(passwordResets).where(eq(passwordResets.personId, person.id));
				await recordAudit(tx, clock.now(), {
					personId: null,
					via: { kind: "command", name: RESET_COMMAND },
					workspaceId: null,
					siteId: null,
					action: "password.reset",
					details: { personId: person.id, email: person.email, by: "command", signedOutSessions },
				});
			});
			return { personId: person.id, email: person.email };
		},
	};
}

/**
 * Emails a reset link to whoever signs in with an address, if anyone does. A job, so that asking
 * for a link takes the same time for every address and never tells which ones have an account.
 */
export const passwordResetsSend = defineJob({
	name: "password-resets.send",
	payload: z.object({ email: z.string().max(320) }),
	async run({ email }, { passwordResets }) {
		await passwordResets.send(email);
	},
});
