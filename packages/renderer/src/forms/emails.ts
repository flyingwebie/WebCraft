/**
 * A Form's emails (GLOSSARY.md: Notification, Auto-reply): what a kept Submission sets off. They are
 * Content, unlike the rest of the Form: Staff, Owners and Editors change them in the Form's emails
 * Draft and publish them. This file imports nothing but the Form's own types, so the admin reads the
 * same rules core checks them against.
 *
 * - A **Notification** goes to the Form's recipients, in the Site's Default language: one email per
 *   address, with its subject, its opening line and the Submission's values. With routing, the value
 *   of a choice field picks the addresses (`Tiered` → the cake baker); a value with no route goes to
 *   the Notification's own recipients. Replies go to the visitor, when the Form has an email field
 *   they filled in.
 * - The **Auto-reply** (off unless switched on) goes back to the visitor, to the address in one of
 *   the Form's email fields, in the language they filled the Form in. It holds only the Form's own
 *   words, never what the visitor typed, so nobody can send other people's text through it.
 */
import type { FormField, FormText } from "./version.ts";

/** Routing: the field whose value picks the addresses, and the addresses of each value. */
export type FormRouting = { field: string; routes: FormRoute[] };

/** One route: a value of the routing field (an option's value) and who gets the Notification for it. */
export type FormRoute = { value: string; recipients: string[] };

/** One Notification. */
export type FormNotification = {
	/** Who gets it when routing picks nobody (or there is no routing). */
	recipients: string[];
	routing: FormRouting | null;
	/** One line; empty for WebCraft's words ("New Submission: <Form>"). */
	subject: string;
	/** The opening text; empty for WebCraft's words ("Someone filled in the Form …"). */
	intro: string;
};

/** The Auto-reply. */
export type FormAutoReply = {
	enabled: boolean;
	/** The email field whose address it goes to; null for the Form's first email field. */
	field: string | null;
	/** Its subject and text, in every language the Site's pages are in (the text as written for others). */
	subject: FormText;
	text: FormText;
};

/** A Form's emails, as its emails Draft and published version hold them. */
export type FormEmails = { notifications: FormNotification[]; autoReply: FormAutoReply };

/** How much a Form's emails hold at most. */
export const FORM_EMAIL_LIMITS = {
	notifications: 10,
	/** Addresses in one list (a Notification's recipients, or one route's). */
	recipients: 20,
	addressLength: 254,
	subjectLength: 200,
	introLength: 2000,
	autoReplyTextLength: 5000,
} as const;

/** A Form's emails before anyone set them: no Notification, the Auto-reply off. */
export function noFormEmails(): FormEmails {
	return { notifications: [], autoReply: { enabled: false, field: null, subject: { text: "" }, text: { text: "" } } };
}

/** The kinds of field routing may read: one choice of a fixed list. */
export const ROUTING_FIELD_TYPES = ["select", "radio"] as const;

/** Whether a field can route a Notification. */
export function canRoute(field: Pick<FormField, "type">): boolean {
	return (ROUTING_FIELD_TYPES as readonly string[]).includes(field.type);
}

/**
 * Who gets a Notification for a Submission: the route of the routing field's value, or the
 * Notification's own recipients when there is no route for it (or no routing).
 */
export function notificationRecipients(
	notification: FormNotification,
	valueAt: (fieldKey: string) => unknown,
): string[] {
	if (notification.routing) {
		const value = valueAt(notification.routing.field);
		const route = notification.routing.routes.find((candidate) => candidate.value === value);
		if (route && route.recipients.length > 0) return route.recipients;
	}
	return notification.recipients;
}

/** The email field an Auto-reply goes to: the one it names, else the Form's first email field. */
export function autoReplyField(autoReply: FormAutoReply, fields: readonly Pick<FormField, "key" | "type">[]) {
	const emails = fields.filter((field) => field.type === "email");
	return autoReply.field === null ? emails[0] : emails.find((field) => field.key === autoReply.field);
}
