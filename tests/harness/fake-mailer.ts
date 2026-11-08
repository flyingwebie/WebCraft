import type { Mailer, OutgoingEmail } from "@webcraft/core";

/** A Mailer that sends nothing and keeps every email, so tests can read what would have gone out. */
export type FakeMailer = Mailer & {
	/** Every email sent so far, oldest first. */
	readonly sent: readonly OutgoingEmail[];
	/** Forgets the emails sent so far. */
	clear(): void;
};

export function createFakeMailer(): FakeMailer {
	const sent: OutgoingEmail[] = [];
	return {
		sent,
		async send(email) {
			sent.push(structuredClone(email));
		},
		clear() {
			sent.length = 0;
		},
	};
}
