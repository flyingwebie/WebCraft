import type { Logger } from "./log.ts";

/** One email WebCraft sends. */
export type OutgoingEmail = {
	to: string;
	subject: string;
	text: string;
	html?: string;
};

/**
 * Sends email. Every email leaves WebCraft through a Mailer, so tests can capture what would be
 * sent. The SMTP adapter arrives with the Install SMTP settings.
 */
export type Mailer = {
	send(email: OutgoingEmail): Promise<void>;
};

/**
 * A Mailer for an Install with no SMTP set yet: it writes each email to the log with a warning
 * instead of sending it, so nothing is lost during setup.
 */
export function createLogMailer(log: Logger): Mailer {
	return {
		async send(email) {
			log.warn("No SMTP is set, so this email was written to the log instead of being sent", {
				email: { to: email.to, subject: email.subject, text: email.text },
			});
		},
	};
}
