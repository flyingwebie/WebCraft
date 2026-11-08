import type { Database } from "@webcraft/db";

import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import type { InstallSettings } from "../install-settings.ts";
import type { JobQueue } from "../jobs/define.ts";
import type { Logger } from "../log.ts";
import type { Secrets } from "../secrets/store.ts";
import { createInstallBranding, type InstallBranding } from "./branding.ts";
import { createEmailLog, type EmailLog } from "./email-log.ts";
import { createInstallSmtp, type InstallSmtp } from "./install-smtp.ts";
import type { Mailer } from "./mailer.ts";
import { createSystemEmailSender, type SystemEmailSender } from "./system-emails.ts";

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
};

export type EmailOptions = {
	database: Database;
	secrets: Secrets;
	jobs: JobQueue;
	mailer: Mailer;
	clock: Clock;
	log: Logger;
	config: InstallConfig;
	settings: InstallSettings;
};

export function createEmail(options: EmailOptions): Email {
	const branding = createInstallBranding(options.database);
	const sender = createSystemEmailSender({ ...options, branding });
	return {
		send: sender.send,
		sendTest: sender.sendTest,
		installSmtp: createInstallSmtp(options),
		branding,
		emailLog: createEmailLog(options),
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
export { createSmtpMailer } from "./smtp-mailer.ts";
export {
	EMAIL_PREFERENCES_PATH,
	type Recipient,
	type SendResult,
	type SystemEmail,
	type TestEmailResult,
} from "./system-emails.ts";
