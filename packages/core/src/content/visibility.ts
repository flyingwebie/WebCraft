import { entries } from "@webcraft/db/schema";
import { type SQL, sql } from "drizzle-orm";

import type { Languages } from "./field-values.ts";
import type { EntryVersion, LanguageValue, Writer } from "./values.ts";

/**
 * Language visibility (Content): an Entry may be hidden in any of its Site's languages. Hidden in a
 * language, it has no page there (404), no `hreflang` alternate, and no place where Entries are listed
 * in that language: Relationships on pages, Loops (#62) and sitemaps (#92) all ask the same rule,
 * through `isVisibleIn` or, in a query, `publishedVisibleIn`.
 *
 * The languages it is hidden in are stored in each version beside `title`, `slug` and `parent`, as
 * `hiddenLanguages`: one value shared by every language (a list of codes), under the Default
 * language. So hiding is part of the Draft, and visitors see it once the Entry is published.
 */

/** The key the hidden languages are stored under in a version. */
const HIDDEN = "hiddenLanguages";

/** The languages a version hides the Entry in, in order. */
export function hiddenLanguagesIn(version: EntryVersion, defaultLanguage: string): string[] {
	const byLanguage = version.values[HIDDEN] as Record<string, LanguageValue | undefined> | undefined;
	const value = byLanguage?.[defaultLanguage]?.value;
	return Array.isArray(value) ? value.filter((code): code is string => typeof code === "string") : [];
}

/** A version hiding the Entry in `hidden` (none: visible everywhere); an unchanged list keeps its writer. */
export function withHiddenLanguages(
	version: EntryVersion,
	hidden: readonly string[],
	defaultLanguage: string,
	by: Writer,
): EntryVersion {
	const list = [...new Set(hidden)].sort();
	const byLanguage = { ...((version.values[HIDDEN] ?? {}) as Record<string, LanguageValue>) };
	const before = hiddenLanguagesIn(version, defaultLanguage);
	if (list.length === 0) delete byLanguage[defaultLanguage];
	else if (before.join(" ") !== list.join(" ")) byLanguage[defaultLanguage] = { value: list, by };
	return { ...version, values: { ...version.values, [HIDDEN]: byLanguage } };
}

/** Whether a version of an Entry is shown in a language. */
export function isVisibleIn(version: EntryVersion, languages: Languages): boolean {
	return !hiddenLanguagesIn(version, languages.defaultLanguage).includes(languages.language);
}

/**
 * A condition on `entries` rows: the published version is shown in the language. Loops and sitemaps
 * add it to their queries, so an Entry hidden in a language takes no place there.
 */
export function publishedVisibleIn(languages: Languages): SQL {
	return sql`not coalesce((${entries.published} -> 'values' -> ${HIDDEN} -> ${languages.defaultLanguage}::text -> 'value') @> jsonb_build_array(${languages.language}::text), false)`;
}
