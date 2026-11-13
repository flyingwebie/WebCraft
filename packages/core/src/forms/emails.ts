import {
	canRoute,
	FORM_ATTACHMENTS_MAX_BYTES,
	FORM_EMAIL_LIMITS,
	type FormAutoReply,
	type FormEmails,
	type FormField,
	type FormNotification,
	type FormRoute,
	type FormText,
	noFormEmails,
} from "@webcraft/renderer";

import type { ContentProblem } from "../content/errors.ts";
import { mailAddress } from "../email/site-mail.ts";
import { readText } from "./definition.ts";

/**
 * Reading a Form's emails (its Notifications and its Auto-reply) as people send them: each part given
 * (`notifications`, `autoReply`) replaces that part of the Draft, and the whole is checked against the
 * Form's fields (its Draft's): routing reads a choice field and its options, the Auto-reply an email
 * field. Every address is one valid address; subjects are one line.
 */

/** A change to a Form's emails Draft: the parts given replace those of the Draft. */
export type FormEmailsInput = { notifications?: unknown; autoReply?: unknown; attachmentsMaxBytes?: unknown };

/** Stored emails, read back (null: none set yet). They are checked before they are stored. */
export function storedFormEmails(stored: unknown): FormEmails {
	const empty = noFormEmails();
	if (!stored || typeof stored !== "object") return empty;
	const raw = stored as Partial<FormEmails>;
	return {
		notifications: Array.isArray(raw.notifications) ? raw.notifications : [],
		autoReply: { ...empty.autoReply, ...raw.autoReply },
		attachmentsMaxBytes:
			typeof raw.attachmentsMaxBytes === "number" ? raw.attachmentsMaxBytes : empty.attachmentsMaxBytes,
	};
}

