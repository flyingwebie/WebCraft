import { entries, people, publishedSlugs, sites } from "@webcraft/db/schema";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import {
	type ContentProblem,
	EntryInvalidError,
	EntryLinkedError,
	EntryNotFoundError,
	EntrySlugTakenError,
} from "./errors.ts";
import type { FieldDefinition, Json } from "./field-types.ts";
import {
	checkFields,
	defaultValues,
	type Findings,
	type Languages,
	linksIn,
	randomRowId,
	readFields,
	type WriteContext,
	withoutLinksTo,
	writeFields,
} from "./field-values.ts";
import { sameJson } from "./json.ts";
import { clearPageCache } from "./page-cache.ts";
import { getPostType, listPostTypes, type PostType, UUID } from "./post-types.ts";
import { checkReferences, type LinkBack, linkingEntries, linksBack, saveLinks } from "./relationships.ts";
import { slugify } from "./slugs.ts";
import { ENTRY_SLUG, ENTRY_SLUG_MAX_LENGTH } from "./url-patterns.ts";
import { type EntryVersion, emptyVersion, readValue, storedVersion, type Writer, writeValue } from "./values.ts";

export { sameJson } from "./json.ts";

/**
 * Where an Entry stands: `draft` (never published), `published` (visitors see the Draft as it is) or
 * `changed` (published, and the Draft has changed since). Review and Scheduled publish add theirs.
 */
export type EntryStatus = "draft" | "published" | "changed";

/** One version of an Entry in one language: its title, slug and the value of every Field. */
export type EntryValues = {
	title: string;
	slug: string;
	/** Every Field of the Post Type, by key, as its type gives it (see the Field types). */
	fields: Record<string, Json>;
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
	/**
	 * What keeps the Draft from being published, each at its path (`title`, `fields.price`,
	 * `fields.team[1].name`) with the rule: empty required values and values that break a rule.
	 */
	problems: ContentProblem[];
	/** The Entries whose Drafts point at this one through a two-way Relationship. */
	linkedFrom: LinkBack[];
};

/** A change to an Entry's Draft, in one language (the Site's Default language unless given). */
export type DraftChange = {
	language?: string;
	title?: string;
	/** A new slug; WebCraft makes one from the title for a new Entry without one. */
	slug?: string;
	/**
	 * Values of the Post Type's Fields, by key, each as its type takes it; null or "" clears one. A
	 * Group's value is its Fields' values by key (only those given change); a Repeater's is its whole
	 * list of rows (rows keep their `id`; rows left out are removed).
	 */
	fields?: Record<string, unknown>;
};

export type NewEntry = DraftChange & { postTypeId: string; title: string };

/** What deleting an Entry did, or, before it is confirmed, what it would do. */
export type EntryDeletion =
	| {
			deleted: false;
			/** How many other Entries link to it; deleting it removes those links. */
			links: number;
			/** Send its id back to delete the Entry. */
			confirmation: Confirmation;
	  }
	| { deleted: true; links: number; confirmation?: undefined };

export const ENTRY_TITLE_MAX_LENGTH = 300;

type EntryRow = typeof entries.$inferSelect;

/** The languages of the scope's Site. Only the Default language exists until Sites get more. */
export async function siteLanguages(scope: Pick<SiteScope, "db" | "site">): Promise<{ defaultLanguage: string }> {
	const [row] = await scope.db
		.select({ defaultLanguage: sites.defaultLanguage })
		.from(sites)
		.where(eq(sites.id, scope.site.id));
	return { defaultLanguage: row?.defaultLanguage ?? "en" };
}

/**
 * Creates an Entry of a Post Type on the scope's Site (open it with `entry.edit`), its Draft holding
 * the Fields' defaults and the values given. The person who creates it is its author. A slug is made
 * from the title when none is given, unique within the Post Type.
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
		const slug = input.slug ?? (await freeSlug(tx, postType, row.id, language, slugify(input.title)));
		const { postTypeId: _, ...change } = input;
		const saved = await changeDraft(
			tx,
			row,
			postType,
			{ change: { ...change, slug }, withDefaults: true },
			languages.defaultLanguage,
		);
		return toEntry(tx, saved, postType, language, languages.defaultLanguage);
	});
}

/**
 * Saves a change to an Entry's Draft (open the Site with `entry.edit`). Visitors see nothing of it
 * until the Entry is published. Values of the wrong kind are refused (`EntryInvalidError`); values
 * that break a rule are saved, and listed in the Entry's `problems` until they are fixed.
 */
