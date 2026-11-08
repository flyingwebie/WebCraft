import { entries, people, publishedSlugs } from "@webcraft/db/schema";
import { cleanRichText, richTextToText } from "@webcraft/renderer";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { type ContentProblem, EntryInvalidError, EntryNotFoundError, EntrySlugTakenError } from "./errors.ts";
import { type FieldDefinition, RICH_TEXT_VALUE_MAX_LENGTH, TEXT_VALUE_MAX_LENGTH } from "./fields.ts";
import { siteLanguages } from "./languages.ts";
import {
	checkDraftParent,
	isPagePostType,
	pageSlugTaken,
	parentIn,
	parentPlace,
	pathIn,
	pathText,
	publishedPageTree,
} from "./pages.ts";
import { getPostType, type PostType, UUID } from "./post-types.ts";
import { slugify } from "./slugs.ts";
import { ENTRY_SLUG, ENTRY_SLUG_MAX_LENGTH, pathFor } from "./url-patterns.ts";
import {
	type EntryVersion,
	emptyVersion,
	placeOf,
	readValue,
	storedVersion,
	type Writer,
	writeValue,
} from "./values.ts";

/**
 * Where an Entry stands: `draft` (never published), `published` (visitors see the Draft as it is) or
 * `changed` (published, and the Draft has changed since). Review and Scheduled publish add theirs.
 */
export type EntryStatus = "draft" | "published" | "changed";

/** One version of an Entry in one language: its title, slug and the value of every Field. */
export type EntryValues = {
	title: string;
	slug: string;
	/** A Page's parent Page; null for a top-level Page and for every other Entry. */
	parentId: string | null;
	/** Every Field of the Post Type, by key; null when empty. */
	fields: Record<string, string | null>;
};

/** An Entry with its built-in Fields, its Draft and its published version, in one language. */
export type Entry = {
	id: string;
	siteId: string;
	postTypeId: string;
	status: EntryStatus;
	/** Who created it; null once that person is deleted. */
	author: { id: string; name: string } | null;
	createdAt: Date;
	/** When the Draft was last saved. */
	updatedAt: Date;
	/** When it was first published. */
	publishedAt: Date | null;
	/** When it was last published. */
	lastPublishedAt: Date | null;
	/** The language the values are in. */
	language: string;
	draft: EntryValues;
	/** What visitors see; null until it is first published. */
	published: EntryValues | null;
	/** Where visitors find it (`/blog/fresh-bread`, `/about/team`); null until it is published. */
	path: string | null;
};

/** A change to an Entry's Draft, in one language (the Site's Default language unless given). */
export type DraftChange = {
	language?: string;
	title?: string;
	/** A new slug; WebCraft makes one from the title for a new Entry without one. */
	slug?: string;
	/**
	 * A Page's parent Page, null to move it to the top level. Only Pages have one; a published Page
	 * moves, with every Page under it, when it is published.
	 */
	parentId?: string | null;
	/** Values of the Post Type's Fields, by key; null or "" clears one. */
	fields?: Record<string, string | null>;
};

export type NewEntry = DraftChange & { postTypeId: string; title: string };

export const ENTRY_TITLE_MAX_LENGTH = 300;

type EntryRow = typeof entries.$inferSelect;

export { siteLanguages };

/**
 * Creates an Entry of a Post Type on the scope's Site (open it with `entry.edit`), its Draft holding
 * the values given. The person who creates it is its author. A slug is made from the title when none
 * is given, unique within the Post Type.
 */
export async function createEntry(scope: SiteScope, input: NewEntry): Promise<Entry> {
	const postType = await getPostType(scope, input.postTypeId);
	return scope.transaction(async (tx) => {
		const now = tx.now();
		const row = await tx.insert(entries, {
			postTypeId: postType.id,
			authorId: writerOf(tx).personId,
			draft: emptyVersion(),
			createdAt: now,
			updatedAt: now,
		});
		const languages = await siteLanguages(tx);
		const language = input.language ?? languages.defaultLanguage;
		const taken = isPagePostType(postType)
			? (candidate: string) =>
					pageSlugTaken(tx, row, input.parentId ?? null, {
						language,
						defaultLanguage: languages.defaultLanguage,
						value: candidate,
					})
			: (candidate: string) => slugTaken(tx, postType.id, row.id, language, candidate);
		const slug = input.slug ?? (await freeSlug(taken, slugify(input.title) || slugify(postType.name) || "entry"));
		const saved = await changeDraft(tx, row, postType, { ...input, slug }, languages.defaultLanguage);
		return toEntry(tx, saved, postType, language, languages.defaultLanguage);
	});
}

