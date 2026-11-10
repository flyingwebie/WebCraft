import { isSubmissionFiles, type SubmissionValue } from "@webcraft/module-sdk";

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
};

/** The words of the file's own columns and of yes and no, in the reader's language. */
export type CsvWords = { received: string; language: string; page: string; yes: string; no: string };

const BOM = "﻿";

/** Characters that start a formula in spreadsheet programs. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** A cell, quoted, its quotes doubled, a formula's start made text. */
export function csvCell(value: string): string {
	const safe = FORMULA_START.test(value) ? `'${value}` : value;
	return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * The file: the time each came (UTC), its language and page, then one column per field, in the
 * order fields first appear (newest Submissions first), headed by the field's label.
 */
export function submissionsCsv(rows: readonly CsvSubmission[], words: CsvWords): string {
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
		[words.received, words.language, words.page, ...columns.map((column) => column.label)].map(csvCell).join(","),
		...rows.map((row) =>
			[
				row.receivedAt.toISOString().slice(0, 19).replace("T", " "),
				row.language,
				row.page ?? "",
				...columns.map((column) => text(row.values.find((value) => value.key === column.key)?.value)),
			]
				.map(csvCell)
				.join(","),
		),
	];
	return `${BOM}${lines.join("\r\n")}\r\n`;
}
