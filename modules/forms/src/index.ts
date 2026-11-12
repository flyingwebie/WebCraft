// The Forms Module (ADR 0024): it keeps what visitors send through a Site's Forms. WebCraft builds,
// renders and checks Forms itself (a Form is Structure, `{{@form}}` a Template command, and the post
// path one of the Site's own); once a post passes its checks, WebCraft hands the Submission to this
// Module, which keeps it in the inbox or the Spam folder, and sends what follows a kept Submission
// (its Notifications, Auto-reply and Webhooks). People work through them here: search, read and
// unread, Not spam, delete, CSV export, and how long each Form keeps them. Switched off on a Site,
// Forms render nothing there and take no posts. It imports nothing from WebCraft but the Module SDK.
import {
	and,
	asc,
	count,
	defineModule,
	desc,
	eq,
	type FormSender,
	type FormSubmission,
	ilike,
	inArray,
	isNotNull,
	isNull,
	isSubmissionFiles,
	job,
	type KeptSubmission,
	lt,
	type ModuleContext,
	ModuleError,
	type ProcedureContext,
	procedure,
	type SQL,
	submissionReceiver,
	z,
} from "@webcraft/module-sdk";

import { submissionsCsv } from "./csv.ts";
import { migrations } from "./migrations.ts";
import { retention, submissions } from "./tables.ts";

/** How long the Spam folder keeps a Submission. */
export const SPAM_KEPT_DAYS = 30;

/** The most Submissions a Site's Spam folder keeps: the newest. */
export const MAX_SPAM_KEPT = 1000;
/** How many more it lets in before trimming back, so it isn't trimmed on every post. */
const TRIM_SLACK = 100;

/** How long a Form may keep its Submissions, in days; null keeps them for good. */
export const KEEP_DAYS = [30, 90, 365] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The most Submissions one list answers, one delete takes and one export holds. */
const LIST_LIMIT = 200;
const DELETE_LIMIT = 500;
const EXPORT_LIMIT = 100_000;
/** The most Submissions a purge or a trim deletes in one transaction. */
const REMOVE_BATCH = 500;

type SubmissionRow = typeof submissions.$inferSelect;

/**
 * A Submission's values as its procedures answer them: each kept Form upload with its address in the
 * admin (`url`), where people who may read Submissions download it. Never its bytes.
 */
function withUploadLinks(values: FormSubmission["values"], context: ModuleContext) {
	return values.map((value) =>
		isSubmissionFiles(value.value)
			? {
					...value,
					value: value.value.map((file) => ({
						...file,
						url: file.uploadId ? context.submissions.uploadUrl(file.uploadId) : null,
					})),
				}
			: value,
	);
}

/** A Submission as the Module's procedures answer it. */
function view(row: SubmissionRow, context: ModuleContext) {
	return {
		id: row.id,
		formId: row.formId,
		formKey: row.formKey,
		formName: row.formName,
		language: row.language,
		page: row.page,
		folder: row.folder as "inbox" | "spam",
		spamReason: row.spamReason as FormSubmission["spam"],
		values: withUploadLinks(row.values as FormSubmission["values"], context),
		receivedAt: row.receivedAt,
		read: row.readAt !== null,
	};
}

/** A Submission's values as lower-case text, for search (a file by its name). */
function searchTextOf(values: FormSubmission["values"]): string {
	return values
		.flatMap((value): unknown[] =>
			isSubmissionFiles(value.value)
				? value.value.map((file) => file.name)
				: Array.isArray(value.value)
					? value.value
					: [value.value],
		)
		.filter((value) => value !== null && typeof value !== "boolean")
		.map((value) => String(value))
		.join(" ")
		.toLowerCase();
}

