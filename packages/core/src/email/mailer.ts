/** How a connection to an SMTP server is secured. */
export type SmtpSecurity = "starttls" | "tls" | "none";

/**
 * One SMTP server, as a send needs it: where it is, and how to sign in. The password is filled in
 * from the secrets just for the send, and must never be kept, logged or put in a job.
 */
export type SmtpConnection = {
	host: string;
	port: number;
	security: SmtpSecurity;
	username: string | null;
	password: string | null;
	/**
	 * The address to connect to, when the sender checked where `host` resolves (a Site's own server):
	 * the Mailer connects there, never resolving the name again, and `host` stays the name TLS asks for
	 * and checks the certificate against. Absent, the Mailer resolves `host` itself.
	 */
	connectTo?: string;
};

/** A file sent with an email, such as a Report's PDF. */
export type EmailAttachment = { filename: string; contentType: string; content: Uint8Array };

/**
 * What a queued email names to attach, resolved when it is sent (never the file itself in a job):
 * `kind` says whose it is (`reportPdf`), `id` which one, in its Workspace (and Site).
 */
export type EmailAttachmentRef = {
	kind: string;
	id: string;
	workspaceId: string;
	siteId: string | null;
	filename: string;
};

/** One email, ready to send: rendered, addressed, with its sender. */
export type OutgoingEmail = {
	from: { name: string; address: string };
	to: string;
	replyTo?: string;
	subject: string;
	text: string;
	html: string;
	/** Extra headers, such as `Auto-Submitted`. */
	headers?: Record<string, string>;
	/**
	 * The `Message-ID`, the same for every attempt at one email: if an attempt is sent twice (the
	 * server took it, but recording that failed), mail clients can drop the copy.
	 */
	messageId?: string;
	/** Files sent with it. */
	attachments?: EmailAttachment[];
};

/** The server took the email: its answer, such as `250 2.0.0 OK queued`. */
export type MailerReceipt = { response: string };

/**
 * Sends email over SMTP: the edge every email leaves WebCraft through. Only the email sender in
 * `email/` calls it; features send System emails with `services.email.send`. Tests replace it with
 * a fake that keeps what would have been sent.
 */
export type Mailer = {
	/** Sends one email through `smtp`. Rejects with `SmtpDeliveryError` when it doesn't go through. */
	send(email: OutgoingEmail, smtp: SmtpConnection): Promise<MailerReceipt>;
};

/**
 * An email didn't go through: the server refused it, or couldn't be reached. `response` is the
 * server's answer (or what went wrong, such as a timeout), for the Email log; it never holds the
 * password.
 */
export class SmtpDeliveryError extends Error {
	override name = "SmtpDeliveryError";
	readonly response: string;
	/**
	 * The server refused the recipient's address for good (a 5xx answer to `RCPT TO`, such as
	 * `550 No such user`). Trying again won't help, and it says nothing about the server itself.
	 */
	readonly recipientRejected: boolean;
	/**
	 * Whether `response` is a mail server's own SMTP reply (three digits first, such as
	 * `535 Authentication failed`). Otherwise nothing answered as a mail server: the connection or TLS
	 * failed, it timed out, or whatever is there said something else.
	 */
	readonly replied: boolean;

	constructor(response: string, options: { recipientRejected?: boolean; cause?: unknown } = {}) {
		super(`The email was not sent: ${response}`, { cause: options.cause });
		this.response = response;
		this.recipientRejected = options.recipientRejected ?? false;
		this.replied = /^\d{3}(?:[ -]|$)/.test(response);
	}
}
