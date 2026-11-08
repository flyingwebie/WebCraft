import { assertValidEmail, normaliseEmail } from "@webcraft/auth";
import type { Database } from "@webcraft/db";
import { installSmtp, smtpHealth } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import type { Logger } from "../log.ts";
import type { SecretDescription, Secrets } from "../secrets/store.ts";
import type { SmtpSecurity } from "./mailer.ts";

/** How a connection to an SMTP server is secured. */
export const SMTP_SECURITY = ["starttls", "tls", "none"] as const;

/** The settings of an SMTP server, as people enter them; the password is set apart, as a secret. */
export type SmtpSettings = {
	host: string;
	port: number;
	security: SmtpSecurity;
	/** Who the server signs in as; null for a server that takes mail without signing in. */
	username: string | null;
	/** The address emails are sent from. The sender name comes from the Install branding. */
	fromAddress: string;
	replyTo: string | null;
};

/** The Install SMTP as the admin shows it: its settings, and what can be seen of its password. */
export type InstallSmtpSettings = SmtpSettings & {
	password: SecretDescription;
	updatedAt: Date;
};

/** A change to the Install SMTP. `password`: a new one, null to remove it, absent to keep it. */
export type InstallSmtpChange = SmtpSettings & { password?: string | null };

/**
 * How an SMTP server has been doing:
 * - `not-set`: there is no server; emails are written to the log.
 * - `working`: the last send went through, or fewer than 3 in a row failed.
 * - `failing`: 3 or more sends in a row failed.
 */
export type SmtpHealth = {
	state: "not-set" | "working" | "failing";
	failuresInARow: number;
	failingSince: Date | null;
	lastResponse: string | null;
};

/** How many failed sends in a row make an SMTP server Failing. */
export const FAILING_AFTER = 3;

/** The key of the Install SMTP in the health table and the Email log. */
export const INSTALL_SMTP = "install";

/** The Install SMTP's password: a secret of the Install. */
export const INSTALL_SMTP_PASSWORD = { owner: { kind: "install" }, name: "smtp.password" } as const;

/** The Install SMTP: the mail server every System email goes through. */
export type InstallSmtp = {
	/** Its settings, or null while none are set. */
	read(): Promise<InstallSmtpSettings | null>;
	health(): Promise<SmtpHealth>;
	/**
	 * Sets it, all settings at once. The password goes into the Install's secrets. A server with new
	 * settings starts with a clean record: it is Failing again only after 3 more failed sends.
	 */
	update(change: InstallSmtpChange, personId: string): Promise<InstallSmtpSettings>;
};

type Options = { database: Database; secrets: Secrets; clock: Clock; log: Logger };

export function createInstallSmtp({ database, secrets, clock, log }: Options): InstallSmtp {
	const { db } = database;

	const read = async (): Promise<InstallSmtpSettings | null> => {
		const [row] = await db.select().from(installSmtp).where(eq(installSmtp.id, 1));
		if (!row) return null;
		return {
			host: row.host,
			port: row.port,
			security: row.security as SmtpSecurity,
			username: row.username,
			fromAddress: row.fromAddress,
			replyTo: row.replyTo,
			password: await secrets.describe(INSTALL_SMTP_PASSWORD),
			updatedAt: row.updatedAt,
		};
	};

	return {
		read,

		async health() {
			const [settings] = await db.select({ id: installSmtp.id }).from(installSmtp).where(eq(installSmtp.id, 1));
			const record = await readHealth(database, INSTALL_SMTP);
			if (!settings) return { ...record, state: "not-set" };
			return record;
		},

		async update(change, personId) {
			const settings = checkSettings(change);
			const now = clock.now();
			await db.transaction(async (tx) => {
				await tx
					.insert(installSmtp)
					.values({ id: 1, ...settings, updatedAt: now, updatedBy: personId })
					.onConflictDoUpdate({ target: installSmtp.id, set: { ...settings, updatedAt: now, updatedBy: personId } });
				await tx.delete(smtpHealth).where(eq(smtpHealth.smtp, INSTALL_SMTP));
			});
			if (change.password === null) await secrets.remove(INSTALL_SMTP_PASSWORD);
			else if (change.password !== undefined) await secrets.set(INSTALL_SMTP_PASSWORD, change.password);
			log.info("The Install SMTP was changed", {
				personId,
				smtp: { host: settings.host, port: settings.port, security: settings.security, username: settings.username },
				password: change.password === undefined ? "kept" : change.password === null ? "removed" : "replaced",
			});
			const saved = await read();
			if (!saved) throw new Error("The Install SMTP was not saved.");
			return saved;
		},
	};
}

/** Checks and tidies SMTP settings: trims them and checks the addresses. */
export function checkSettings(settings: SmtpSettings): SmtpSettings {
	const fromAddress = normaliseEmail(settings.fromAddress);
	assertValidEmail(fromAddress);
	const replyTo = settings.replyTo?.trim() ? normaliseEmail(settings.replyTo) : null;
	if (replyTo) assertValidEmail(replyTo);
	return {
		host: settings.host.trim().toLowerCase(),
		port: settings.port,
		security: settings.security,
		username: settings.username?.trim() || null,
		fromAddress,
		replyTo,
	};
}

/** An SMTP server's record of failed sends; a server never recorded is working. */
export async function readHealth(database: Database, smtp: string): Promise<SmtpHealth> {
	const [row] = await database.db.select().from(smtpHealth).where(eq(smtpHealth.smtp, smtp));
	if (!row) return { state: "working", failuresInARow: 0, failingSince: null, lastResponse: null };
	return {
		state: row.failingSince ? "failing" : "working",
		failuresInARow: row.failuresInARow,
		failingSince: row.failingSince,
		lastResponse: row.lastResponse,
	};
}
