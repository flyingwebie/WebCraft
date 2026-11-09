import { emailLog, forms, webhookDeliveries, webhooks } from "@webcraft/db/schema";
import {
	AUTO_REPLY_WINDOW_HOURS,
	type KeptSubmission,
	type SubmissionDelivery,
	type SubmissionValue,
} from "@webcraft/module-sdk";
import {
	autoReplyField,
	type FormEmails,
	type FormEmailWords,
	type FormField,
	type FormVersion,
	fillEmailWords,
	formEmailWords,
	formTextIn,
	notificationRecipients,
} from "@webcraft/renderer";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import { siteLanguages } from "../content/languages.ts";
import type { Email, SiteMail, SiteMailRoute } from "../email/index.ts";
import { mailAddress } from "../email/site-mail.ts";
import { isUuid } from "../ids.ts";
import type { Logger } from "../log.ts";
import type { BackgroundScope, DataLayer, Site } from "../tenancy/data-layer.ts";
import type { Webhooks } from "../webhooks/index.ts";
import { storedFormVersion } from "./definition.ts";
import { storedFormEmails } from "./emails.ts";

/**
 * What a kept Submission sets off (spec story 99), once the Module keeping Submissions has stored it:
 * the Form's Notifications, its Auto-reply and its "Form submitted" Webhooks, each queued as a retried
 * job and listed in the Submission's own delivery log. Spam sets off nothing; a Submission taken out
 * of the Spam folder later sets them off then (its Auto-reply only within a day of when it came).
 *
 * A Notification is written in the Site's Default language: the Form's subject and opening (or
 * WebCraft's words), then each value with its field's label, choices by their labels. Replies go to
 * the visitor, at the first email field they filled in. The Auto-reply goes to the visitor in the
 * language they used, with the Form's words only, never what they typed: an Auto-reply that echoed a
 * visitor's text would let anyone send their words to any address from the Site.
 */

/** How long after a Submission came its Auto-reply still goes when it is taken out of spam (the SDK says it to Modules). */
export const AUTO_REPLY_WINDOW_MS = AUTO_REPLY_WINDOW_HOURS * 60 * 60 * 1000;

/** The Email log's types of a Form's emails. */
export const NOTIFICATION_TYPE = "form-notification";
export const AUTO_REPLY_TYPE = "form-auto-reply";

/** What a Submission is in the Email log and the Webhooks' delivery log. */
const RELATED_KIND = "submission";

export type SubmissionActions = {
	/**
	 * Queues what a kept Submission sets off: its Notifications, its Auto-reply (when `autoReply`) and
	 * its Webhooks. Never throws: what couldn't be queued is logged, and the Submission stays kept.
	 */
	kept(site: Site, submission: KeptSubmission, options: { autoReply: boolean }): Promise<void>;
	/** A Submission's delivery log: its emails and Webhook calls, oldest first. */
	deliveries(site: Site, submissionId: string): Promise<SubmissionDelivery[]>;
};

export type SubmissionActionsDeps = {
	data: DataLayer;
	email: Pick<Email, "siteMail">;
	webhooks: Pick<Webhooks, "queueEvent">;
	clock: Clock;
	log: Logger;
};

export function createSubmissionActions(deps: SubmissionActionsDeps): SubmissionActions {
	return {
		async kept(site, submission, options) {
			const scope = await deps.data.background(site.id);
			if (!scope) return;
			const row = isUuid(submission.formId) ? await scope.first(forms, eq(forms.id, submission.formId)) : undefined;
			const version = row ? storedFormVersion(row.published ?? row.draft) : null;
			const emails = row?.emailsPublished ? storedFormEmails(row.emailsPublished) : null;
			const attempt = async (what: string, work: () => Promise<void>) => {
				try {
					await work();
				} catch (error) {
					deps.log.error(`A Submission's ${what} couldn't be queued`, {
						siteId: site.id,
						formId: submission.formId,
						submissionId: submission.id,
						error,
					});
				}
			};
			if (emails && version) {
				const route = await deps.email.siteMail.route(scope);
				const { defaultLanguage } = await siteLanguages(scope);
				await attempt("Notifications", () =>
					sendNotifications(deps, scope, route, submission, version, emails, defaultLanguage),
				);
				const late = deps.clock.now().getTime() - submission.receivedAt.getTime() > AUTO_REPLY_WINDOW_MS;
				if (options.autoReply && !late) {
					await attempt("Auto-reply", () => sendAutoReply(deps, scope, route, submission, version, emails));
				}
			}
			await attempt("Webhooks", () =>
				deps.webhooks.queueEvent(
					{ siteId: site.id },
					"formSubmitted",
					{
						form: { id: submission.formId, key: submission.formKey, name: submission.formName },
						submission: {
							id: submission.id,
							language: submission.language,
							page: submission.page,
							receivedAt: submission.receivedAt.toISOString(),
							values: submission.values,
						},
					},
					deps.clock.now(),
					{ kind: RELATED_KIND, id: submission.id },
				),
			);
		},

		async deliveries(site, submissionId) {
			const scope = await deps.data.background(site.id);
			if (!scope) return [];
			const emails = await scope.db
				.select()
				.from(emailLog)
				.where(
					and(
						eq(emailLog.siteId, site.id),
						eq(emailLog.relatedKind, RELATED_KIND),
						eq(emailLog.relatedId, submissionId),
						inArray(emailLog.type, [NOTIFICATION_TYPE, AUTO_REPLY_TYPE]),
					),
				)
				.orderBy(asc(emailLog.createdAt), asc(emailLog.id));
			const calls = await scope.select(
				webhookDeliveries,
				and(eq(webhookDeliveries.relatedKind, RELATED_KIND), eq(webhookDeliveries.relatedId, submissionId)),
				{ orderBy: [asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id)] },
			);
			const names = new Map((await scope.select(webhooks)).map((webhook) => [webhook.id, webhook.name]));
			const delivered: SubmissionDelivery[] = [
				...emails.map(
					(line): SubmissionDelivery => ({
						kind: line.type === AUTO_REPLY_TYPE ? "autoReply" : "notification",
						id: line.id,
						to: line.recipient,
						status: line.status as SubmissionDelivery["status"],
						attempts: line.attempts,
						problem: line.status === "sent" ? null : line.lastResponse,
						nextAttemptAt: line.nextAttemptAt,
						at: line.createdAt,
					}),
				),
				...calls.map(
					(call): SubmissionDelivery => ({
						kind: "webhook",
						id: call.id,
						to: names.get(call.webhookId) ?? "",
						status: call.status === "delivered" ? "sent" : (call.status as SubmissionDelivery["status"]),
						attempts: call.attempts,
						problem:
							call.status === "delivered"
								? null
								: call.lastProblem === "status" && call.lastStatusCode !== null
									? `${call.lastStatusCode}`
									: call.lastProblem,
						nextAttemptAt: call.nextAttemptAt,
						at: call.createdAt,
					}),
				),
			];
			// Oldest first; what went out together, in the order it was queued: Notifications, then the
			// Auto-reply, then the Webhooks.
			const rank = { notification: 0, autoReply: 1, webhook: 2 } as const;
			return delivered.sort((a, b) => a.at.getTime() - b.at.getTime() || rank[a.kind] - rank[b.kind]);
		},
	};
}

