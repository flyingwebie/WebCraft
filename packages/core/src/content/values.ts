import type { Json } from "./field-types.ts";
import type { StoredValues } from "./field-values.ts";
import { personValue } from "./translation-sources.ts";

/**
 * Who wrote a value (ADR 0003): a person, or AI translation. Outdated translations are worked out
 * from them: AI translation writes its own values again, never a person's.
 */
export type Writer = { kind: "person"; personId: string } | { kind: "ai" };

/**
 * One value in one language, with who wrote it, and in a language other than the Default language the
 * Default-language value it translates (`source`), when known: a person's value whose source changed
 * since is an Outdated translation (see `translation-sources.ts`).
 */
export type LanguageValue = { value: Json; by: Writer | null; source?: Json };

/**
 * One version of an Entry (its Draft or its published version) or of the Globals, as stored: every
 * value by key (ADR 0003). `title` and `slug` sit beside an Entry's Fields, as Translatable fields;
 * see `field-values.ts` for how Fields, Groups and Repeaters keep their values.
 */
export type EntryVersion = { values: StoredValues };

/** The keys of the values every Entry stores, beside its Post Type's Fields. Both are translatable. */
export const STORED_BUILT_INS = ["title", "slug"] as const;

export function emptyVersion(): EntryVersion {
	return { values: {} };
}

/** Reads a stored version. */
export function storedVersion(value: unknown): EntryVersion {
	const values = (value as Partial<EntryVersion> | null)?.values;
	return { values: values && typeof values === "object" && !Array.isArray(values) ? values : {} };
}

/** Where a built-in value (`title`, `slug`) is: in which language, and which language it falls back to. */
export type ValuePlace = { key: (typeof STORED_BUILT_INS)[number]; language: string; defaultLanguage: string };

/**
 * A built-in value in a language: its own, falling back to the Default language one value at a time
 * (both are translatable). Null when there is none.
 */
export function readValue(version: EntryVersion, place: ValuePlace): string | null {
	const byLanguage = (version.values[place.key] ?? {}) as Record<string, LanguageValue | undefined>;
	const value = (byLanguage[place.language] ?? byLanguage[place.defaultLanguage])?.value;
	return typeof value === "string" ? value : null;
}

/**
 * Sets a built-in value in a language, or clears it with "". A value that doesn't change keeps the
 * writer it had.
 */
export function writeValue(version: EntryVersion, place: ValuePlace, value: string, by: Writer): EntryVersion {
	const byLanguage = { ...((version.values[place.key] ?? {}) as Record<string, LanguageValue>) };
	if (value === "") {
		delete byLanguage[place.language];
	} else if (byLanguage[place.language]?.value !== value) {
		// A title in another language translates the Default language's: its source is kept with it.
		byLanguage[place.language] =
			place.key === "title" ? personValue(byLanguage, place, "text", value, by) : { value, by };
	}
	return { values: { ...version.values, [place.key]: byLanguage } };
}

/** A built-in value's own value in a language, without falling back; null when it has none. */
export function ownValue(version: EntryVersion, key: ValuePlace["key"], language: string): string | null {
	const byLanguage = (version.values[key] ?? {}) as Record<string, LanguageValue | undefined>;
	const value = byLanguage[language]?.value;
	return typeof value === "string" && value !== "" ? value : null;
}