/**
 * Saves a change to an Entry's Draft (open the Site with `entry.edit`). Visitors see nothing of it
 * until the Entry is published.
 */
export async function saveDraft(scope: SiteScope, entryId: string, change: DraftChange): Promise<Entry> {
	return scope.transaction(async (tx) => {
		const row = await lockEntry(tx, entryId);
		const postType = await getPostType(tx, row.postTypeId);
		const { defaultLanguage } = await siteLanguages(tx);
		const saved = await changeDraft(tx, row, postType, change, defaultLanguage);
		return toEntry(tx, saved, postType, change.language ?? defaultLanguage, defaultLanguage);
	});
}

/** One Entry of the scope's Site, in a language (the Default language unless given). */
export async function getEntry(scope: SiteScope, entryId: string, language?: string): Promise<Entry> {
	const row = UUID.test(entryId) ? await scope.first(entries, eq(entries.id, entryId)) : undefined;
	if (!row) throw new EntryNotFoundError();
	const postType = await getPostType(scope, row.postTypeId);
	const { defaultLanguage } = await siteLanguages(scope);
	return toEntry(scope, row, postType, checkLanguage(language, defaultLanguage), defaultLanguage);
}

/** The Entries of a Post Type, newest first, in a language (the Default language unless given). */
export async function listEntries(scope: SiteScope, postTypeId: string, language?: string): Promise<Entry[]> {
	const postType = await getPostType(scope, postTypeId);
	const { defaultLanguage } = await siteLanguages(scope);
	const chosen = checkLanguage(language, defaultLanguage);
	const rows = await scope.select(entries, eq(entries.postTypeId, postType.id), {
		orderBy: [desc(entries.createdAt), asc(entries.id)],
	});
	const authors = await authorNames(
		scope,
		rows.map((row) => row.authorId),
	);
	const paths = await publishedPaths(scope, postType, rows, chosen);
	return rows.map((row) => entryView(row, postType, chosen, defaultLanguage, authors, paths));
}

/**
 * The one place an Entry's Draft is written. Checks the change against the Post Type, refuses a slug
 * another Entry of the Post Type has, and saves the new Draft. Co-editing will apply changes to the
 * Draft's shared document here instead (ADR 0025).
 */
