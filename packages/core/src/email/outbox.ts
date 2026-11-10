import type { Database } from "@webcraft/db";
import { emailLog, installSmtp, siteSmtp, smtpHealth } from "@webcraft/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Clock } from "../clock.ts";
import { defineJob, type JobQueue } from "../jobs/define.ts";
import type { Logger } from "../log.ts";
import type { SecretRef } from "../secrets/refs.ts";
import { SecretNotSetError, type Secrets } from "../secrets/store.ts";
import type { DataLayer } from "../tenancy/data-layer.ts";
import type { EmailLogSmtp, RelatedItem } from "./email-log.ts";
import { FAILING_AFTER, INSTALL_SMTP, INSTALL_SMTP_PASSWORD, type SmtpSettings } from "./install-smtp.ts";
import {
	type EmailAttachment,
	type EmailAttachmentRef,
	type Mailer,
	type MailerReceipt,
	type OutgoingEmail,
	SmtpDeliveryError,
} from "./mailer.ts";

/**
 * Which SMTP server an email goes through, chosen per email. System emails use the Install SMTP; a
 * Site's mail uses the Site's own server when it has one (`{ kind: "site", siteId }`). A Site that went
 * back to the Install SMTP after an email was queued sends it through the Install SMTP. A Site's server
 * that fails never hands its email to the Install SMTP: it is retried, then Failed.
 */
export type SmtpChoice = { kind: "install" } | { kind: "site"; siteId: string };

/** The key of a Site's own server in the health table: `site:<site id>`. */
export function siteSmtpKey(siteId: string): string {
	return `site:${siteId}`;
}

/** A Site's own server's password: a secret of the Site. */
export function siteSmtpPassword(site: { workspaceId: string; id: string }) {
	return { owner: { kind: "site", workspaceId: site.workspaceId, siteId: site.id }, name: "smtp.password" } as const;
}

/** An email ready to go: rendered and addressed, without its From address (that comes from the SMTP). */
export type OutboxEmail = {
	/** The email type, for the Email log. */
	type: string;
	to: string;
	/** The person it goes to, when the recipient has an account. */
	personId: string | null;
	fromName: string;
	subject: string;
	text: string;
	html: string;
	headers: Record<string, string>;
	smtp: SmtpChoice;
	related: RelatedItem | null;
	/** The Site whose mail it is, for the Email log; null for the Install's own emails. */
	siteId?: string | null;
	/**
	 * Where replies go: an address, or null for none. Absent, the SMTP server's reply-to applies (System
	 * emails); a Site's mail always says, so the Install SMTP's reply-to never reaches it.
	 */
	replyTo?: string | null;
	/** Files to send with it, named here and read when it is sent (a Report's PDF). */
	attachments?: readonly EmailAttachmentRef[];
};

export type OutboxPorts = {
	database: Database;
	jobs: JobQueue;
	mailer: Mailer;
	/** Every secret: a send reads only the password of the SMTP it goes through (the Install's or its Site's). */
	secrets: Secrets;
	clock: Clock;
	log: Logger;
	/** The data layer, for a Site's own server: read for the Site the queued email names. */
	data?: DataLayer;
	/** Told once when a server becomes Failing (its third failed send in a row), with its last answer. */
	onFailing?(smtp: string, lastResponse: string): Promise<void>;
	/** Reads a file an email names, when it is sent; null when it is no longer kept. */
	attachment?(ref: EmailAttachmentRef): Promise<EmailAttachment | null>;
};

/** How long a failing email is retried, counted from when it was queued. */
export const RETRY_FOR_MS = 24 * 60 * 60 * 1000;

const MINUTE = 60 * 1000;

/** The wait after the first failed attempt; it doubles after each failure, up to `LONGEST_WAIT_MS`. */
const FIRST_WAIT_MS = MINUTE;
const LONGEST_WAIT_MS = 4 * 60 * MINUTE;

/** When the attempt after `failures` failed ones is due: the backoff, but never past the 24 hours. */
export function nextAttemptAt(queuedAt: Date, failedAt: Date, failures: number): Date | null {
	const giveUpAt = queuedAt.getTime() + RETRY_FOR_MS;
	if (failedAt.getTime() >= giveUpAt) return null;
	const wait = Math.min(FIRST_WAIT_MS * 2 ** Math.max(failures - 1, 0), LONGEST_WAIT_MS);
	return new Date(Math.min(failedAt.getTime() + wait, giveUpAt));
}

/**
 * Records an email in the Email log and queues it for the worker. When its SMTP isn't set, it is
 * written to the log with a warning instead, so nothing is lost while an Install is being set up.
 */
