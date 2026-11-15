/**
 * A value as text through its formatter (`formatters.ts` says which there are). Apart from the
 * formatters' syntax because it reads values as text (`value-text.ts`), rich text without its markup.
 */
import type { DateStyle, ValueFormat } from "./formatters.ts";
import { textOf } from "./value-text.ts";
import { isoDay, type TemplateValue, toDate, toFiniteNumber } from "./values.ts";

/** A value as text through its formatter, for the page's language. */
export function applyFormat(value: TemplateValue, format: ValueFormat, language: string): string {
	switch (format.type) {
		case "date": {
			const date = toDate(value);
			return date ? formatDate(date, format.style ?? "medium", language) : textOf(value);
		}
		case "number": {
			const number = toFiniteNumber(value);
			if (number === undefined) return textOf(value);
			const digits =
				format.digits === undefined
					? {}
					: { minimumFractionDigits: format.digits, maximumFractionDigits: format.digits };
			return new Intl.NumberFormat(locale(language), digits).format(number);
		}
		case "truncate":
			return truncate(textOf(value), format.length);
	}
}

function formatDate(date: Date, style: DateStyle, language: string): string {
	switch (style) {
		case "iso":
			return isoDay(date);
		case "datetime":
			return date.toISOString().replace(/\.\d{3}Z$/, "Z");
		case "time":
			return new Intl.DateTimeFormat(locale(language), { timeStyle: "short", timeZone: "UTC" }).format(date);
		default:
			return new Intl.DateTimeFormat(locale(language), { dateStyle: style, timeZone: "UTC" }).format(date);
	}
}

/** The language as a locale Intl accepts; English when it doesn't know it. */
function locale(language: string): string {
	try {
		return Intl.getCanonicalLocales(language)[0] ?? "en";
	} catch {
		return "en";
	}
}

function truncate(text: string, length: number): string {
	const characters = Array.from(text);
	if (characters.length <= length) return text;
	let cut = characters.slice(0, length).join("");
	if (!/\s/.test(characters[length] ?? "")) {
		const lastSpace = cut.search(/\s\S*$/);
		if (lastSpace > 0) cut = cut.slice(0, lastSpace);
	}
	return `${cut.trimEnd()}…`;
}
