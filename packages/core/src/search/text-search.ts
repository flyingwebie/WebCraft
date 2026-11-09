/**
 * How Site search reads text in each language, and what visitors may search with. Filters' search
 * boxes (#97) share both, so a query means the same thing in every search box of a Site.
 */

/**
 * Postgres's text search configuration for each language it has one for, by the language's primary
 * subtag (BCP 47, `pt-BR` reads as `pt`): words are stemmed there (`breads` finds `bread`) and the
 * language's stop words left out. Every other language (Chinese, Japanese, Polish…) uses `simple`:
 * words as written, in lower case, nothing stemmed or left out. Changing this list changes what
 * documents hold: raise `SEARCH_INDEX_VERSION` with it, so every index is rebuilt.
 */
const CONFIGURATIONS: Readonly<Record<string, string>> = {
	ar: "arabic",
	ca: "catalan",
	da: "danish",
	de: "german",
	el: "greek",
	en: "english",
	es: "spanish",
	et: "estonian",
	eu: "basque",
	fi: "finnish",
	fr: "french",
	ga: "irish",
	hi: "hindi",
	hu: "hungarian",
	hy: "armenian",
	id: "indonesian",
	it: "italian",
	lt: "lithuanian",
	nb: "norwegian",
	ne: "nepali",
	nl: "dutch",
	nn: "norwegian",
	no: "norwegian",
	pt: "portuguese",
	ro: "romanian",
	ru: "russian",
	sr: "serbian",
	sv: "swedish",
	ta: "tamil",
	tr: "turkish",
	yi: "yiddish",
};

/** The text search configuration a language's documents and queries use. */
export function textSearchConfiguration(language: string): string {
	const [primary = ""] = language.toLowerCase().split("-");
	return CONFIGURATIONS[primary] ?? "simple";
}

/** The query parameter Site search (and a Filter's search box) reads: `/search?q=bread`. */
export const SEARCH_PARAMETER = "q";

/**
 * How many searches one client address may run on one Site: 30 a minute. Every search is a
 * full-text query the page cache can't keep, so a client running more (a script, not a person) waits
 * until the minute ends. Searches with no query, and every other page, don't count.
 */
export const SEARCH_RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/** The longest query search reads, in characters: a longer one is cut there. */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/**
 * What a visitor searches for, from the page's address: the first `q`, without control characters,
 * its spaces collapsed, cut at `SEARCH_QUERY_MAX_LENGTH` characters (never in the middle of a
 * character). Empty when there is none, which searches for nothing. It is only ever passed to SQL as a
 * parameter, read by `websearch_to_tsquery` (which never fails on what it is given), and shown back
 * escaped.
 */
export function searchQueryIn(query: URLSearchParams): string {
	const given = query.get(SEARCH_PARAMETER) ?? "";
	return cleanSearchText(given);
}

/** Search text as `searchQueryIn` keeps it. */
export function cleanSearchText(text: string): string {
	const clean = text
		.normalize("NFC")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return [...clean].slice(0, SEARCH_QUERY_MAX_LENGTH).join("").trim();
}