export async function queueEmail(
	ports: OutboxPorts,
	email: OutboxEmail,
): Promise<{ emailId: string; status: "queued" | "logged" }> {
	const { database, clock, jobs } = ports;
	const now = clock.now();
	const smtp = await resolveSmtp(ports, email.smtp);
	const [row] = await database.db
		.insert(emailLog)
		.values({
			createdAt: now,
			type: email.type,
			recipient: email.to,
			personId: email.personId,
			subject: email.subject,
			smtp: smtp ? smtp.label : "none",
			siteId: email.siteId ?? null,
			status: smtp ? "queued" : "logged",
			nextAttemptAt: smtp ? now : null,
			relatedKind: email.related?.kind ?? null,
			relatedId: email.related?.id ?? null,
		})
		.returning({ id: emailLog.id });
	if (!row) throw new Error("The Email log did not take the email.");
	if (!smtp) {
		writeToLog(ports.log, row.id, email);
		return { emailId: row.id, status: "logged" };
	}
	await jobs.send(emailSend, {
		emailId: row.id,
		attempt: 1,
		smtp: email.smtp,
		message: messageOf(email),
	});
	return { emailId: row.id, status: "queued" };
}

const smtpChoice = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("install") }),
	z.object({ kind: z.literal("site"), siteId: z.uuid() }),
]);

const message = z.object({
	type: z.string(),
	to: z.string(),
	fromName: z.string(),
	subject: z.string(),
	text: z.string(),
	html: z.string(),
	headers: z.record(z.string(), z.string()),
	replyTo: z.string().nullable().optional(),
	attachments: z
		.array(
			z.object({
				kind: z.string(),
				id: z.uuid(),
				workspaceId: z.uuid(),
				siteId: z.uuid().nullable(),
				filename: z.string().max(200),
			}),
		)
		.max(5)
		.optional(),
});

type Message = z.infer<typeof message>;

/**
 * One attempt to send one queued email. A failed attempt queues the next one with a growing wait,
 * for about 24 hours; then the email is Failed. Delivery failures are recorded in the Email log, so
 * the job itself completes; it is retried by the queue only when something unexpected breaks.
 * Completed jobs (which hold the email's body) are deleted after an hour.
 */
export const emailSend = defineJob({
	name: "email.send",
	payload: z.object({
		emailId: z.uuid(),
		attempt: z.number().int().min(1),
		smtp: smtpChoice,
		message,
	}),
	queue: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 300, deleteAfterSeconds: 3600 },
	async run(payload, services) {
		await services.email.deliver(payload);
	},
});

export type EmailAttempt = z.infer<typeof emailSend.payload>;

/** One attempt to send one queued email (the `email.send` job). */
export async function attemptDelivery(ports: OutboxPorts, attempt: EmailAttempt): Promise<void> {
	const { database, clock, log } = ports;
	const { db } = database;
	const [row] = await db.select().from(emailLog).where(eq(emailLog.id, attempt.emailId));
	// Already handled (a job that ran twice), or purged: nothing to do.
	if (!row || (row.status !== "queued" && row.status !== "retrying") || row.attempts >= attempt.attempt) return;
	const thisRow = and(eq(emailLog.id, row.id), eq(emailLog.attempts, attempt.attempt - 1));

	const smtp = await resolveSmtp(ports, attempt.smtp);
	if (!smtp) {
		// Its SMTP was removed after the email was queued.
		writeToLog(log, row.id, attempt.message);
		await db.update(emailLog).set({ status: "logged", smtp: "none", nextAttemptAt: null }).where(thisRow);
		return;
	}
	// A Site that went back to the Install SMTP since: the Email log says which server it went through.
	if (row.smtp !== smtp.label) await db.update(emailLog).set({ smtp: smtp.label }).where(thisRow);

	const attemptedAt = clock.now();
	// Files it names are read now; one that is gone fails it, as it would go out half-done.
	const attachments: EmailAttachment[] = [];
	for (const ref of attempt.message.attachments ?? []) {
		const found = ports.attachment ? await ports.attachment(ref) : null;
		if (!found) {
			await db
				.update(emailLog)
				.set({
					status: "failed",
					attempts: attempt.attempt,
					lastResponse: "Its attachment is no longer kept, so it wasn't sent.",
					lastAttemptAt: attemptedAt,
					nextAttemptAt: null,
				})
				.where(thisRow);
			return;
		}
		attachments.push(found);
	}
	// Delivery is at least once: if the server takes the email but recording that fails, the job is
	// retried and sends it again. The Message-ID stays the same, so mail clients can drop the copy.
	const email = {
		...emailOf(attempt.message, smtp.settings),
		messageId: messageIdOf(row.id, smtp.settings),
		...(attachments.length > 0 ? { attachments } : {}),
	};
	const outcome = await send(ports, smtp, email);
	const attempts = attempt.attempt;

	if (outcome.ok) {
		await db
			.update(emailLog)
			.set({
				status: "sent",
				attempts,
				lastResponse: outcome.response,
				lastAttemptAt: attemptedAt,
				nextAttemptAt: null,
			})
			.where(thisRow);
		await recordSuccess(ports, smtp.key);
		return;
	}

	if (outcome.recipientRejected) {
		// The server refused the address for good: retrying won't help, and the server itself works.
		await db
			.update(emailLog)
			.set({
				status: "failed",
				attempts,
				lastResponse: outcome.response,
				lastAttemptAt: attemptedAt,
				nextAttemptAt: null,
			})
			.where(thisRow);
		log.warn("The SMTP server refused an email's recipient, so the email was not sent", {
			emailId: row.id,
			smtp: smtp.key,
			response: outcome.response,
		});
		return;
	}

	const nowFailing = await recordFailure(ports, smtp.key, outcome.response);
	if (nowFailing && ports.onFailing) {
		try {
			await ports.onFailing(smtp.key, outcome.response);
		} catch (error) {
			log.error("Those to tell of a Failing SMTP server couldn't be told", { smtp: smtp.key, error });
		}
	}
	const next = nextAttemptAt(row.createdAt, attemptedAt, attempts);
	if (next) await ports.jobs.send(emailSend, { ...attempt, attempt: attempts + 1 }, { startAfter: next });
	await db
		.update(emailLog)
		.set({
			status: next ? "retrying" : "failed",
			attempts,
			lastResponse: outcome.response,
			lastAttemptAt: attemptedAt,
			nextAttemptAt: next,
		})
		.where(thisRow);
	if (!next) {
		log.warn("An email was not sent after about 24 hours of attempts, so it is Failed", {
			emailId: row.id,
			smtp: smtp.key,
			attempts,
			response: outcome.response,
		});
	}
}