export async function saveDraft(scope: SiteScope, entryId: string, change: DraftChange): Promise<Entry> {
	return scope.transaction(async (tx) => {
		const row = await lockEntry(tx, entryId);
		const postType = await getPostType(tx, row.postTypeId);
		const { defaultLanguage } = await siteLanguages(tx);
		const saved = await changeDraft(tx, row, postType, { change }, defaultLanguage);
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
	return entryViews(scope, rows, postType, chosen, defaultLanguage);
}

/**
 * Deletes an Entry (open the Site with `entry.delete`), in two steps. Without a confirmation it
 * deletes nothing and answers how many other Entries link to it, with a confirmation id; with that
 * id it deletes the Entry and removes the links to it from those Entries' Drafts and published
 * versions, so no Relationship points at nothing. An Entry another Entry must point at (through a
 * required Relationship) can't be deleted: `EntryLinkedError` lists those Entries.
 */
export async function deleteEntry(scope: SiteScope, entryId: string, confirmation?: string): Promise<EntryDeletion> {
	return scope.transaction(async (tx) => {
		const row = await lockEntry(tx, entryId);
		const allPostTypes = await listPostTypes(tx);
		const { defaultLanguage } = await siteLanguages(tx);
		const linking = await linkingEntries(tx, row.id, allPostTypes, defaultLanguage);
		const blockedBy = linking.filter((entry) => entry.required);
		if (blockedBy.length > 0) {
			throw new EntryLinkedError(
				blockedBy.map(({ entryId: id, postTypeId, title, fields }) => ({ entryId: id, postTypeId, title, fields })),
			);
		}
		const links = linking.length;
		const request = {
			action: "entry.delete",
			target: row.id,
			preview: { links, entries: linking.map((entry) => entry.entryId) },
		};
		if (confirmation === undefined) {
			return { deleted: false, links, confirmation: await askConfirmation(tx, request) };
		}
		await useConfirmation(tx, confirmation, request);

		const byId = new Map(allPostTypes.map((postType) => [postType.id, postType]));
		for (const linked of linking) {
			const source = await lockEntry(tx, linked.entryId);
			const postType = byId.get(source.postTypeId);
			if (!postType) continue;
			await changeDraft(tx, source, postType, { unlink: row.id }, defaultLanguage);
			if (source.published !== null) {
				const published = { values: withoutLinksTo(storedVersion(source.published).values, postType.fields, row.id) };
				await tx.update(entries, { published }, eq(entries.id, source.id));
				await saveLinks(tx, source.id, "published", linksIn(published.values, postType.fields));
			}
		}
		await tx.delete(entries, eq(entries.id, row.id));
		await clearPageCache(tx);
		const title = readValue(storedVersion(row.draft), { key: "title", language: defaultLanguage, defaultLanguage });
		await tx.audit("entry.delete", { entryId: row.id, postTypeId: row.postTypeId, title, links });
		return { deleted: true, links };
	});
}

/**
 * How a Draft changes: a change people make (with the Fields' defaults first, for a new Entry), or
 * removing the links to an Entry being deleted.
 */
type DraftEdit = { change: DraftChange; withDefaults?: boolean } | { unlink: string };

/**
 * The one place an Entry's Draft is written. Checks a change against the Post Type, refuses values
 * of the wrong kind and a slug another Entry of the Post Type has, saves the new Draft and the links
 * its Relationships make. Co-editing will apply changes to the Draft's shared document here instead
 * (ADR 0025).
 */
async function changeDraft(
	scope: SiteScope,
	row: EntryRow,
	postType: PostType,
	edit: DraftEdit,
	defaultLanguage: string,
): Promise<EntryRow> {
	const by = writerOf(scope);
	const before = storedVersion(row.draft);
	let version = before;
	let slug: string | undefined;
	let language = defaultLanguage;
	if ("unlink" in edit) {
		version = { values: withoutLinksTo(version.values, postType.fields, edit.unlink) };
		if (sameJson(version, before)) return row;
	} else {
		const { change } = edit;
		const problems: ContentProblem[] = [];
		language = change.language ?? defaultLanguage;
		if (language !== defaultLanguage) {
			problems.push({ at: "language", message: `The Site has no language ${language}.` });
		}
		const languages = { language, defaultLanguage };
		if (edit.withDefaults) {
			version = { values: { ...defaultValues(postType.fields, { ...languages, by }), ...version.values } };
		}
		if (change.title !== undefined) {
			const title = change.title.trim();
			if (title.length > ENTRY_TITLE_MAX_LENGTH) {
				problems.push({ at: "title", message: `A title has at most ${ENTRY_TITLE_MAX_LENGTH} characters.` });
			}
			version = writeValue(version, { key: "title", ...languages }, title, by);
		}
		if (change.slug !== undefined) {
			slug = change.slug.trim().toLowerCase();
			if (slug !== "" && (!ENTRY_SLUG.test(slug) || slug.length > ENTRY_SLUG_MAX_LENGTH)) {
				problems.push({
					at: "slug",
					message: `A slug is lower-case letters and digits joined by dashes, at most ${ENTRY_SLUG_MAX_LENGTH} characters.`,
				});
			}
			version = writeValue(version, { key: "slug", ...languages }, slug, by);
		}
		if (change.fields !== undefined) {
			const context: WriteContext = { ...languages, by, problems, references: [], newRowId: randomRowId };
			version = {
				values: writeFields(version.values, postType.fields, change.fields, context, "fields.", postType.name),
			};
			await checkReferences(
				scope,
				context.references.map((reference) => ({ ...reference, problems })),
				"refuse",
			);
		}
		if (problems.length > 0) throw new EntryInvalidError(problems);
		if (slug && (await slugTaken(scope, postType.id, row.id, language, slug))) throw new EntrySlugTakenError(slug);
	}

	const [saved] = await scope.update(entries, { draft: version, updatedAt: scope.now() }, eq(entries.id, row.id));
	if (!saved) throw new EntryNotFoundError();
	await saveLinks(scope, row.id, "draft", linksIn(version.values, postType.fields));
	return saved;
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

/** A slug made from `base` that no other Entry of the Post Type has: `base`, then `base-2`, `base-3`, … */
async function freeSlug(
	scope: SiteScope,
	postType: PostType,
	entryId: string,
	language: string,
	base: string,
): Promise<string> {
	const stem = base || slugify(postType.name) || "entry";
	for (let attempt = 1; ; attempt++) {
		const candidate = attempt === 1 ? stem : `${stem}-${attempt}`;
		if (!(await slugTaken(scope, postType.id, entryId, language, candidate))) return candidate;
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

/**
 * What keeps a version from being published, in a language: an empty title or slug, then every
 * Field's empty required value and broken rule, in Field order. The Entries Relationship values point
 * at are checked with `checkReferences` afterwards.
 */
export function versionFindings(
	version: EntryVersion,
	fields: readonly FieldDefinition[],
	languages: Languages,
): Findings {
	const findings: Findings = { problems: [], missing: [], references: [] };
	for (const key of ["title", "slug"] as const) {
		if (readValue(version, { key, ...languages })) continue;
		findings.problems.push({ at: key, rule: "required", message: `The Entry needs a ${key}.` });
		findings.missing.push(key);
	}
	checkFields(version.values, fields, languages, findings);
	return findings;
}

async function toEntry(
	scope: SiteScope,
	row: EntryRow,
	postType: PostType,
	language: string,
	defaultLanguage: string,
): Promise<Entry> {
	const [entry] = await entryViews(scope, [row], postType, language, defaultLanguage);
	if (!entry) throw new EntryNotFoundError();
	return entry;
}

/** Entries of one Post Type as the API shows them, with their problems and links back, in a few queries. */
async function entryViews(
	scope: SiteScope,
	rows: readonly EntryRow[],
	postType: PostType,
	language: string,
	defaultLanguage: string,
): Promise<Entry[]> {
	const languages = { language, defaultLanguage };
	const authors = await authorNames(
		scope,
		rows.map((row) => row.authorId),
	);
	const back = await linksBack(
		scope,
		rows.map((row) => row.id),
		await listPostTypes(scope),
		languages,
	);
	const findings = rows.map((row) => versionFindings(storedVersion(row.draft), postType.fields, languages));
	await checkReferences(
		scope,
		findings.flatMap((found) => found.references),
		"rule",
	);
	return rows.map((row, index) => {
		const values = (version: EntryVersion) => entryValues(version, postType.fields, languages);
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
			problems: findings[index]?.problems ?? [],
			linkedFrom: back.get(row.id) ?? [],
		};
	});
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

/** An Entry's title, slug and Field values in one language. */
export function entryValues(
	version: EntryVersion,
	fields: readonly FieldDefinition[],
	languages: Languages,
): EntryValues {
	return {
		title: readValue(version, { key: "title", ...languages }) ?? "",
		slug: readValue(version, { key: "slug", ...languages }) ?? "",
		fields: readFields(version.values, fields, languages),
	};
}

export function entryStatus(row: Pick<EntryRow, "draft" | "published">): EntryStatus {
	if (row.published === null) return "draft";
	return sameJson(row.draft, row.published) ? "published" : "changed";
}
