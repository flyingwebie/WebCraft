import type { Database } from "@webcraft/db";
import { emailLog } from "@webcraft/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";

import type { Clock } from "../clock.ts";

/**
 * Where an email is:
 * - `queued`: waiting for its first attempt.
 * - `retrying`: an attempt failed; another is due.
 * - `sent`: the SMTP server took it.
 * - `failed`: given up, after about 24 hours of attempts or when the server refused the address.
 * - `logged`: written to the log instead, because its SMTP wasn't set.
 */
export const EMAIL_STATUSES = ["queued", "retrying", "sent", "failed", "logged"] as const;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * Which SMTP an email goes through: `install` (the Install SMTP), or `none` when it was written to
 * the log. A Site's SMTP adds its own value.
 */
export type EmailLogSmtp = "install" | "none";

/** What an email is about, for the Email log's link, such as `{ kind: "install-smtp", id: "install" }`. */
export type RelatedItem = { kind: string; id: string };

/** One line of the Email log. Never the email's body. */
export type EmailLogLine = {
	id: string;
	/** When the email was sent off: queued, or written to the log. */
	time: Date;
	type: string;
	recipient: string;
	subject: string;
	smtp: EmailLogSmtp;
	status: EmailStatus;
	attempts: number;
	lastResponse: string | null;
	lastAttemptAt: Date | null;
	nextAttemptAt: Date | null;
	related: RelatedItem | null;
};

/** One page of the Email log, newest first; `next` asks for the page after it. */
export type EmailLogPage = { lines: EmailLogLine[]; next: string | null };

export type EmailLog = {
	/** The Email log, newest first, a page at a time. */
	list(options?: { after?: string | null; limit?: number }): Promise<EmailLogPage>;
	/** Deletes every line older than 90 days, by the clock; answers how many went. */
	purge(): Promise<number>;
};

/** How long Email log lines are kept. */
export const EMAIL_LOG_RETENTION_DAYS = 90;

const DEFAULT_PAGE = 50;
const LONGEST_PAGE = 200;

export function createEmailLog({ database, clock }: { database: Database; clock: Clock }): EmailLog {
	const { db } = database;
	return {
		async list(options = {}) {
			const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE, 1), LONGEST_PAGE);
			const cursor = options.after ? decodeCursor(options.after) : null;
			const rows = await db
				.select()
				.from(emailLog)
				.where(
					cursor
						? or(
								lt(emailLog.createdAt, cursor.time),
								and(eq(emailLog.createdAt, cursor.time), lt(emailLog.id, cursor.id)),
							)
						: undefined,
				)
				.orderBy(desc(emailLog.createdAt), desc(emailLog.id))
				.limit(limit + 1);
			const lines = rows.slice(0, limit).map(lineFromRow);
			const last = lines.at(-1);
			return { lines, next: rows.length > limit && last ? encodeCursor(last) : null };
		},

		async purge() {
			const cutoff = new Date(clock.now().getTime() - EMAIL_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
			const deleted = await db.delete(emailLog).where(lt(emailLog.createdAt, cutoff)).returning({ id: emailLog.id });
			return deleted.length;
		},
	};
}

type Row = typeof emailLog.$inferSelect;

export function lineFromRow(row: Row): EmailLogLine {
	return {
		id: row.id,
		time: row.createdAt,
		type: row.type,
		recipient: row.recipient,
		subject: row.subject,
		smtp: row.smtp as EmailLogSmtp,
		status: row.status as EmailStatus,
		attempts: row.attempts,
		lastResponse: row.lastResponse,
		lastAttemptAt: row.lastAttemptAt,
		nextAttemptAt: row.nextAttemptAt,
		related: row.relatedKind && row.relatedId ? { kind: row.relatedKind, id: row.relatedId } : null,
	};
}

function encodeCursor(line: EmailLogLine): string {
	return Buffer.from(JSON.stringify([line.time.toISOString(), line.id])).toString("base64url");
}

function decodeCursor(cursor: string): { time: Date; id: string } | null {
	try {
		const [time, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [string, string];
		const date = new Date(time);
		if (Number.isNaN(date.getTime()) || typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return null;
		return { time: date, id };
	} catch {
		return null;
	}
}
