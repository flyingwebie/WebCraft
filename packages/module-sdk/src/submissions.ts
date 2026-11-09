import type { ModuleContext } from "./context.ts";

/**
 * Form Submissions (GLOSSARY.md), as the Module that keeps them receives them (SDK 1.2). WebCraft
 * renders a Site's Forms and answers what visitors send to them itself: it checks the post, runs the
 * spam checks and the Form's rules, and only then hands each Submission to the one Module that keeps
 * Submissions where it runs (the Forms Module). Where no such Module runs, Forms render nothing.
 *
 * Receiving is inline, before the visitor gets an answer, so a Submission is never lost: a receiver
 * that fails makes the visitor's post fail (and goes to the Module log). Everything a Module does
 * afterwards (emails, Webhooks) belongs in its own jobs.
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
};

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