async function changeDraft(
	scope: SiteScope,
	row: EntryRow,
	postType: PostType,
	change: DraftChange,
	defaultLanguage: string,
): Promise<EntryRow> {
	const problems: ContentProblem[] = [];
	const language = change.language ?? defaultLanguage;
	if (language !== defaultLanguage) {
		problems.push({ at: "language", message: `The Site has no language ${language}.` });
	}
	const by = writerOf(scope);
	const place = (key: string) => placeOf(key, postType.fields, { language, defaultLanguage });
	let version = storedVersion(row.draft);

	if (change.title !== undefined) {
		const title = change.title.trim();
		if (title.length > ENTRY_TITLE_MAX_LENGTH) {
			problems.push({ at: "title", message: `A title has at most ${ENTRY_TITLE_MAX_LENGTH} characters.` });
		}
		version = writeValue(version, place("title"), title, by);
	}
	let slug: string | undefined;
	if (change.slug !== undefined) {
		slug = change.slug.trim().toLowerCase();
		if (slug !== "" && (!ENTRY_SLUG.test(slug) || slug.length > ENTRY_SLUG_MAX_LENGTH)) {
			problems.push({
				at: "slug",
				message: `A slug is lower-case letters and digits joined by dashes, at most ${ENTRY_SLUG_MAX_LENGTH} characters.`,
			});
		}
		version = writeValue(version, place("slug"), slug, by);
	}
	if (change.parentId !== undefined && change.parentId !== null && !isPagePostType(postType)) {
		problems.push({ at: "parentId", message: "Only Pages have a parent Page." });
	} else if (change.parentId !== undefined && isPagePostType(postType)) {
		if (change.parentId !== null) await checkDraftParent(scope, row, change.parentId, defaultLanguage, problems);
		version = writeValue(version, parentPlace(defaultLanguage), change.parentId, by);
	}
	for (const [key, value] of Object.entries(change.fields ?? {})) {
		const field = postType.fields.find((candidate) => candidate.key === key);
		if (!field) {
			problems.push({ at: `fields.${key}`, message: `${postType.name} has no Field ${key}.` });
			continue;
		}
		const stored = field.type === "richText" ? cleanRichTextValue(value) : value;
		const limit = field.type === "richText" ? RICH_TEXT_VALUE_MAX_LENGTH : TEXT_VALUE_MAX_LENGTH;
		if (stored !== null && stored.length > limit) {
			problems.push({
				at: `fields.${key}`,
				message: `A ${field.type === "richText" ? "rich text" : "text"} value has at most ${limit} characters.`,
			});
		}
		version = writeValue(version, place(key), stored, by);
	}
	if (problems.length > 0) throw new EntryInvalidError(problems);
	if (isPagePostType(postType)) {
		// A Page's slug is unique among the Pages under its parent, so a move checks it too.
		const pageSlug = slug ?? readValue(version, place("slug"));
		const parentId = parentIn(version, defaultLanguage);
		const value = { language, defaultLanguage, value: pageSlug ?? "" };
		if ((slug || change.parentId !== undefined) && pageSlug && (await pageSlugTaken(scope, row, parentId, value))) {
			throw new EntrySlugTakenError(pageSlug, "siblingPages");
		}
	} else if (slug && (await slugTaken(scope, postType.id, row.id, language, slug))) {
		throw new EntrySlugTakenError(slug);
	}

	const [saved] = await scope.update(entries, { draft: version, updatedAt: scope.now() }, eq(entries.id, row.id));
	if (!saved) throw new EntryNotFoundError();
	return saved;
}

/**
 * Rich text as it is stored: cleaned against the rich text allowlist (ADR 0017), and null when no
 * text is left.
 */
function cleanRichTextValue(value: string | null): string | null {
	if (value === null) return null;
	const clean = cleanRichText(value);
	return richTextToText(clean).trim() === "" ? null : clean;
}

/** Reads an Entry for a change, holding it until the transaction ends so changes don't overlap. */
export async function lockEntry(scope: SiteScope, entryId: string): Promise<EntryRow> {
	const [row] = UUID.test(entryId)
		? await scope.db
				.select()
				.from(entries)
				.where(scope.where(entries, eq(entries.id, entryId)))
				.for("update")
		: [];
	if (!row) throw new EntryNotFoundError();
	return row;
}

/** Whether another Entry of the Post Type has the slug, in its Draft or published, in a language. */
async function slugTaken(
	scope: SiteScope,
	postTypeId: string,
	entryId: string,
	language: string,
	slug: string,
): Promise<boolean> {
	const published = await scope.count(
		publishedSlugs,
		and(
			eq(publishedSlugs.postTypeId, postTypeId),
			eq(publishedSlugs.language, language),
			eq(publishedSlugs.slug, slug),
			ne(publishedSlugs.entryId, entryId),
		),
	);
	if (published > 0) return true;
	const drafts = await scope.count(
		entries,
		and(
			eq(entries.postTypeId, postTypeId),
			ne(entries.id, entryId),
			sql`${entries.draft} -> 'values' -> 'slug' -> ${language}::text ->> 'value' = ${slug}`,
		),
	);
	return drafts > 0;
}

