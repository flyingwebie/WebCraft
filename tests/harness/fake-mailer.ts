import { type Mailer, type OutgoingEmail, type SmtpConnection, SmtpDeliveryError } from "@webcraft/core";

/** An email as the fake SMTP server received it, with the server settings it was sent through. */
export type SentEmail = OutgoingEmail & { smtp: SmtpConnection };

/**
 * A Mailer that sends nothing and keeps every email, so tests can read what would have gone out.
 * It answers like a server that takes every email, until told to fail.
 */
export type FakeMailer = Mailer & {
	/** Every email the server took so far, oldest first. */
	readonly sent: readonly SentEmail[];
	/** Every attempt to send, including the ones that failed, oldest first. */
	readonly attempts: readonly SentEmail[];
	/** Forgets the emails and attempts so far. */
	clear(): void;
	/**
	 * From now on every send fails, as a server answering `response` (such as `421 Try again later`)
	 * or one that can't be reached (`connect ECONNREFUSED`).
	 */
	fail(response: string): void;
	/** From now on the server refuses `address` for good, answering `response`. */
	rejectRecipient(address: string, response?: string): void;
	/** The server takes every email again. */
	accept(): void;
};

/** What the fake server answers when it takes an email. */
export const FAKE_SMTP_RESPONSE = "250 2.0.0 OK: queued";

export function createFakeMailer(): FakeMailer {
	const sent: SentEmail[] = [];
	const attempts: SentEmail[] = [];
	let failure: string | null = null;
	const rejected = new Map<string, string>();
	return {
		sent,
		attempts,
		async send(email, smtp) {
			const copy = { ...structuredClone(email), smtp: { ...smtp } };
			attempts.push(copy);
			if (failure !== null) throw new SmtpDeliveryError(failure);
			const refusal = rejected.get(email.to.toLowerCase());
			if (refusal !== undefined) throw new SmtpDeliveryError(refusal, { recipientRejected: true });
			sent.push(copy);
			return { response: FAKE_SMTP_RESPONSE };
		},
		clear() {
			sent.length = 0;
			attempts.length = 0;
		},
		fail(response) {
			failure = response;
		},
		rejectRecipient(address, response = "550 5.1.1 No such user here") {
			rejected.set(address.toLowerCase(), response);
		},
		accept() {
			failure = null;
			rejected.clear();
		},
	};
}
