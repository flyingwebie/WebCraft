import type { Database } from "@webcraft/db";

import type { AdminLanguageCode } from "../admin-languages.ts";

import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import type { InstallSettings } from "../install-settings.ts";
import type { JobQueue } from "../jobs/define.ts";
import type { Logger } from "../log.ts";
import type { Secrets } from "../secrets/store.ts";
import type { DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { siteOwners, siteStaff } from "../tenancy/site-owners.ts";
import { createInstallBranding, type InstallBranding } from "./branding.ts";
import { createEmailLog, type EmailLog } from "./email-log.ts";
import {
	checkSettings,
	createInstallSmtp,
	INSTALL_SMTP_PASSWORD,
	type InstallSmtp,
	type SmtpHealth,
	SmtpPasswordNeededError,
	sameSmtpServer,
} from "./install-smtp.ts";
import type { Mailer } from "./mailer.ts";
import { attemptDelivery, type EmailAttempt, siteSmtpPassword } from "./outbox.ts";
import { createEmailPreferences, type EmailPreferences } from "./preferences.ts";
import { queueSiteMail, type SiteMail, type SiteMailRoute, siteMailRoute } from "./site-mail.ts";
import {
	checkSiteSmtp,
	readSiteSmtp,
	type SiteSmtpChange,
	type SiteSmtpSettings,
	siteSmtpHealth,
	updateSiteSmtp,
} from "./site-smtp.ts";
import { createSystemEmailSender, type SystemEmailSender, type TestEmailResult } from "./system-emails.ts";

/**
 * Email: the System email sender, the Install SMTP, Install branding and the Email log. Every email
 * WebCraft sends goes through here; nothing else calls the Mailer.
 */
export type Email = {
	/**
	 * Sends a System email: pick the type, the recipients and the data. It is rendered in each
	 * recipient's Admin language under Install branding, recorded in the Email log and queued for
	 * the worker, which sends it through the Install SMTP and retries it for about 24 hours.
	 */
	send: SystemEmailSender["send"];
	/** Sends a test email at once through SMTP settings that may not be saved yet. */
	sendTest: SystemEmailSender["sendTest"];
	/** The Install SMTP: the mail server every System email goes through. */
	installSmtp: InstallSmtp;
	/** Install branding: sender name, logo, accent colour and footer of every System email. */
	branding: InstallBranding;
	/** The Email log: every email the Install sent, never its body, kept 90 days. */
	emailLog: EmailLog;
	/** Each person's switches for work and alert emails; security emails always go. */
	preferences: EmailPreferences;
	/**
	 * A Site's email settings and its own mail server (its Site SMTP): Site settings, Structure (open
	 * the Site with `structure.edit`). Changing them is a Sensitive action (`siteSmtp.change`).
	 */
	siteSmtp: SiteSmtp;
	/** For the worker: one attempt to send a queued email (the `email.send` job). */
	deliver(attempt: EmailAttempt): Promise<void>;
	/** A Site's mail (Notifications, Auto-replies): how it goes out, and queuing one email. */
	siteMail: {
		route(scope: Pick<SiteScope, "first" | "site">): Promise<SiteMailRoute>;
		queue(
			site: { id: string },
			route: SiteMailRoute,
			mail: SiteMail,
		): Promise<{ emailId: string; status: "queued" | "logged" }>;
	};
};

/** A Site's email settings, behind `services.email.siteSmtp`. */
export type SiteSmtp = {
	read(scope: SiteScope): Promise<SiteSmtpSettings>;
	/** `not-set` while the Site has no server of its own; else `working` or `failing`. */
	health(scope: SiteScope): Promise<SmtpHealth>;
	update(scope: SiteScope, change: SiteSmtpChange): Promise<SiteSmtpSettings>;
	/**
	 * Sends a test email at once as the Site's mail would go with the settings given (which may not be
	 * saved yet): through the server given (its stored password unless one is typed), or through the
	 * Install SMTP under the Site's name when no server is given. Doesn't count towards Failing.
	 */
	sendTest(
		scope: SiteScope,
		test: { to: string; settings: SiteSmtpChange; personId: string; language: AdminLanguageCode },
	): Promise<Pick<TestEmailResult, "status" | "response">>;
};

export type EmailOptions = {
	database: Database;
	/** Every secret: the Install SMTP's password, and a Site's own server's. */
	secrets: Secrets;
	jobs: JobQueue;
	mailer: Mailer;
	clock: Clock;
	log: Logger;
	config: InstallConfig;
	settings: InstallSettings;
	/** The data layer, for a Site's mail settings and who to tell when its server fails. */
	data: DataLayer;
};

export function createEmail(options: EmailOptions): Email {
	const branding = createInstallBranding(options.database);
	// A Site's own server that becomes Failing is told to the Site's Owners and Staff, through the
	// Install SMTP (a System email): an email about it would go through it.
	const ports = {
		...options,
		onFailing: async (smtp: string, lastResponse: string) => {
			if (!smtp.startsWith("site:")) return;
			const scope = await options.data.background(smtp.slice("site:".length));
			if (!scope) return;
			const people = [...new Set([...(await siteOwners(scope)), ...(await siteStaff(scope))])];
			if (people.length === 0) return;
			await sender.send({
				type: "site-smtp-failing",
				to: people.map((personId) => ({ personId })),
				data: {
					siteName: scope.site.name,
					lastResponse: lastResponse.slice(0, 1000),
					settingsPath: `/sites/${scope.site.id}/email`,
				},
				related: { kind: "site-smtp", id: scope.site.id },
			});
		},
	};
	const sender = createSystemEmailSender({ ...ports, branding });
	const installSmtp = createInstallSmtp(options);
	return {
		send: sender.send,
		async sendTest(test) {
			// The stored password goes only to the server it was saved for (`SmtpPasswordNeededError`).
			if (test.password === undefined) {
				const stored = await installSmtp.read();
				if (stored?.password.set && !sameSmtpServer(stored, checkSettings(test.smtp))) {
					throw new SmtpPasswordNeededError();
				}
			}
			return sender.sendTest(test);
		},
		installSmtp,
		branding,
		emailLog: createEmailLog(options),
		preferences: createEmailPreferences(options),
		siteSmtp: {
			read: readSiteSmtp,
			health: siteSmtpHealth,
			update: updateSiteSmtp,
			async sendTest(scope, test) {
				const checked = checkSiteSmtp(test.settings);
				const fromName = checked.fromName ?? scope.site.name;
				const typed = test.settings.server?.password ?? undefined;
				if (checked.server) {
					// The stored password goes only to the server it was saved for (`SmtpPasswordNeededError`).
					if (typed === undefined) {
						const stored = (await readSiteSmtp(scope)).server;
						if (stored?.password.set && !sameSmtpServer(stored, checked.server)) throw new SmtpPasswordNeededError();
					}
					return sender.sendTest({
						to: test.to,
						language: test.language,
						smtp: { ...checked.server, replyTo: null },
						password: typed,
						personId: test.personId,
						site: {
							id: scope.site.id,
							fromName,
							replyTo: checked.replyTo,
							smtp: "site",
							password: siteSmtpPassword(scope.site),
						},
					});
				}
				const install = await installSmtp.read();
				if (!install) {
					return {
						status: "failed",
						response: "The Install SMTP isn't set: the Site's mail would be written to the log.",
					};
				}
				return sender.sendTest({
					to: test.to,
					language: test.language,
					smtp: install,
					personId: test.personId,
					site: {
						id: scope.site.id,
						fromName,
						replyTo: checked.replyTo,
						smtp: "install",
						password: INSTALL_SMTP_PASSWORD,
					},
				});
			},
		},
		deliver: (attempt) => attemptDelivery(ports, attempt),
		siteMail: {
			route: siteMailRoute,
			queue: (site, route, mail) => queueSiteMail(ports, site, route, mail),
		},
	};
}

export {
	DEFAULT_ACCENT_COLOUR,
	FOOTER_MAX_LENGTH,
	type InstallBranding,
	type InstallBrandingValues,
	isAccentColour,
	isLogoUrl,
	LOGO_URL_MAX_LENGTH,
	SENDER_NAME_MAX_LENGTH,
} from "./branding.ts";
export {
	canTurnOff,
	categoryOf,
	EMAIL_CATEGORIES,
	type EmailCategory,
	isSystemEmailType,
	SYSTEM_EMAIL_TYPE_IDS,
	SYSTEM_EMAIL_TYPES,
	type SystemEmailData,
	type SystemEmailType,
} from "./catalogue.ts";
export {
	EMAIL_LOG_RETENTION_DAYS,
	EMAIL_STATUSES,
	type EmailLog,
	type EmailLogLine,
	type EmailLogPage,
	type EmailLogSmtp,
	type EmailStatus,
	type RelatedItem,
} from "./email-log.ts";
export {
	FAILING_AFTER,
	type InstallSmtp,
	type InstallSmtpChange,
	type InstallSmtpSettings,
	SMTP_SECURITY,
	type SmtpHealth,
	SmtpPasswordNeededError,
	type SmtpSettings,
} from "./install-smtp.ts";
export { emailLogPurge, emailLogPurgeSchedule } from "./jobs.ts";
export {
	type Mailer,
	type MailerReceipt,
	type OutgoingEmail,
	type SmtpConnection,
	SmtpDeliveryError,
	type SmtpSecurity,
} from "./mailer.ts";
export { emailSend, RETRY_FOR_MS, type SmtpChoice } from "./outbox.ts";
export { EmailAlwaysSentError, type EmailPreferences, type EmailSwitch } from "./preferences.ts";
export { mailAddress, oneLine, type SiteMail, type SiteMailRoute } from "./site-mail.ts";
export {
	SITE_FROM_NAME_MAX_LENGTH,
	type SiteSmtpChange,
	type SiteSmtpServer,
	type SiteSmtpSettings,
} from "./site-smtp.ts";
export { createSmtpMailer } from "./smtp-mailer.ts";
export {
	EMAIL_PREFERENCES_PATH,
	type Recipient,
	type SendResult,
	type SystemEmail,
	type TestEmailResult,
} from "./system-emails.ts";
