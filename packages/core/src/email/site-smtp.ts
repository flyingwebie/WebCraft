import { assertValidEmail, normaliseEmail } from "@webcraft/auth";
import { siteSmtp, smtpHealth } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import { actingPerson } from "../permissions/can.ts";
import type { SecretDescription } from "../secrets/store.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { checkSettings, readHealth, type SmtpHealth, type SmtpSettings } from "./install-smtp.ts";
import type { SmtpSecurity } from "./mailer.ts";
import { siteSmtpKey } from "./outbox.ts";

/**
 * A Site's email settings (Site settings, Structure: open the Site with `structure.edit`; saved at
 * once, recorded in the Audit log, never part of Publish all): the sender name and reply-to address of
 * the Site's mail (its Notifications and Auto-replies), and its own mail server, its Site SMTP. Without
 * one, the Site's mail goes through the Install SMTP, under the Site's name (or the sender name set
 * here), with the reply-to set here (never the Install SMTP's). A Site SMTP that fails never hands its
 * mail to the Install SMTP: each email is retried, then Failed, and the Email log says so.
 */

/** The Site's own mail server, as Staff enter it; its password is the Site secret `smtp.password`. */
export type SiteSmtpServer = {
	host: string;
	port: number;
	security: SmtpSecurity;
	username: string | null;
	/** The address the Site's mail is sent from: one the server may send from. */
	fromAddress: string;
};

/** The Site's email settings as the admin shows them. */
export type SiteSmtpSettings = {
	/** The sender name of the Site's mail; null for the Site's name. */
	fromName: string | null;
	/** Where replies go when an email names no one (an Auto-reply); null for nobody (the From address). */
	replyTo: string | null;
	/** Its own server, with what can be seen of the password; null: the Install SMTP. */
	server: (SiteSmtpServer & { password: SecretDescription }) | null;
	/** When they were last changed; null while never set. */
	updatedAt: Date | null;
};

/** A change, all at once. `server.password`: a new one, null to remove it, absent to keep it. */
export type SiteSmtpChange = {
	fromName: string | null;
	replyTo: string | null;
	server: (SiteSmtpServer & { password?: string | null }) | null;
};

/** The name of a Site's own server's password, among the Site's secrets. */
export const SITE_SMTP_PASSWORD = "smtp.password";

/** The longest sender name, in characters. */
export const SITE_FROM_NAME_MAX_LENGTH = 100;

/** The Site's email settings (open the Site with `structure.edit`). */
export async function readSiteSmtp(scope: SiteScope): Promise<SiteSmtpSettings> {
	const row = await scope.first(siteSmtp);
	if (!row) return { fromName: null, replyTo: null, server: null, updatedAt: null };
	const server = serverOf(row);
	return {
		fromName: row.fromName,
		replyTo: row.replyTo,
		server: server ? { ...server, password: await scope.secrets.describe(SITE_SMTP_PASSWORD) } : null,
		updatedAt: row.updatedAt,
	};
}

/**
 * How the Site's own server has been doing: `not-set` while the Site has none (its mail goes through
 * the Install SMTP), else `working` or `failing` (3 sends in a row failed).
 */
export async function siteSmtpHealth(scope: SiteScope): Promise<SmtpHealth> {
	const row = await scope.first(siteSmtp);
	const record = await readHealth({ db: scope.db }, siteSmtpKey(scope.site.id));
	if (!row || !serverOf(row)) return { state: "not-set", failuresInARow: 0, failingSince: null, lastResponse: null };
	return record;
}

/**
 * Changes the Site's email settings, all at once, and records the change in the Audit log (never the
 * password). New server settings start with a clean record. Leaving the server out forgets its
 * password. A Sensitive action (`siteSmtp.change`): check it first.
 */
export async function updateSiteSmtp(scope: SiteScope, change: SiteSmtpChange): Promise<SiteSmtpSettings> {
	const checked = checkSiteSmtp(change);
	const now = scope.now();
	const personId = actingPerson(scope.access.actor);
	const passwordChange =
		checked.server === null
			? "removed"
			: change.server?.password === undefined
				? "kept"
				: change.server.password === null
					? "removed"
					: "replaced";
	const columns = {
		fromName: checked.fromName,
		replyTo: checked.replyTo,
		host: checked.server?.host ?? null,
		port: checked.server?.port ?? null,
		security: checked.server?.security ?? null,
		username: checked.server?.username ?? null,
		fromAddress: checked.server?.fromAddress ?? null,
		updatedAt: now,
		updatedBy: personId,
	};
	await scope.transaction(async (tx) => {
		await tx.db
			.insert(siteSmtp)
			.values({ workspaceId: tx.workspace.id, siteId: tx.site.id, ...columns })
			.onConflictDoUpdate({ target: siteSmtp.siteId, set: columns });
		// New settings start with a clean record.
		await tx.db.delete(smtpHealth).where(eq(smtpHealth.smtp, siteSmtpKey(tx.site.id)));
		await tx.audit("siteSmtp.change", {
			fromName: checked.fromName,
			replyTo: checked.replyTo,
			server: checked.server,
			password: passwordChange,
		});
	});
	if (passwordChange === "removed") await scope.secrets.remove(SITE_SMTP_PASSWORD);
	else if (passwordChange === "replaced" && change.server?.password) {
		await scope.secrets.set(SITE_SMTP_PASSWORD, change.server.password);
	}
	return readSiteSmtp(scope);
}

/** Checks and tidies a change: trims it, checks the addresses and a sender name on one line. */
export function checkSiteSmtp(change: SiteSmtpChange): {
	fromName: string | null;
	replyTo: string | null;
	server: SiteSmtpServer | null;
} {
	const fromName = change.fromName?.trim() || null;
	if (fromName !== null && !isSenderName(fromName)) {
		throw new TypeError(`A sender name is one line of at most ${SITE_FROM_NAME_MAX_LENGTH} characters.`);
	}
	const replyTo = change.replyTo?.trim() ? normaliseEmail(change.replyTo) : null;
	if (replyTo) assertValidEmail(replyTo);
	let server: SiteSmtpServer | null = null;
	if (change.server) {
		const settings: SmtpSettings = checkSettings({
			host: change.server.host,
			port: change.server.port,
			security: change.server.security,
			username: change.server.username,
			fromAddress: change.server.fromAddress,
			replyTo: null,
		});
		server = {
			host: settings.host,
			port: settings.port,
			security: settings.security,
			username: settings.username,
			fromAddress: settings.fromAddress,
		};
	}
	return { fromName, replyTo, server };
}

/** A sender name: one line, no control characters, at most 100 characters. */
export function isSenderName(name: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
	return name.length > 0 && name.length <= SITE_FROM_NAME_MAX_LENGTH && !/[\u0000-\u001f\u007f]/.test(name);
}

function serverOf(row: typeof siteSmtp.$inferSelect): SiteSmtpServer | null {
	if (!row.host || row.port === null || !row.security || !row.fromAddress) return null;
	return {
		host: row.host,
		port: row.port,
		security: row.security as SmtpSecurity,
		username: row.username,
		fromAddress: row.fromAddress,
	};
}