/** Each Notification, to each of its recipients (one email each), in the Site's Default language. */
async function sendNotifications(
	deps: SubmissionActionsDeps,
	scope: BackgroundScope,
	route: SiteMailRoute,
	submission: KeptSubmission,
	version: FormVersion,
	emails: FormEmails,
	language: string,
): Promise<void> {
	const words = formEmailWords(language);
	const valueAt = (key: string) => submission.values.find((value) => value.key === key)?.value ?? null;
	const visitor = visitorAddress(submission.values);
	const rows = [
		...submission.values.map((value) => ({ label: value.label, value: shown(value, version.fields, language, words) })),
		{ label: words.form, value: submission.formName },
		{ label: words.page, value: submission.page ?? words.empty },
		{ label: words.language, value: submission.language },
		{ label: words.received, value: utc(submission.receivedAt) },
	];
	for (const notification of emails.notifications) {
		const subject =
			notification.subject || fillEmailWords(words.subject, { form: submission.formName, site: scope.site.name });
		const intro =
			notification.intro || fillEmailWords(words.intro, { form: submission.formName, site: scope.site.name });
		for (const recipient of notificationRecipients(notification, valueAt)) {
			const mail: SiteMail = {
				type: NOTIFICATION_TYPE,
				to: recipient,
				...(visitor ? { replyTo: visitor } : {}),
				language,
				subject,
				paragraphs: intro.split(/\n{2,}/),
				rows,
				action: {
					label: words.open,
					path: `/sites/${scope.site.id}/forms/${submission.formId}?tab=submissions&submission=${submission.id}`,
				},
				note: visitor ? fillEmailWords(words.replyHint, { email: visitor }) : null,
				related: { kind: RELATED_KIND, id: submission.id },
			};
			await deps.email.siteMail.queue(scope.site, route, mail);
		}
	}
}

/** The Auto-reply, to the visitor's address in the Form's email field, in the language they used. */
async function sendAutoReply(
	deps: SubmissionActionsDeps,
	scope: BackgroundScope,
	route: SiteMailRoute,
	submission: KeptSubmission,
	version: FormVersion,
	emails: FormEmails,
): Promise<void> {
	const { autoReply } = emails;
	if (!autoReply.enabled) return;
	const field = autoReplyField(autoReply, version.fields);
	const to = field ? mailAddress(submission.values.find((value) => value.key === field.key)?.value) : null;
	if (!to) return;
	const language = submission.language;
	const words = formEmailWords(language);
	await deps.email.siteMail.queue(scope.site, route, {
		type: AUTO_REPLY_TYPE,
		to,
		language,
		subject: formTextIn(autoReply.subject, language),
		paragraphs: formTextIn(autoReply.text, language).split(/\n{2,}/),
		note: fillEmailWords(words.autoReplyFooter, { site: scope.site.name }),
		related: { kind: RELATED_KIND, id: submission.id },
	});
}

/** The address the visitor gave: the first email field they filled in with a valid address. */
function visitorAddress(values: readonly SubmissionValue[]): string | null {
	for (const value of values) {
		if (value.type !== "email") continue;
		const address = mailAddress(value.value);
		if (address) return address;
	}
	return null;
}

/** A value as a Notification shows it: choices by their labels, a consent Yes or No, empty as a dash. */
function shown(value: SubmissionValue, fields: readonly FormField[], language: string, words: FormEmailWords): string {
	const field = fields.find((candidate) => candidate.key === value.key);
	const label = (choice: string) => {
		const option = field?.options.find((candidate) => candidate.value === choice);
		return option ? formTextIn(option.label, language) : choice;
	};
	const raw = value.value;
	if (raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)) return words.empty;
	if (typeof raw === "boolean") return raw ? words.yes : words.no;
	if (Array.isArray(raw)) return raw.map(label).join(", ");
	if (typeof raw === "number") return String(raw);
	return field && field.options.length > 0 ? label(raw) : raw;
}

/** A time as `2026-03-02 09:00 UTC`. */
function utc(date: Date): string {
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