/** A slug made from `stem` that isn't `taken`: `stem`, then `stem-2`, `stem-3`, … */
async function freeSlug(taken: (candidate: string) => Promise<boolean>, stem: string): Promise<string> {
	for (let attempt = 1; ; attempt++) {
		const candidate = attempt === 1 ? stem : `${stem}-${attempt}`;
		if (!(await taken(candidate))) return candidate;
	}
}

function checkLanguage(language: string | undefined, defaultLanguage: string): string {
	if (language !== undefined && language !== defaultLanguage) {
		throw new EntryInvalidError([{ at: "language", message: `The Site has no language ${language}.` }]);
	}
	return defaultLanguage;
}

function writerOf(scope: Pick<SiteScope, "access">): Writer {
	return { kind: "person", personId: scope.access.actor.personId };
}

async function toEntry(
	scope: SiteScope,
	row: EntryRow,
	postType: PostType,
	language: string,
	defaultLanguage: string,
): Promise<Entry> {
	const authors = await authorNames(scope, [row.authorId]);
	return entryView(
		row,
		postType,
		language,
		defaultLanguage,
		authors,
		await publishedPaths(scope, postType, [row], language),
	);
}

/** Where visitors find each published Entry, by id: its Post Type's URL pattern, or a Page's parents and slug. */
async function publishedPaths(
	scope: SiteScope,
	postType: PostType,
	rows: readonly EntryRow[],
	language: string,
): Promise<Map<string, string>> {
	const paths = new Map<string, string>();
	if (isPagePostType(postType)) {
		const tree = await publishedPageTree(scope, postType.id, language);
		for (const row of rows) {
			const parts = pathIn(tree, row.id);
			if (parts) paths.set(row.id, pathText(parts));
		}
		return paths;
	}
	const slugs = await scope.select(
		publishedSlugs,
		and(eq(publishedSlugs.postTypeId, postType.id), eq(publishedSlugs.language, language)),
	);
	for (const { entryId, slug } of slugs) {
		const path = pathFor(postType.urlPattern, slug);
		if (path) paths.set(entryId, path);
	}
	return paths;
}

/** The names of the people who wrote Entries, by id. */
async function authorNames(scope: SiteScope, ids: readonly (string | null)[]): Promise<Map<string, string>> {
	const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
	if (wanted.length === 0) return new Map();
	const rows = await scope.db
		.select({ id: people.id, name: people.name })
		.from(people)
		.where(inArray(people.id, wanted));
	return new Map(rows.map((row) => [row.id, row.name]));
}

function entryView(
	row: EntryRow,
	postType: PostType,
	language: string,
	defaultLanguage: string,
	authors: ReadonlyMap<string, string>,
	paths: ReadonlyMap<string, string>,
): Entry {
	const values = (version: EntryVersion) => entryValues(version, postType.fields, { language, defaultLanguage });
	const authorName = row.authorId ? authors.get(row.authorId) : undefined;
	return {
		id: row.id,
		siteId: row.siteId,
		postTypeId: row.postTypeId,
		status: entryStatus(row),
		author: row.authorId && authorName !== undefined ? { id: row.authorId, name: authorName } : null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
		language,
		draft: values(storedVersion(row.draft)),
		published: row.published === null ? null : values(storedVersion(row.published)),
		path: paths.get(row.id) ?? null,
	};
}

/** An Entry's title, slug and Field values in one language. */
export function entryValues(
	version: EntryVersion,
	fields: readonly FieldDefinition[],
	languages: { language: string; defaultLanguage: string },
): EntryValues {
	const read = (key: string) => readValue(version, placeOf(key, fields, languages));
	return {
		title: read("title") ?? "",
		slug: read("slug") ?? "",
		parentId: parentIn(version, languages.defaultLanguage),
		fields: Object.fromEntries(fields.map((field) => [field.key, read(field.key)])),
	};
}

export function entryStatus(row: Pick<EntryRow, "draft" | "published">): EntryStatus {
	if (row.published === null) return "draft";
	return sameJson(row.draft, row.published) ? "published" : "changed";
}

/** Whether two JSON values are equal, whatever the order of their keys. */
export function sameJson(a: unknown, b: unknown): boolean {
	return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
