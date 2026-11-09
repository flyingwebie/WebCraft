// The Forms Module (ADR 0024): it keeps what visitors send through a Site's Forms. WebCraft builds,
// renders and checks Forms itself (a Form is Structure, `{{@form}}` a Template command, and the post
// path one of the Site's own); once a post passes its checks, WebCraft hands the Submission to this
// Module, which keeps it in the inbox or the Spam folder. Switched off on a Site, Forms render
// nothing there and take no posts. It imports nothing from WebCraft but the Module SDK.
import {
	and,
	defineModule,
	desc,
	eq,
	type FormSubmission,
	job,
	lt,
	procedure,
	submissionReceiver,
	z,
} from "@webcraft/module-sdk";

import { migrations } from "./migrations.ts";
import { submissions } from "./tables.ts";

/** How long the Spam folder keeps a Submission. */
export const SPAM_KEPT_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The most Submissions one list answers. */
const LIST_LIMIT = 200;

type SubmissionRow = typeof submissions.$inferSelect;

/** A Submission as the Module's procedures answer it. */
function view(row: SubmissionRow) {
	return {
		id: row.id,
		formId: row.formId,
		formKey: row.formKey,
		formName: row.formName,
		language: row.language,
		page: row.page,
		folder: row.folder as "inbox" | "spam",
		spamReason: row.spamReason as FormSubmission["spam"],
		values: row.values as FormSubmission["values"],
		receivedAt: row.receivedAt,
	};
}

export const forms = defineModule({
	manifest: {
		id: "forms",
		name: { en: "Forms", it: "Form" },
		description: {
			en: "Keeps what visitors send through each Site's Forms, with a Spam folder kept 30 days. Switched off, a Site's Forms show nothing.",
			it: "Conserva ciò che i visitatori inviano con i Form di ogni Sito, con una cartella Spam tenuta 30 giorni. Se è spento, i Form di un Sito non si vedono.",
		},
		version: "1.0.0",
		sdk: "^1.2.0",
		level: "site",
		onByDefault: true,
		adminLanguages: ["en", "it"],
		permissions: [
			{
				key: "submissions.view",
				label: { en: "Read Form Submissions", it: "Leggere gli invii dei Form" },
				roles: ["staff", "owner", "editor"],
			},
		],
	},
	tables: [submissions],
	migrations,

	formSubmissions: submissionReceiver({
		async receive(submission, context) {
			const row = await context.data.insert(submissions, {
				formId: submission.formId,
				formKey: submission.formKey,
				formName: submission.formName,
				language: submission.language,
				page: submission.page,
				folder: submission.spam === null ? "inbox" : "spam",
				spamReason: submission.spam,
				values: submission.values,
				receivedAt: submission.receivedAt,
			});
			// Module form actions (run inline once a Submission is kept) come in here later.
			return { id: row.id };
		},
	}),

	procedures: {
		submissions: {
			/** A Site's Submissions, newest first: of one Form or all, in the inbox or the Spam folder. */
			list: procedure({
				permission: "submissions.view",
				input: z.object({
					formId: z.uuid().optional(),
					folder: z.enum(["inbox", "spam"]).default("inbox"),
					limit: z.number().int().min(1).max(LIST_LIMIT).default(50),
				}),
				async run(input, context) {
					const where = and(
						eq(submissions.folder, input.folder),
						input.formId === undefined ? undefined : eq(submissions.formId, input.formId),
					);
					const rows = await context.data.select(submissions, where, {
						orderBy: [desc(submissions.receivedAt)],
						limit: input.limit,
					});
					return { submissions: rows.map(view) };
				},
			}),
		},
	},

	jobs: {
		/** Deletes Submissions the Spam folder has kept for 30 days. */
		purgeSpam: job({
			payload: z.object({}),
			async run(_payload, context) {
				const before = new Date(context.now().getTime() - SPAM_KEPT_DAYS * DAY_MS);
				const deleted = await context.data.delete(
					submissions,
					and(eq(submissions.folder, "spam"), lt(submissions.receivedAt, before)),
				);
				if (deleted > 0) await context.log.info("Deleted Submissions the Spam folder kept 30 days.", { deleted });
			},
		}),
	},
	schedules: [{ job: "purgeSpam", every: "day" }],
});

export default forms;
