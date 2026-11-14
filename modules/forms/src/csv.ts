import { isSubmissionFiles, type SubmissionDelivery, type SubmissionValue } from "@webcraft/module-sdk";

/**
 * Submissions as a CSV file for spreadsheets: UTF-8 with a byte order mark (so spreadsheet programs
 * read accents right), every cell quoted, rows ended with CRLF. A cell that starts with `=`, `+`, `-`,
 * `@`, a tab or a carriage return would run as a formula when opened, so it gets a `'` in front and
 * stays text: a visitor's input can never become a formula in someone's spreadsheet. Form uploads
 * show by their names.
 */

/** One Submission, as the file shows it. */
export type CsvSubmission = {
	receivedAt: Date;
	language: string;
	page: string | null;
	values: readonly SubmissionValue[];
	/** What was sent for it, when the file holds the delivery log. */
	deliveries?: readonly SubmissionDelivery[];
};

/** The words of the file's own columns, of yes and no, and of the delivery log, in the reader's language. */
export type CsvWords = {
	received: string;
	language: string;
	page: string;
	yes: string;
	no: string;
	deliveryLog: string;
	/** What each delivery was, before its address or Webhook's name. */
	kinds: Readonly<Record<SubmissionDelivery["kind"], string>>;
	/** Where each delivery stands. */
	statuses: Readonly<Record<SubmissionDelivery["status"], string>>;
};

const BOM = "﻿";

/**
 * Characters that start a formula in spreadsheet programs, their full-width forms too (＝ ＋ － ＠),
 * which programs reading East Asian text take the same way.
 */
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

/** A cell, quoted, its quotes doubled, a formula's start made text. */
export function csvCell(value: string): string {
	const safe = FORMULA_START.test(value) ? `'${value}` : value;
	return `"${safe.replace(/"/g, '""')}"`;
}

/** One delivery, as the delivery log cell says it: "Notification to a@example.com: Sent (Last answer)". */
function deliveryText(delivery: SubmissionDelivery, words: CsvWords): string {
	const problem = delivery.status === "sent" || !delivery.problem ? "" : ` (${delivery.problem})`;
	return `${words.kinds[delivery.kind]} ${delivery.to}: ${words.statuses[delivery.status]}${problem}`;
}

/**
 * The file: the time each came (UTC), its language and page, then one column per field, in the
 * order fields first appear (newest Submissions first), headed by the field's label; with
 * `deliveryLog`, a last column saying what was sent for each, oldest first.
 */
export function submissionsCsv(
	rows: readonly CsvSubmission[],
	words: CsvWords,
	options: { deliveryLog?: boolean } = {},
): string {
	const columns: { key: string; label: string }[] = [];
	for (const row of rows) {
		for (const value of row.values) {
			if (!columns.some((column) => column.key === value.key)) columns.push({ key: value.key, label: value.label });
		}
	}
	const text = (value: SubmissionValue["value"] | undefined): string => {
		if (value === null || value === undefined) return "";
		if (typeof value === "boolean") return value ? words.yes : words.no;
		// A Form upload by its name: its bytes stay in the admin.
		if (isSubmissionFiles(value)) return value.map((file) => file.name).join("; ");
		if (Array.isArray(value)) return value.join("; ");
		return String(value);
	};
	const lines = [
		[
			words.received,
			words.language,
			words.page,
			...columns.map((column) => column.label),
			...(options.deliveryLog ? [words.deliveryLog] : []),
		]
			.map(csvCell)
			.join(","),
		...rows.map((row) =>
			[
				row.receivedAt.toISOString().slice(0, 19).replace("T", " "),
				row.language,
				row.page ?? "",
				...columns.map((column) => text(row.values.find((value) => value.key === column.key)?.value)),
				...(options.deliveryLog
					? [(row.deliveries ?? []).map((delivery) => deliveryText(delivery, words)).join("; ")]
					: []),
			]
				.map(csvCell)
				.join(","),
		),
	];
	return `${BOM}${lines.join("\r\n")}\r\n`;
}
