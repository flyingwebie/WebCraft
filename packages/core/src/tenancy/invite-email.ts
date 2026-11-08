import type { AdminLanguageCode } from "../admin-languages.ts";
import type { Mailer } from "../mailer.ts";

/** What a Staff invite email says. */
export type StaffInviteEmail = {
	to: string;
	/** The link that accepts the invite. */
	link: string;
	inviterName: string;
	installName: string;
	/** How many days the link works. */
	days: number;
	language: AdminLanguageCode;
};

const WORDING: Record<AdminLanguageCode, (email: StaffInviteEmail) => { subject: string; lines: string[] }> = {
	en: ({ inviterName, installName, link, days }) => ({
		subject: `Join ${installName} as Staff`,
		lines: [
			`${inviterName} invited you to join ${installName} as Staff.`,
			`Accept the invite to create your account: ${link}`,
			`The link works once, for ${days} days. If you weren't expecting this email, you can ignore it.`,
		],
	}),
	it: ({ inviterName, installName, link, days }) => ({
		subject: `Unisciti a ${installName} come Staff`,
		lines: [
			`${inviterName} ti ha invitato a unirti a ${installName} come Staff.`,
			`Accetta l'invito per creare il tuo account: ${link}`,
			`Il link funziona una sola volta, per ${days} giorni. Se non ti aspettavi questa email, puoi ignorarla.`,
		],
	}),
};

/**
 * Sends a Staff invite through the Mailer, in the Install's default Admin language (the invitee has
 * no language of their own yet). The System email sender, with its layout and Install branding,
 * replaces this plain-text email when Install SMTP arrives.
 */
export async function sendStaffInviteEmail(mailer: Mailer, email: StaffInviteEmail): Promise<void> {
	const { subject, lines } = WORDING[email.language](email);
	await mailer.send({ to: email.to, subject, text: `${lines.join("\n\n")}\n` });
}