/**
 * An SMTP server, ready for a send: its key (for its health record), the Email log's name for it,
 * its settings and its password.
 */
export type ResolvedSmtp = { key: string; label: EmailLogSmtp; settings: SmtpSettings; password: SecretRef };

/** The server an email goes through now: null when there is none (it is written to the log instead). */
export async function resolveSmtp(
	ports: Pick<OutboxPorts, "database" | "data">,
	choice: SmtpChoice,
): Promise<ResolvedSmtp | null> {
	if (choice.kind === "site") {
		const server = ports.data ? await siteServer(ports.data, choice.siteId) : null;
		if (server) return server;
	}
	const [row] = await ports.database.db.select().from(installSmtp).where(eq(installSmtp.id, 1));
	if (!row) return null;
	const { host, port, username, fromAddress, replyTo } = row;
	const security = row.security as SmtpSettings["security"];
	return {
		key: INSTALL_SMTP,
		label: "install",
		settings: { host, port, security, username, fromAddress, replyTo },
		password: INSTALL_SMTP_PASSWORD,
	};
}

/** A Site's own server, when it has one. */
async function siteServer(data: DataLayer, siteId: string): Promise<ResolvedSmtp | null> {
	const scope = await data.background(siteId);
	const row = scope ? await scope.first(siteSmtp) : undefined;
	if (!scope || !row?.host || row.port === null || !row.security || !row.fromAddress) return null;
	return {
		key: siteSmtpKey(scope.site.id),
		label: "site",
		settings: {
			host: row.host,
			port: row.port,
			security: row.security as SmtpSettings["security"],
			username: row.username,
			fromAddress: row.fromAddress,
			replyTo: row.replyTo,
		},
		password: siteSmtpPassword(scope.site),
	};
}

type Outcome = { ok: true; response: string } | { ok: false; response: string; recipientRejected: boolean };

/**
 * Sends one email through an SMTP server, filling in its password from the secrets just for the
 * send. `password` (a password typed into the admin, for a test email) wins over the stored one.
 * Never throws: what went wrong is in the outcome, in words fit for the Email log.
 */