type Report = (at: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a change over `current`, checking it against `fields` (the Form's Draft fields). Problems go
 * to `problems`, each where it is (`notifications[0].recipients[1]`, `autoReply.field`); the emails
 * answered mean something only when there are none.
 */
export function readFormEmails(
	input: FormEmailsInput,
	current: FormEmails,
	fields: readonly FormField[],
	problems: ContentProblem[],
): FormEmails {
	const report: Report = (at, message) => problems.push({ at, message });
	const notifications =
		input.notifications === undefined ? current.notifications : readNotifications(input.notifications, fields, report);
	const autoReply = input.autoReply === undefined ? current.autoReply : readAutoReply(input.autoReply, fields, report);
	let attachmentsMaxBytes = current.attachmentsMaxBytes;
	if (input.attachmentsMaxBytes !== undefined) {
		const value = input.attachmentsMaxBytes;
		if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > FORM_ATTACHMENTS_MAX_BYTES) {
			report(
				"attachmentsMaxBytes",
				`How much Notifications attach, in bytes: from 0 (nothing) to ${FORM_ATTACHMENTS_MAX_BYTES} (25 MB).`,
			);
		} else attachmentsMaxBytes = value;
	}
	return { notifications, autoReply, attachmentsMaxBytes };
}

function readNotifications(input: unknown, fields: readonly FormField[], report: Report): FormNotification[] {
	if (!Array.isArray(input)) {
		report("notifications", "Notifications are a list.");
		return [];
	}
	if (input.length > FORM_EMAIL_LIMITS.notifications) {
		report("notifications", `A Form sends at most ${FORM_EMAIL_LIMITS.notifications} Notifications.`);
	}
	return input
		.slice(0, FORM_EMAIL_LIMITS.notifications)
		.map((raw, index) => readNotification(raw, `notifications[${index}]`, fields, report));
}

function readNotification(raw: unknown, at: string, fields: readonly FormField[], report: Report): FormNotification {
	const notification: FormNotification = { recipients: [], routing: null, subject: "", intro: "" };
	if (!isRecord(raw)) {
		report(at, "A Notification is { recipients, routing, subject, intro }.");
		return notification;
	}
	for (const key of Object.keys(raw)) {
		if (!["recipients", "routing", "subject", "intro"].includes(key))
			report(`${at}.${key}`, `A Notification has no ${key}.`);
	}
	notification.recipients = readAddresses(raw.recipients ?? [], `${at}.recipients`, report);
	if (raw.routing !== undefined && raw.routing !== null) {
		notification.routing = readRouting(raw.routing, `${at}.routing`, fields, report);
	}
	notification.subject = readLine(raw.subject, `${at}.subject`, FORM_EMAIL_LIMITS.subjectLength, report);
	notification.intro = readParagraphs(raw.intro, `${at}.intro`, FORM_EMAIL_LIMITS.introLength, report);
	const routed = notification.routing?.routes.some((route) => route.recipients.length > 0) ?? false;
	if (notification.recipients.length === 0 && !routed) {
		report(`${at}.recipients`, "Give at least one address: who gets it when routing picks nobody.");
	}
	return notification;
}

function readRouting(
	raw: unknown,
	at: string,
	fields: readonly FormField[],
	report: Report,
): FormNotification["routing"] {
	if (!isRecord(raw) || typeof raw.field !== "string" || !Array.isArray(raw.routes)) {
		report(at, "Routing is { field, routes }: a choice field's key and a list of { value, recipients }.");
		return null;
	}
	const field = fields.find((candidate) => candidate.key === raw.field);
	if (!field || !canRoute(field)) {
		report(`${at}.field`, "Routing reads a select or radio field of this Form.");
		return null;
	}
	const values = new Set(field.options.map((option) => option.value));
	const seen = new Set<string>();
	const routes: FormRoute[] = [];
	raw.routes.forEach((route: unknown, index: number) => {
		const where = `${at}.routes[${index}]`;
		if (!isRecord(route) || typeof route.value !== "string") {
			report(where, "A route is { value, recipients }.");
			return;
		}
		if (!values.has(route.value)) {
			report(`${where}.value`, `${route.value} isn't one of the options of ${field.key}.`);
			return;
		}
		if (seen.has(route.value)) {
			report(`${where}.value`, `${route.value} has a route already.`);
			return;
		}
		seen.add(route.value);
		routes.push({
			value: route.value,
			recipients: readAddresses(route.recipients ?? [], `${where}.recipients`, report),
		});
	});
	return { field: field.key, routes };
}

/** A list of addresses: each one valid, normalised, given once, at most 20. */
function readAddresses(raw: unknown, at: string, report: Report): string[] {
	if (!Array.isArray(raw)) {
		report(at, "Addresses are a list.");
		return [];
	}
	if (raw.length > FORM_EMAIL_LIMITS.recipients) report(at, `At most ${FORM_EMAIL_LIMITS.recipients} addresses.`);
	const addresses: string[] = [];
	raw.slice(0, FORM_EMAIL_LIMITS.recipients).forEach((value: unknown, index: number) => {
		const address = mailAddress(value);
		if (address === null) {
			report(`${at}[${index}]`, `${String(value).slice(0, 100)} isn't an email address, such as name@example.com.`);
			return;
		}
		if (!addresses.includes(address)) addresses.push(address);
	});
	return addresses;
}

function readAutoReply(raw: unknown, fields: readonly FormField[], report: Report): FormAutoReply {
	const autoReply = noFormEmails().autoReply;
	if (!isRecord(raw)) {
		report("autoReply", "The Auto-reply is { enabled, field, subject, text }.");
		return autoReply;
	}
	for (const key of Object.keys(raw)) {
		if (!["enabled", "field", "subject", "text"].includes(key))
			report(`autoReply.${key}`, `The Auto-reply has no ${key}.`);
	}
	autoReply.enabled = raw.enabled === true;
	if (raw.field !== undefined && raw.field !== null) {
		if (typeof raw.field !== "string" || !fields.some((field) => field.key === raw.field && field.type === "email")) {
			report("autoReply.field", "The Auto-reply goes to an email field of this Form.");
		} else autoReply.field = raw.field;
	}
	const subject = readText(raw.subject, "autoReply.subject", report, {
		required: autoReply.enabled,
		max: FORM_EMAIL_LIMITS.subjectLength,
	});
	const text = readText(raw.text, "autoReply.text", report, {
		required: autoReply.enabled,
		max: FORM_EMAIL_LIMITS.autoReplyTextLength,
	});
	if (subject && !isOneLine(subject)) report("autoReply.subject", "A subject is one line.");
	autoReply.subject = subject ?? { text: "" };
	autoReply.text = text ?? { text: "" };
	if (autoReply.enabled && autoReply.field === null && !fields.some((field) => field.type === "email")) {
		report("autoReply.field", "Add an email field to the Form first: the Auto-reply goes to the address given there.");
	}
	return autoReply;
}

function isOneLine(text: FormText): boolean {
	return [text.text, ...Object.values(text.translations ?? {})].every((value) => !/[\r\n]/.test(value));
}

/** One line of text, at most `max` characters; empty when not given. */
function readLine(raw: unknown, at: string, max: number, report: Report): string {
	if (raw === undefined || raw === null) return "";
	if (typeof raw !== "string") {
		report(at, "It is text.");
		return "";
	}
	const text = raw.trim();
	if (/[\r\n]/.test(text)) report(at, "A subject is one line.");
	if (text.length > max) report(at, `At most ${max} characters.`);
	return text;
}

/** Text that may hold paragraphs (separated by a blank line), at most `max` characters. */
function readParagraphs(raw: unknown, at: string, max: number, report: Report): string {
	if (raw === undefined || raw === null) return "";
	if (typeof raw !== "string") {
		report(at, "It is text.");
		return "";
	}
	const text = raw.replace(/\r\n?/g, "\n").trim();
	if (text.length > max) report(at, `At most ${max} characters.`);
	return text;
}
