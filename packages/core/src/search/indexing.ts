import { entries, searchDocuments } from "@webcraft/db/schema";
import { type Block, bodyText, richTextToText } from "@webcraft/renderer";
import { and, asc, eq, gt, notInArray, type SQL, sql } from "drizzle-orm";

import { entryValues } from "../content/entries.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import type { Languages } from "../content/field-values.ts";
import { type SiteLanguages, siteLanguages } from "../content/languages.ts";
import { listPostTypes, type PostType } from "../content/post-types.ts";
import { type EntryVersion, storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import type { BackgroundScope, SiteScope } from "../tenancy/data-layer.ts";
import { markSearchIndexStale } from "./index-version.ts";
import { SEARCH_WEIGHTS, SEARCHED_TITLE, type SearchWeight, searchedChain } from "./searched-fields.ts";
import { textSearchConfiguration } from "./text-search.ts";

/**
 * The Site search index (ADR 0021): one document per published Entry and language it is shown in,
 * built from its Post Type's Searched fields, each weighted A to D, in the language's text search
 * configuration. Values are read in the language with the Default language's as fallback, one Field
 * at a time, as pages show them. Every Post Type is indexed: whether Site search lists one is decided
 * when searching.
 */

/** What indexing reads and writes with: a Site scope inside a publish, or a background scope in a job. */
export type IndexScope = Pick<SiteScope | BackgroundScope, "select" | "delete" | "where" | "db" | "site">;

/** How much text one weight of a document holds at most, in characters: past it, the rest isn't searched. */
const WEIGHT_TEXT_MAX = 100_000;

/** How much of an Entry's text (besides its title) is kept for snippets, in characters. */
const SNIPPET_TEXT_MAX = 100_000;

/** One language's document of an Entry: its text by weight, and its text besides the title for snippets. */
export type SearchDocument = { weights: Partial<Record<SearchWeight, string>>; text: string };

/**
 * Indexes one Entry again from what is published now, in every language of the Site it is shown in;
 * an Entry that isn't published (or not shown in a language) has no document there.
 */
export async function indexEntry(scope: IndexScope, entryId: string): Promise<void> {
	const [row] = await scope.select(entries, eq(entries.id, entryId));
	if (!row) return;
	const postType = (await listPostTypes(scope)).find((candidate) => candidate.id === row.postTypeId);
	await writeDocuments(scope, row, postType, await siteLanguages(scope));
}

/**
 * Indexes an Entry just published, inside the publish's transaction, so it is found as soon as its
 * page shows. A publish never fails because indexing does: the work runs behind a savepoint, and if
 * it fails it is undone and the Site's index is rebuilt in the background instead.
 */
export async function indexPublishedEntry(scope: SiteScope, entryId: string): Promise<void> {
	try {
		await scope.db.transaction(async () => {
			await indexEntry(scope, entryId);
		});
	} catch {
		await markSearchIndexStale(scope);
	}
}

/** How many Entries a rebuild reads and indexes in one transaction. */
const REBUILD_BATCH = 100;

/**
 * Rebuilds a Site's whole search index from what is published now: every Entry's documents in every
 * language, and none left for languages the Site no longer has. Entries are locked a batch at a time,
 * so a publish of one of them waits for (or goes before) its batch, never overwriting it with older
 * text.
 */
export async function rebuildSearchIndex(scope: BackgroundScope): Promise<{ entries: number }> {
	let after: string | null = null;
	let count = 0;
	for (;;) {
		const batch: { id: string }[] = await scope.transaction(async (tx) => {
			const site = await siteLanguages(tx);
			const postTypes = await listPostTypes(tx);
			const rows = await tx.db
				.select()
				.from(entries)
				.where(tx.where(entries, after === null ? undefined : gt(entries.id, after)))
				.orderBy(asc(entries.id))
				.limit(REBUILD_BATCH)
				.for("update");
			for (const row of rows) {
				await writeDocuments(
					tx,
					row,
					postTypes.find((postType) => postType.id === row.postTypeId),
					site,
				);
			}
			return rows;
		});
		count += batch.length;
		if (batch.length < REBUILD_BATCH) break;
		after = batch.at(-1)?.id ?? null;
	}
	const { languages } = await siteLanguages(scope);
	await scope.delete(
		searchDocuments,
		notInArray(
			searchDocuments.language,
			languages.map((language) => language.code),
		),
	);
	return { entries: count };
}

/** Writes an Entry's documents, one per language it is shown in, and removes the rest. */
async function writeDocuments(
	scope: IndexScope,
	row: typeof entries.$inferSelect,
	postType: PostType | undefined,
	site: SiteLanguages,
): Promise<void> {
	const kept: string[] = [];
	if (postType && row.published !== null) {
		const version = storedVersion(row.published);
		for (const language of site.languages) {
			const languages = { language: language.code, defaultLanguage: site.defaultLanguage };
			if (!isVisibleIn(version, languages)) continue;
			await writeDocument(scope, row.id, language.code, searchDocument(version, postType, languages));
			kept.push(language.code);
		}
	}
	await scope.delete(
		searchDocuments,
		and(
			eq(searchDocuments.entryId, row.id),
			kept.length > 0 ? notInArray(searchDocuments.language, kept) : undefined,
		) as SQL,
	);
}

async function writeDocument(
	scope: IndexScope,
	entryId: string,
	language: string,
	document: SearchDocument,
): Promise<void> {
	const configuration = textSearchConfiguration(language);
	const parts = SEARCH_WEIGHTS.flatMap((weight) => {
		const text = document.weights[weight];
		return text ? [sql`setweight(to_tsvector(${configuration}::regconfig, ${text}::text), ${weight}::"char")`] : [];
	});
	const tsvector = parts.length > 0 ? sql.join(parts, sql` || `) : sql`''::tsvector`;
	await scope.db
		.insert(searchDocuments)
		.values({
			workspaceId: scope.site.workspaceId,
			siteId: scope.site.id,
			entryId,
			language,
			document: tsvector as unknown as string,
			text: document.text,
		})
		.onConflictDoUpdate({
			target: [searchDocuments.entryId, searchDocuments.language],
			set: { document: sql`excluded.document`, text: sql`excluded.text` },
		});
}

/**
 * An Entry's document in one language: each Searched field's text, read in the language (the
 * Default language's where it has none of its own), grouped by weight. Rich text gives its text, a
 * body its Blocks' text, a select its options' labels, a link its text; a Repeater's Field each row's.
 */
export function searchDocument(version: EntryVersion, postType: PostType, languages: Languages): SearchDocument {
	const read = entryValues(version, postType.fields, languages);
	const weights: Partial<Record<SearchWeight, string[]>> = {};
	const others: string[] = [];
	for (const searched of postType.searchedFields) {
		const texts =
			searched.field === SEARCHED_TITLE ? [read.title] : fieldTexts(postType.fields, read.fields, searched.field);
		const kept = texts.map(plain).filter((text) => text !== "");
		if (kept.length === 0) continue;
		weights[searched.weight] = [...(weights[searched.weight] ?? []), ...kept];
		if (searched.field !== SEARCHED_TITLE) others.push(...kept);
	}
	return {
		weights: Object.fromEntries(
			Object.entries(weights).map(([weight, texts]) => [weight, cut(texts.join("\n"), WEIGHT_TEXT_MAX)]),
		),
		text: cut(others.join("\n"), SNIPPET_TEXT_MAX),
	};
}

/** The texts a Searched field's path holds among an Entry's values: one per Repeater row it passes through. */
function fieldTexts(fields: readonly FieldDefinition[], values: Record<string, unknown>, path: string): string[] {
	const chain = searchedChain(fields, path);
	if (!Array.isArray(chain)) return [];
	let current: unknown[] = [values];
	for (const field of chain) {
		current = current.flatMap((value) => {
			const inner = value && typeof value === "object" ? (value as Record<string, unknown>)[field.key] : undefined;
			return field.type === "repeater" && Array.isArray(inner) ? inner : [inner];
		});
	}
	const leaf = chain.at(-1);
	return leaf ? current.flatMap((value) => leafTexts(leaf, value)) : [];
}

function leafTexts(field: FieldDefinition, value: unknown): string[] {
	if (value === null || value === undefined) return [];
	switch (field.type) {
		case "richText":
			return typeof value === "string" ? [richTextToText(value)] : [];
		case "body":
			return Array.isArray(value) ? [bodyText(value as Block[])] : [];
		case "select": {
			const chosen = Array.isArray(value) ? value : [value];
			return chosen.map(
				(option) =>
					field.options.find((candidate) => candidate.value === option)?.label ??
					(typeof option === "string" ? option : ""),
			);
		}
		case "link": {
			const text = (value as { text?: unknown }).text;
			return typeof text === "string" ? [text] : [];
		}
		default:
			return typeof value === "string" ? [value] : [];
	}
}

/**
 * Text as documents keep it: control characters as spaces. `ts_headline` marks words in snippets with
 * two of them, so none may be in the text itself.
 */
function plain(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
	return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ").trim();
}

function cut(text: string, max: number): string {
	return text.length <= max ? text : [...text.slice(0, max + 1)].slice(0, max).join("");
}
