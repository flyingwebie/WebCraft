import type { SubmissionFile, SubmissionValue } from "@webcraft/module-sdk";
import {
	FORM_LIMITS,
	type FormField,
	type FormVersion,
	formLogic,
	formTextIn,
	formWords,
	isLayoutItem,
	ruleMessage,
	uploadExtensions,
} from "@webcraft/renderer";

import { compiledPattern } from "../content/field-types.ts";

/**
 * Checking what a visitor sent against a Form's published version: the server's check is the one
 * that counts (whatever a browser checked first). The rules are the Form's shared logic
 * (`formLogic`, which the forms script runs too): which items its conditions show, and each value
 * read as its type reads it (trimmed, an email in lower case, a number as a number, a choice among
 * the options). An item a condition hides is neither checked nor kept. An error is worded in the
 * page's language, by WebCraft or by the field's own message.
 */

const logic = formLogic();

/** What was sent, by field name: every value sent under it, in order. */
export type SentFields = ReadonlyMap<string, readonly string[]>;

/** A file sent with a Form: its name and bytes, and what its bytes are (null: none of the formats Forms take). */
export type SentFile = { name: string; bytes: Uint8Array; format: string | null; contentType: string | null };

/** The files sent, by field name. */
export type SentFiles = ReadonlyMap<string, readonly SentFile[]>;

/** Where a hidden field's value comes from as the Form is sent: the page's address. */
export type SentFrom = { pageUrl: string | null; query: URLSearchParams };

export type CheckedValues = {
	/**
	 * Each value of the items that show, in the Form's order, as it would be kept. A file field's
	 * files have no `uploadId` yet: they are stored once the Submission is kept.
	 */
	values: SubmissionValue[];
	/** Each field's error, by key, in the page's language. */
	errors: Record<string, string>;
	/** The files to keep, by field key, in the order of their field's value. */
	files: ReadonlyMap<string, readonly SentFile[]>;
};

const NO_FILES: SentFiles = new Map();

const LIMITS = {
	textLength: FORM_LIMITS.textLength,
	textareaLength: FORM_LIMITS.textareaLength,
	options: FORM_LIMITS.options,
	defaultFileBytes: FORM_LIMITS.defaultFileBytes,
};

function matches(pattern: string, text: string): boolean {
	return compiledPattern(pattern).matches(text);
}

/** The keys of the items that show, by the Form's conditions, given what was sent. */
export function visibleItems(version: FormVersion, sent: SentFields): Set<string> {
	return logic.visibleKeys(version.fields, (key) => sent.get(key) ?? []);
}

/** A file as a Submission names it, before it is stored. */
function fileValue(file: SentFile): SubmissionFile {
	return {
		uploadId: null,
		name: file.name,
		size: file.bytes.byteLength,
		contentType: file.contentType ?? "application/octet-stream",
	};
}

/** Reads and checks every field of `version` that shows from what was sent. */
export function checkValues(
	version: FormVersion,
	sent: SentFields,
	language: string,
	from: SentFrom,
	sentFiles: SentFiles = NO_FILES,
): CheckedValues {
	const words = formWords(language);
	const values: SubmissionValue[] = [];
	const errors: Record<string, string> = {};
	const files = new Map<string, readonly SentFile[]>();
	const visible = visibleItems(version, sent);
	for (const field of version.fields) {
		if (isLayoutItem(field) || !visible.has(field.key)) continue;
		const value = (kept: SubmissionValue["value"]) =>
			values.push({ key: field.key, label: field.label.text, type: field.type, value: kept });
		const broke = (broken: { rule: Parameters<typeof ruleMessage>[1]; params?: Record<string, string | number> }) => {
			errors[field.key] = field.message
				? formTextIn(field.message, language)
				: ruleMessage(words, broken.rule, broken.params ?? {});
		};
		if (field.type === "hidden") {
			value(hiddenValue(field, from));
			continue;
		}
		if (field.type === "file") {
			const given = sentFiles.get(field.key) ?? [];
			const broken = logic.checkFiles(
				field,
				given.map((file) => ({ name: file.name, size: file.bytes.byteLength, format: file.format })),
				uploadExtensions(field.accept),
				LIMITS,
			);
			if (broken) broke(broken);
			files.set(field.key, given);
			value(given.map(fileValue));
			continue;
		}
		const read = logic.readValue(field, sent.get(field.key) ?? [], LIMITS, matches);
		value(read.value);
		if (read.broken) broke(read.broken);
	}
	return { values, errors, files };
}

/**
 * What was sent, as kept in the Spam folder: as sent, unchecked, each text cut to the longest any
 * field takes; files by their names and sizes only (spam never keeps their bytes).
 */
export function sentValues(
	version: FormVersion,
	sent: SentFields,
	from: SentFrom,
	sentFiles: SentFiles = NO_FILES,
): SubmissionValue[] {
	const visible = visibleItems(version, sent);
	return version.fields
		.filter((field) => !isLayoutItem(field) && visible.has(field.key))
		.map((field) => {
			const raw = (sent.get(field.key) ?? []).map((text) => text.slice(0, FORM_LIMITS.textareaLength));
			const value =
				field.type === "hidden"
					? hiddenValue(field, from)
					: field.type === "file"
						? (sentFiles.get(field.key) ?? []).slice(0, FORM_LIMITS.files).map(fileValue)
						: field.type === "checkboxes"
							? raw.slice(0, FORM_LIMITS.options)
							: (raw[0] ?? null);
			return { key: field.key, label: field.label.text, type: field.type, value };
		});
}

function hiddenValue(field: FormField, from: SentFrom): string | null {
	const source = field.source ?? { kind: "page" };
	if (source.kind === "fixed") return source.value;
	if (source.kind === "page") return from.pageUrl;
	return from.query.get(source.name)?.slice(0, FORM_LIMITS.labelLength) ?? null;
}
