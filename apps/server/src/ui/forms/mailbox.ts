import type { ApiClient } from "@webcraft/api";
import type forms from "@webcraft/module-forms";
import type { ModuleApi } from "@webcraft/module-sdk";

/**
 * What the Submissions mailbox shares between its list, its detail and its export: the Forms Module's
 * procedures, a Submission as they answer it, and how a Submission is named and summed up in a row.
 */

/** The Forms Module's procedures, as the admin calls them (`m.forms.…`). */
export function formsApi(api: ApiClient): ModuleApi<typeof forms> {
	return (api as unknown as { m: { forms: ModuleApi<typeof forms> } }).m.forms;
}

export type Listed = Awaited<ReturnType<ModuleApi<typeof forms>["submissions"]["list"]>>;
export type Submission = Listed["submissions"][number];
export type SubmissionValue = Submission["values"][number];
export type Opened = Awaited<ReturnType<ModuleApi<typeof forms>["submissions"]["get"]>>;
export type Folder = "inbox" | "spam";
export type ReadFilter = "all" | "unread";

/** A Form upload as the Submission's procedures answer it: never its bytes, a link to download it. */
export type UploadValue = {
	uploadId: string | null;
	name: string;
	size: number;
	contentType: string;
	url: string | null;
};

/** A file field's uploads, or null for any other value. */
export function filesOf(value: SubmissionValue): UploadValue[] | null {
	const raw = value.value;
	return Array.isArray(raw) && raw.some((item) => typeof item === "object" && item !== null)
		? (raw as unknown as UploadValue[])
		: null;
}

/** Whether files came with a Submission (the clip in its row). */
export function hasFiles(submission: Submission): boolean {
	return submission.values.some((value) => (filesOf(value)?.length ?? 0) > 0);
}

/** A value that is text someone typed, not empty. */
function typed(value: SubmissionValue | undefined): string | null {
	return value && typeof value.value === "string" && value.value.trim() !== "" ? value.value : null;
}

/**
 * The value that says who sent a Submission: its first text field (a name), else its first email
 * address, else its first value at all; undefined when they left them all empty.
 */
export function senderValueOf(submission: Submission): SubmissionValue | undefined {
	return (
		submission.values.find((value) => value.type === "text" && typed(value)) ??
		submission.values.find((value) => value.type === "email" && typed(value)) ??
		submission.values.find((value) => typed(value))
	);
}

/** Who sent a Submission, as its row and its detail name them; null when nothing says. */
export function senderOf(submission: Submission): string | null {
	return typed(senderValueOf(submission));
}

/**
 * The first line of what they wrote, for the row: their first long text, else the first text that
 * isn't who they are, else the page it came from.
 */
export function firstLineOf(submission: Submission): string {
	const sender = senderValueOf(submission);
	const written =
		submission.values.find((value) => value.type === "textarea" && typed(value)) ??
		submission.values.find(
			(value) => value !== sender && value.type !== "email" && value.type !== "hidden" && typed(value),
		);
	const text = typed(written) ?? submission.page ?? "";
	return (
		text
			.split(/\r?\n/)
			.find((line) => line.trim() !== "")
			?.trim() ?? ""
	);
}

/** A size as people read it: `3 KB`, `2.4 MB`. */
export function sizeOf(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The start of a day (UTC), as a number of days since 1970. */
function dayOf(date: Date): number {
	return Math.floor(date.getTime() / 86_400_000);
}

/**
 * When a Submission came, as its row says it (UTC, like every time in the admin): the time today,
 * "Yesterday", "N days ago" within a week, then the day ("10 November"), with its year when it was
 * another year.
 */
export function rowTime(
	value: Date | string,
	now: Date,
	language: string,
	words: { yesterday: string; daysAgo(days: number): string },
): string {
	const date = new Date(value);
	const days = dayOf(now) - dayOf(date);
	if (days <= 0) {
		return new Intl.DateTimeFormat(language, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(date);
	}
	if (days === 1) return words.yesterday;
	if (days < 7) return words.daysAgo(days);
	return new Intl.DateTimeFormat(language, {
		day: "numeric",
		month: "long",
		year: date.getUTCFullYear() === now.getUTCFullYear() ? undefined : "numeric",
		timeZone: "UTC",
	}).format(date);
}

/** When a Submission came, as its detail says it: "13 November, 10:42" (UTC), its year when another. */
export function detailTime(value: Date | string, now: Date, language: string): string {
	const date = new Date(value);
	return new Intl.DateTimeFormat(language, {
		day: "numeric",
		month: "long",
		year: date.getUTCFullYear() === now.getUTCFullYear() ? undefined : "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	}).format(date);
}
