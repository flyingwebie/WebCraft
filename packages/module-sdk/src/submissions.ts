import type { ModuleContext } from "./context.ts";
import type { FormSender } from "./events.ts";

/**
 * Form Submissions (GLOSSARY.md), as the Module that keeps them receives them (SDK 1.2). WebCraft
 * renders a Site's Forms and answers what visitors send to them itself: it checks the post, runs the
 * spam checks and the Form's rules, and only then hands each Submission to the one Module that keeps
 * Submissions where it runs (the Forms Module). Where no such Module runs, Forms render nothing.
 *
 * Receiving is inline, before the visitor gets an answer, so a Submission is never lost: a receiver
 * that fails makes the visitor's post fail (and goes to the Module log). Once it is kept (and isn't
 * spam), WebCraft sends what a kept Submission sets off, as retried jobs: the Form's Notifications and
 * Auto-reply (its emails, Content in the Form), its "Form submitted" Webhooks and the `form.submitted`
 * event. The Module tells WebCraft of a Submission it takes out of the Spam folder with
 * `context.submissions.kept` (SDK 1.6), and reads what went out for one with `deliveries`.
 */

/** Why WebCraft put a Submission in the Spam folder; null for one that passed every check. */
export type SpamReason =
	/** The field people never see was filled in. */
	| "honeypot"
	/** It was sent sooner after the page loaded than a person could fill it in. */
	| "too-fast"
	/** It came without the token the Form's page gives, or with a forged one. */
	| "token"
	/** One address sent the Form more often than its limits allow. */
	| "rate-limit"
	/** The post was larger than any Form takes; its values were not read. */
	| "size"
	/** The Site's CAPTCHA couldn't be checked when it came. */
	| "captcha";

/** One value of a Submission, with the field's label (in the Site's Default language) and type when it came. */
export type SubmissionValue = {
	key: string;
	label: string;
	type: string;
	/** Text; a list for checkboxes; a number; true or false for a consent; null when left empty. */
	value: string | string[] | number | boolean | null;
};

/** One Submission: a filled-in Form as WebCraft received it. Plain JSON, apart from the date. */
export type FormSubmission = {
	formId: string;
	formKey: string;
	formName: string;
	/** The language the visitor filled it in (the page's language), a BCP 47 tag. */
	language: string;
	/** The path of the page it was sent from, such as `/contact`; null when the post didn't say. */
	page: string | null;
	/** Null for a Submission that passed every spam check; else why it is spam. */
	spam: SpamReason | null;
	/** The Form's fields in order, with what was sent (for spam, as sent, unchecked). */
	values: SubmissionValue[];
	receivedAt: Date;
	/**
	 * What WebCraft knew of the visitor who sent it (SDK 1.6), as `form.submitted` tells it: never the
	 * address. Keep it with the Submission to hand it back with `kept` (a Submission taken out of spam).
	 */
	sender: FormSender;
};

/**
 * A Submission the Module keeps, as it hands it back to WebCraft (SDK 1.6): its id and what it
 * received, with the sender it kept (null when it has none, as for Submissions kept before SDK 1.6).
 */
export type KeptSubmission = Omit<FormSubmission, "sender"> & { id: string; sender: FormSender | null };

/**
 * One email or Webhook call WebCraft sent for a Submission (SDK 1.6), as its delivery log shows it:
 * a Notification or the Auto-reply to an address, or a "Form submitted" Webhook call (`to` is the
 * Webhook's name). Kept as long as the Email log (90 days) and the Webhooks' delivery log (30 days).
 */
export type SubmissionDelivery = {
	kind: "notification" | "autoReply" | "webhook";
	id: string;
	to: string;
	/** `logged`: no SMTP was set, so the email was written to the log instead. */
	status: "queued" | "retrying" | "sent" | "failed" | "logged";
	attempts: number;
	/** Why the last attempt failed: the mail server's answer, or what went wrong with the call. */
	problem: string | null;
	/** When the next attempt is due, while it is queued or retrying. */
	nextAttemptAt: Date | null;
	/** When it was queued. */
	at: Date;
};

/**
 * What the Module keeping Submissions asks of WebCraft about them (SDK 1.6, `context.submissions`):
 * refused (`ModuleRefusedError`, `submissions`) for any other Module, and outside a Site.
 */
export type ModuleSubmissions = {
	/**
	 * A Submission the Module kept is kept for good now, out of the Spam folder (Not spam): WebCraft
	 * sends what a kept Submission sets off, as for one that was never spam: the Form's Notifications,
	 * its Auto-reply (only within `AUTO_REPLY_WINDOW_HOURS` of when it came, so a visitor isn't thanked
	 * days later), its "Form submitted" Webhooks, and `form.submitted` (when its sender is known).
	 */
	kept(submission: KeptSubmission): Promise<void>;
	/** What WebCraft sent for a Submission: its emails and Webhook calls, oldest first. */
	deliveries(submissionId: string): Promise<SubmissionDelivery[]>;
};

/** How long after a Submission came its Auto-reply still goes when it is taken out of spam, in hours. */
export const AUTO_REPLY_WINDOW_HOURS = 24;

/** How a Module keeps Submissions. At most one Module of a build may declare it. */
export type SubmissionReceiver = {
	/** Stores one Submission at the context's Site and answers its id. */
	receive(submission: FormSubmission, context: ModuleContext): Promise<{ id: string }>;
};

/** Declares a Module's Submission receiver. */
export function submissionReceiver(receiver: SubmissionReceiver): SubmissionReceiver {
	return receiver;
}

/**
 * One of a Module's jobs, run on a schedule in every place where the Module runs (each Site for a
 * Site-level Module): hourly, or daily. The job takes an empty payload (`{}`).
 */
export type ModuleSchedule = { job: string; every: "hour" | "day" };