/** `text` as a `LIKE` pattern matching it anywhere, its own `%`, `_` and `\` taken literally. */
function containing(text: string): string {
	return `%${text.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * The ids of the oldest Submissions matching `where`, at most `limit` of them. Only their ids are
 * read (grouped by, so no row's values travel): a Submission can be as large as a post.
 */
async function oldestIds(context: ModuleContext, where: SQL | undefined, limit: number): Promise<string[]> {
	const rows = await context.data.aggregate(submissions, {
		where,
		groupBy: { id: submissions.id, receivedAt: submissions.receivedAt },
		values: { rows: count() },
		orderBy: [asc(submissions.receivedAt), asc(submissions.id)],
		limit,
	});
	return rows.map((row) => row.id);
}

/**
 * Deletes Submissions, and their Form uploads with them: every way a Submission goes (a person
 * deleting it, a Form's retention, the Spam folder's 30 days and its limit) passes through here, so
 * its files never outlive it. Inside a transaction, the files' rows go with it and their bytes once it
 * commits.
 */
async function removeSubmissions(context: ModuleContext, ids: readonly string[]): Promise<number> {
	if (ids.length === 0) return 0;
	await context.submissions.removeUploads(ids);
	return context.data.delete(submissions, inArray(submissions.id, [...ids]));
}

/**
 * Deletes every Submission matching `where`, oldest first, `REMOVE_BATCH` at a time and each batch in
 * a transaction of its own, so a folder of any size goes without ever being held in memory or in one
 * transaction. `each` runs in a batch's transaction with how many it deleted. Answers how many went.
 */
async function purgeSubmissions(
	context: ModuleContext,
	where: SQL | undefined,
	each?: (tx: ModuleContext, deleted: number) => Promise<void>,
): Promise<number> {
	let total = 0;
	for (;;) {
		const batch = await context.transaction(async (tx) => {
			const ids = await oldestIds(tx, where, REMOVE_BATCH);
			const deleted = await removeSubmissions(tx, ids);
			if (deleted > 0) await each?.(tx, deleted);
			return { found: ids.length, deleted };
		});
		total += batch.deleted;
		if (batch.found < REMOVE_BATCH) return total;
	}
}

/**
 * Keeps the Spam folder to the Site's newest `MAX_SPAM_KEPT`: once it is `TRIM_SLACK` past that, the
 * oldest go, at most `REMOVE_BATCH` for each post kept (a folder far over the limit shrinks post by
 * post, and by the daily purge).
 */
async function trimSpam(context: ModuleContext): Promise<void> {
	const spam = eq(submissions.folder, "spam");
	const over = (await context.data.count(submissions, spam)) - MAX_SPAM_KEPT;
	if (over <= TRIM_SLACK) return;
	await removeSubmissions(context, await oldestIds(context, spam, Math.min(over, REMOVE_BATCH)));
}

/** The words of a CSV export's own columns, in the person's Admin language. */
const CSV_WORDS = {
	en: { received: "Received (UTC)", language: "Language", page: "Page", yes: "Yes", no: "No" },
	it: { received: "Ricevuto (UTC)", language: "Lingua", page: "Pagina", yes: "Sì", no: "No" },
} as const;

/** What a list or an export picks: one Form's (or all), in a folder, matching a search, read or not, in a language. */
const filters = z.object({
	formId: z.uuid().optional(),
	folder: z.enum(["inbox", "spam"]).default("inbox"),
	search: z.string().trim().max(200).optional(),
	read: z.enum(["all", "unread", "read"]).default("all"),
	language: z.string().max(35).optional(),
});

function filtered(input: z.infer<typeof filters>): SQL | undefined {
	return and(
		eq(submissions.folder, input.folder),
		input.formId === undefined ? undefined : eq(submissions.formId, input.formId),
		input.search ? ilike(submissions.searchText, containing(input.search)) : undefined,
		input.read === "unread"
			? isNull(submissions.readAt)
			: input.read === "read"
				? isNotNull(submissions.readAt)
				: undefined,
		input.language ? eq(submissions.language, input.language) : undefined,
	);
}

/** The Submission `id` of this Site, or a `submission-not-found` answer. */
async function found(context: ProcedureContext, id: string): Promise<SubmissionRow> {
	const row = await context.data.first(submissions, eq(submissions.id, id));
	if (!row) throw new ModuleError("submission-not-found", "There is no such Submission.", 404);
	return row;
}

/** How long a Form keeps its Submissions, in days; null for forever. */
async function keepDaysOf(context: ModuleContext, formId: string): Promise<number | null> {
	return (await context.data.first(retention, eq(retention.formId, formId)))?.keepDays ?? null;
}

export const forms = defineModule({
	manifest: {
		id: "forms",
		name: { en: "Forms", it: "Form" },
		description: {
			en: "Keeps what visitors send through each Site's Forms, with a Spam folder kept 30 days, sends their Notifications, Auto-replies and Webhooks, and lets people search, export and delete them. Switched off, a Site's Forms show nothing.",
			it: "Conserva ciò che i visitatori inviano con i Form di ogni Sito, con una cartella Spam tenuta 30 giorni, invia notifiche, risposte automatiche e Webhook, e permette di cercarli, esportarli ed eliminarli. Se è spento, i Form di un Sito non si vedono.",
		},
		version: "1.2.0",
		sdk: "^1.11.0",
		level: "site",
		onByDefault: true,
		adminLanguages: ["en", "it"],
		permissions: [
			{
				key: "submissions.view",
				label: { en: "Read and export Form Submissions", it: "Leggere ed esportare gli invii dei Form" },
				roles: ["staff", "owner", "editor"],
			},
			{
				key: "submissions.manage",
				label: {
					en: "Delete Form Submissions, take them out of spam and choose how long they are kept",
					it: "Eliminare gli invii dei Form, toglierli dallo spam e scegliere per quanto tenerli",
				},
				roles: ["staff", "owner", "editor"],
			},
		],
	},
	tables: [submissions, retention],
	migrations,

	formSubmissions: submissionReceiver({
		// Those who read Submissions download their Form uploads, through the admin.
		readPermission: "submissions.view",
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
				sender: submission.sender,
				searchText: searchTextOf(submission.values),
			});
			if (submission.spam !== null) await trimSpam(context);
			// Module form actions (run inline once a Submission is kept) come in here later.
			return { id: row.id };
		},
	}),

	procedures: {
		submissions: {
			/**
			 * A Site's Submissions, newest first, `limit` at a time from `offset`: of one Form or all, in
			 * the inbox or the Spam folder, matching a search in their values, read or unread, in a
			 * language. With how many match in all, the Form's counts, and how long it keeps them.
			 */
			list: procedure({
				permission: "submissions.view",
				toolset: "submissions",
				kind: "read",
				input: filters.extend({
					limit: z.number().int().min(1).max(LIST_LIMIT).default(50),
					offset: z.number().int().min(0).max(1_000_000).default(0),
				}),
				async run(input, context) {
					const where = filtered(input);
					const ofForm = input.formId === undefined ? undefined : eq(submissions.formId, input.formId);
					const [rows, total, inbox, spam, unread] = await Promise.all([
						context.data.select(submissions, where, {
							orderBy: [desc(submissions.receivedAt), desc(submissions.id)],
							limit: input.limit,
							offset: input.offset,
						}),
						context.data.count(submissions, where),
						context.data.count(submissions, and(ofForm, eq(submissions.folder, "inbox"))),
						context.data.count(submissions, and(ofForm, eq(submissions.folder, "spam"))),
						context.data.count(submissions, and(ofForm, eq(submissions.folder, "inbox"), isNull(submissions.readAt))),
					]);
					return {
						submissions: rows.map((row) => view(row, context)),
						total,
						counts: { inbox, spam, unread },
						keepDays: input.formId === undefined ? null : await keepDaysOf(context, input.formId),
					};
				},
			}),

			/** One Submission, with its delivery log: each email and Webhook call sent for it. */
			get: procedure({
				permission: "submissions.view",
				toolset: "submissions",
				kind: "read",
				input: z.object({ id: z.uuid() }),
				async run(input, context) {
					const row = await found(context, input.id);
					return { submission: view(row, context), deliveries: await context.submissions.deliveries(row.id) };
				},
			}),

			/** Marks Submissions read or unread, for everyone who reads them. */
			setRead: procedure({
				permission: "submissions.view",
				toolset: "submissions",
				input: z.object({ ids: z.array(z.uuid()).min(1).max(LIST_LIMIT), read: z.boolean() }),
				async run(input, context) {
					const changed = await context.data.update(
						submissions,
						{ readAt: input.read ? context.now() : null },
						and(
							inArray(submissions.id, input.ids),
							input.read ? isNull(submissions.readAt) : isNotNull(submissions.readAt),
						),
					);
					return { changed: changed.length };
				},
			}),

			/**
			 * Takes a Submission out of the Spam folder: it goes to the inbox, unread, and WebCraft sends
			 * what a kept Submission sends (its Notifications, its Auto-reply while it is still within a
			 * day of when it came, its Webhooks). Recorded in the Audit log.
			 */
			notSpam: procedure({
				permission: "submissions.manage",
				toolset: "submissions",
				input: z.object({ id: z.uuid() }),
				async run(input, context) {
					const row = await found(context, input.id);
					if (row.folder !== "spam")
						throw new ModuleError("not-spam", "This Submission isn't in the Spam folder.", 409);
					const [moved] = await context.transaction(async (tx) => {
						const updated = await tx.data.update(
							submissions,
							{ folder: "inbox", spamReason: null, readAt: null },
							and(eq(submissions.id, row.id), eq(submissions.folder, "spam")),
						);
						if (updated.length > 0) {
							await tx.audit("submissions.notSpam", {
								submissionId: row.id,
								formId: row.formId,
								reason: row.spamReason,
							});
						}
						return updated;
					});
					if (!moved) throw new ModuleError("not-spam", "This Submission isn't in the Spam folder.", 409);
					const kept: KeptSubmission = {
						id: moved.id,
						formId: moved.formId,
						formKey: moved.formKey,
						formName: moved.formName,
						language: moved.language,
						page: moved.page,
						spam: null,
						values: moved.values as FormSubmission["values"],
						receivedAt: moved.receivedAt,
						sender: (moved.sender as FormSender | null) ?? null,
					};
					await context.submissions.kept(kept);
					return { submission: view(moved, context) };
				},
			}),

			/**
			 * Deletes Submissions, in two steps: without `confirmation` it deletes nothing and answers how
			 * many would go, with a confirmation id; with it, they go (and their Form uploads with them).
			 * Recorded in the Audit log.
			 */
			delete: procedure({
				permission: "submissions.manage",
				toolset: "submissions",
				input: z.object({
					ids: z.array(z.uuid()).min(1).max(DELETE_LIMIT),
					confirmation: z.string().max(100).optional(),
				}),
				async run(input, context) {
					const ids = [...new Set(input.ids)].sort();
					const rows = await context.data.select(submissions, inArray(submissions.id, ids));
					const preview = { count: rows.length, ids };
					const target = `submissions:${ids.length}:${ids[0]}`;
					if (input.confirmation === undefined) {
						const confirmation = await context.confirmations.ask("submissions.delete", target, preview);
						return { deleted: false as const, confirmation, preview: { count: rows.length } };
					}
					await context.confirmations.use(input.confirmation, "submissions.delete", target, preview);
					const removed = await context.transaction(async (tx) => {
						const deleted = await removeSubmissions(
							tx,
							rows.map((row) => row.id),
						);
						await tx.audit("submissions.delete", {
							count: deleted,
							formIds: [...new Set(rows.map((row) => row.formId))],
						});
						return deleted;
					});
					return { deleted: true as const, count: removed };
				},
			}),

			/**
			 * One Form's Submissions as a CSV file (UTF-8 with a BOM, formulas made text), newest first,
			 * picked as the list picks them. Recorded in the Audit log.
			 */
			export: procedure({
				permission: "submissions.view",
				toolset: "submissions",
				kind: "read",
				input: filters.extend({ formId: z.uuid() }),
				async run(input, context) {
					const rows = await context.data.select(submissions, filtered(input), {
						orderBy: [desc(submissions.receivedAt), desc(submissions.id)],
						limit: EXPORT_LIMIT,
					});
					const words = context.person.language === "it" ? CSV_WORDS.it : CSV_WORDS.en;
					const csv = submissionsCsv(
						rows.map((row) => ({ ...row, values: row.values as FormSubmission["values"] })),
						words,
					);
					await context.audit("submissions.export", {
						formId: input.formId,
						count: rows.length,
						folder: input.folder,
						filtered: Boolean(input.search || input.language || input.read !== "all"),
					});
					const key = rows[0]?.formKey ?? "form";
					const day = context.now().toISOString().slice(0, 10);
					return { filename: `${key}-submissions-${day}.csv`, csv, count: rows.length };
				},
			}),
		},

		retention: {
			/** How long a Form keeps its Submissions: 30, 90 or 365 days, or null for forever. */
			get: procedure({
				permission: "submissions.view",
				toolset: "forms",
				kind: "read",
				input: z.object({ formId: z.uuid() }),
				async run(input, context) {
					return { keepDays: await keepDaysOf(context, input.formId) };
				},
			}),

			/**
			 * Sets how long a Form keeps its Submissions: older ones are deleted by the daily purge from
			 * then on. Recorded in the Audit log.
			 */
			set: procedure({
				permission: "submissions.manage",
				toolset: "forms",
				input: z.object({
					formId: z.uuid(),
					keepDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
				}),
				async run(input, context) {
					return context.transaction(async (tx) => {
						const before = await keepDaysOf(tx, input.formId);
						if (before === input.keepDays) return { keepDays: before };
						const existing = await tx.data.first(retention, eq(retention.formId, input.formId));
						if (existing) {
							await tx.data.update(
								retention,
								{ keepDays: input.keepDays, updatedAt: tx.now() },
								eq(retention.formId, input.formId),
							);
						} else {
							await tx.data.insert(retention, { formId: input.formId, keepDays: input.keepDays, updatedAt: tx.now() });
						}
						await tx.audit("retention.change", { formId: input.formId, from: before, to: input.keepDays });
						return { keepDays: input.keepDays };
					});
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
				const deleted = await purgeSubmissions(
					context,
					and(eq(submissions.folder, "spam"), lt(submissions.receivedAt, before)),
				);
				if (deleted > 0) await context.log.info("Deleted Submissions the Spam folder kept 30 days.", { deleted });
			},
		}),

		/** Deletes each Form's Submissions older than it keeps them, and says so in the Audit log. */
		purgeExpired: job({
			payload: z.object({}),
			async run(_payload, context) {
				for (const setting of await context.data.select(retention, isNotNull(retention.keepDays))) {
					if (setting.keepDays === null) continue;
					const before = new Date(context.now().getTime() - setting.keepDays * DAY_MS);
					await purgeSubmissions(
						context,
						and(eq(submissions.formId, setting.formId), lt(submissions.receivedAt, before)),
						(tx, deleted) =>
							tx.audit("submissions.purge", { formId: setting.formId, keepDays: setting.keepDays, deleted }),
					);
				}
			},
		}),
	},
	schedules: [
		{ job: "purgeSpam", every: "day" },
		{ job: "purgeExpired", every: "day" },
	],
});

export default forms;
