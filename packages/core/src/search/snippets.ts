import { searchDocuments } from "@webcraft/db/schema";
import { escapeText } from "@webcraft/renderer";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";

import type { VisitorScope } from "../tenancy/data-layer.ts";
import { textSearchConfiguration } from "./text-search.ts";

/**
 * What a query means in a language: `websearch_to_tsquery` reads it as visitors write queries in
 * search boxes (words, "a phrase", or, -a word left out), never failing on anything, and it is
 * passed as a parameter, so nothing a visitor types becomes SQL.
 */
export function textQuery(language: string, query: string): SQL {
	return sql`websearch_to_tsquery(${textSearchConfiguration(language)}::regconfig, ${query}::text)`;
}

/**
 * Where `ts_headline` marks the words a hit matched. The index holds no control characters (they are
 * spaces there), so these two can't come from the text itself.
 */
const MARK_START = "\u0002";
const MARK_END = "\u0003";

/**
 * A snippet: about 15 to 35 words around where the query matched best (the start of the text when
 * only the title matched), punctuation kept. Text that reads as an HTML tag is left out of it by
 * Postgres's parser; the rest is text.
 */
const HEADLINE_OPTIONS = `StartSel="${MARK_START}", StopSel="${MARK_END}", MaxWords=35, MinWords=15, ShortWord=3`;

/**
 * The snippets of hits, by Entry id: where each one's text (its Searched fields besides the title)
 * matched the query, the matched words highlighted, as HTML. `ts_headline` writes text, never HTML:
 * all of it is escaped here, and the only markup in a snippet is WebCraft's own `<mark>`.
 */
export async function searchSnippets(
	scope: Pick<VisitorScope, "db" | "where">,
	entryIds: readonly string[],
	language: string,
	query: string,
): Promise<Map<string, string>> {
	if (entryIds.length === 0 || query === "") return new Map();
	const configuration = textSearchConfiguration(language);
	const rows = await scope.db
		.select({
			entryId: searchDocuments.entryId,
			headline: sql<string>`ts_headline(${configuration}::regconfig, ${searchDocuments.text}, ${textQuery(language, query)}, ${HEADLINE_OPTIONS}::text)`,
		})
		.from(searchDocuments)
		.where(
			scope.where(
				searchDocuments,
				and(eq(searchDocuments.language, language), inArray(searchDocuments.entryId, [...entryIds])),
			),
		);
	return new Map(rows.map((row) => [row.entryId, snippetHtml(row.headline)]));
}

/** A headline as HTML: every character escaped, then WebCraft's marks around the matched words. */
export function snippetHtml(headline: string): string {
	return escapeText(headline.trim()).replaceAll(MARK_START, "<mark>").replaceAll(MARK_END, "</mark>");
}
