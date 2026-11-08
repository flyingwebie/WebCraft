import nodemailer from "nodemailer";

import { type Mailer, SmtpDeliveryError } from "./mailer.ts";

/** How long a send may wait for the server, in milliseconds. */
const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 30_000;

/**
 * The real Mailer: sends over SMTP with Nodemailer, one connection per email. Web (test emails) and
 * worker (every other email) both use it.
 */
export function createSmtpMailer(): Mailer {
	return {
		async send(email, smtp) {
			const transport = nodemailer.createTransport({
				host: smtp.host,
				port: smtp.port,
				secure: smtp.security === "tls",
				requireTLS: smtp.security === "starttls",
				ignoreTLS: smtp.security === "none",
				auth: smtp.username ? { user: smtp.username, pass: smtp.password ?? "" } : undefined,
				connectionTimeout: CONNECTION_TIMEOUT_MS,
				greetingTimeout: GREETING_TIMEOUT_MS,
				socketTimeout: SOCKET_TIMEOUT_MS,
				// Emails are built from WebCraft's own text: never read files or URLs while sending.
				disableFileAccess: true,
				disableUrlAccess: true,
			});
			try {
				const info = await transport.sendMail({
					from: { name: email.from.name, address: email.from.address },
					to: email.to,
					replyTo: email.replyTo,
					subject: email.subject,
					text: email.text,
					html: email.html,
					headers: email.headers,
					...(email.messageId ? { messageId: email.messageId } : {}),
				});
				return { response: info.response };
			} catch (error) {
				throw deliveryError(error);
			} finally {
				transport.close();
			}
		},
	};
}

type NodemailerError = Error & { code?: string; response?: string; responseCode?: number; command?: string };

/** What went wrong, in the server's words when it answered. */
function deliveryError(error: unknown): SmtpDeliveryError {
	const failure = (error instanceof Error ? error : new Error(String(error))) as NodemailerError;
	const response = failure.response?.trim() || failure.message;
	const recipientRejected =
		failure.command === "RCPT TO" && typeof failure.responseCode === "number" && failure.responseCode >= 500;
	return new SmtpDeliveryError(response, { recipientRejected, cause: failure });
}
