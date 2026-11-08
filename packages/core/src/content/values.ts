import type { FieldDefinition } from "./fields.ts";

/**
 * Who wrote a value (ADR 0003): a person for now; AI translation and Automatic translation join as
 * writers, and Outdated translations are worked out from them.
 */
export type Writer = { kind: "person"; personId: string };

/** One value in one language, with who wrote it. */
export type LanguageValue = { value: string; by: Writer | null };

/**
 * One version of an Entry (its Draft or its published version), as stored: every value by key and
 * then by language (ADR 0003). `title` and `slug` sit beside the Post Type's Fields. A Translatable
 * field holds a value per language; a shared Field holds one, under the Site's Default language.
 */
export type EntryVersion = { values: Record<string, Record<string, LanguageValue>> };

/** The keys of the values every Entry stores, beside its Post Type's Fields. Both are translatable. */
export const STORED_BUILT_INS = ["title", "slug"] as const;

export function emptyVersion(): EntryVersion {
	return { values: {} };
}

/** Reads a stored version. */
export function storedVersion(value: unknown): EntryVersion {
	const values = (value as Partial<EntryVersion> | null)?.values;
	return { values: values && typeof values === "object" ? values : {} };
}

/** Where one key's values are, in which language, and which language they fall back to. */
export type ValuePlace = {
	key: string;
	/** Whether the value is per language; `title`, `slug` and Translatable fields are. */
	translatable: boolean;
	language: string;
	defaultLanguage: string;
};

/**
 * The value of `key` in a language: a Translatable field's own value, falling back to the Default
 * language one Field at a time; a shared Field's one value. Null when there is none.
 */
export function readValue(version: EntryVersion, place: ValuePlace): string | null {
	const byLanguage = version.values[place.key] ?? {};
	if (place.translatable) {
		return byLanguage[place.language]?.value ?? byLanguage[place.defaultLanguage]?.value ?? null;
	}
	return byLanguage[place.defaultLanguage]?.value ?? null;
}

/**
 * Sets the value of `key` in a language (a shared Field's under the Default language), or clears it
 * with null or "". A value that doesn't change keeps the writer it had.
 */
export function writeValue(version: EntryVersion, place: ValuePlace, value: string | null, by: Writer): EntryVersion {
	const language = place.translatable ? place.language : place.defaultLanguage;
	const byLanguage = { ...(version.values[place.key] ?? {}) };
	if (value === null || value === "") {
		delete byLanguage[language];
	} else if (byLanguage[language]?.value !== value) {
		byLanguage[language] = { value, by };
	}
	return { values: { ...version.values, [place.key]: byLanguage } };
}

/** Where the value of a stored built-in or a Field is. */
export function placeOf(
	key: string,
	fields: readonly FieldDefinition[],
	languages: { language: string; defaultLanguage: string },
): ValuePlace {
	const field = fields.find((candidate) => candidate.key === key);
	return { key, translatable: field ? field.translatable : true, ...languages };
}