export async function send(
	ports: Pick<OutboxPorts, "mailer" | "secrets" | "log">,
	smtp: Pick<ResolvedSmtp, "settings" | "password">,
	email: OutgoingEmail,
	typedPassword?: string,
): Promise<Outcome> {
	const { mailer, secrets, log } = ports;
	const { host, port, security, username } = smtp.settings;
	const connection = { host, port, security, username };
	const sendWith = (password: string | null): Promise<MailerReceipt> => mailer.send(email, { ...connection, password });
	try {
		let receipt: MailerReceipt;
		if (!username) receipt = await sendWith(null);
		else if (typedPassword !== undefined) receipt = await sendWith(typedPassword);
		else {
			try {
				receipt = await secrets.useWith(smtp.password, (password) => sendWith(password));
			} catch (error) {
				if (!(error instanceof SecretNotSetError)) throw error;
				receipt = await sendWith(null);
			}
		}
		return { ok: true, response: receipt.response };
	} catch (error) {
		if (error instanceof SmtpDeliveryError) {
			return { ok: false, response: error.response, recipientRejected: error.recipientRejected };
		}
		// Not the server's answer: a password that can't be decrypted, a bug. Logged in full, and
		// recorded as the attempt's answer.
		log.error("An email could not be sent", { error, smtp: { host, port } });
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, response: reason, recipientRejected: false };
	}
}

/**
 * The email as the SMTP server gets it: From comes from the server's settings, and Reply-To from the
 * email when it says (a Site's mail always does), else from the server's settings.
 */
export function emailOf(message: Omit<Message, "type">, settings: SmtpSettings): OutgoingEmail {
	const replyTo = message.replyTo !== undefined ? message.replyTo : settings.replyTo;
	return {
		from: { name: message.fromName, address: settings.fromAddress },
		to: message.to,
		...(replyTo ? { replyTo } : {}),
		subject: message.subject,
		text: message.text,
		html: message.html,
		headers: message.headers,
	};
}

/** One Message-ID per Email log line: `<line id@the sender's domain>`. */
function messageIdOf(emailId: string, settings: SmtpSettings): string {
	const domain = settings.fromAddress.split("@").pop() || "webcraft.invalid";
	return `<${emailId}@${domain}>`;
}

function messageOf(email: OutboxEmail): Message {
	const { type, to, fromName, subject, text, html, headers } = email;
	return {
		type,
		to,
		fromName,
		subject,
		text,
		html,
		headers,
		...(email.replyTo !== undefined ? { replyTo: email.replyTo } : {}),
		...(email.attachments?.length ? { attachments: [...email.attachments] } : {}),
	};
}

function writeToLog(log: Logger, emailId: string, email: { type: string; to: string; subject: string; text: string }) {
	log.warn("No SMTP is set, so this email was written to the log instead of being sent", {
		emailId,
		emailType: email.type,
		email: { to: email.to, subject: email.subject, text: email.text },
	});
}

/** A send went through: the server's record of failures starts again, and it is no longer Failing. */
async function recordSuccess(ports: Pick<OutboxPorts, "database" | "clock" | "log">, smtp: string): Promise<void> {
	const { database, clock, log } = ports;
	const [before] = await database.db
		.select({ failingSince: smtpHealth.failingSince, failuresInARow: smtpHealth.failuresInARow })
		.from(smtpHealth)
		.where(eq(smtpHealth.smtp, smtp));
	if (!before || (before.failuresInARow === 0 && !before.failingSince)) return;
	await database.db
		.update(smtpHealth)
		.set({ failuresInARow: 0, failingSince: null, lastResponse: null, updatedAt: clock.now() })
		.where(eq(smtpHealth.smtp, smtp));
	if (before.failingSince) log.info("The SMTP server works again: it is no longer Failing", { smtp });
}

/**
 * A send failed: one more failure in a row; the third makes the server Failing, which is logged.
 * Answers whether this failure made it Failing.
 */
async function recordFailure(
	ports: Pick<OutboxPorts, "database" | "clock" | "log">,
	smtp: string,
	response: string,
): Promise<boolean> {
	const { database, clock, log } = ports;
	const now = clock.now();
	const [after] = await database.db
		.insert(smtpHealth)
		.values({
			smtp,
			failuresInARow: 1,
			failingSince: FAILING_AFTER <= 1 ? now : null,
			lastResponse: response,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: smtpHealth.smtp,
			set: {
				failuresInARow: sql`${smtpHealth.failuresInARow} + 1`,
				failingSince: sql`case when ${smtpHealth.failingSince} is null and ${smtpHealth.failuresInARow} + 1 >= ${FAILING_AFTER} then ${now.toISOString()}::timestamptz else ${smtpHealth.failingSince} end`,
				lastResponse: response,
				updatedAt: now,
			},
		})
		.returning({ failuresInARow: smtpHealth.failuresInARow, failingSince: smtpHealth.failingSince });
	// The failure that makes it Failing is the one that brings the count to exactly 3.
	if (after?.failuresInARow === FAILING_AFTER) {
		log.error(`The SMTP server is Failing: ${after.failuresInARow} sends in a row failed`, {
			smtp,
			failuresInARow: after.failuresInARow,
			lastResponse: response,
		});
		return true;
	}
	return false;
}
