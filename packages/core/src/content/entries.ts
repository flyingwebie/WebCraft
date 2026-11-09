import { entries, people, publishedSlugs } from "@webcraft/db/schema";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { clientNameOf } from "../audit.ts";

import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { isUuid } from "../ids.ts";
import { actingPerson, personIdOf } from "../permissions/can.ts";
import { SEO_CHECK_MESSAGES, type SeoPreview, seoReports } from "../seo/checks.ts";
import { type EntrySeo, type EntrySeoChange, readEntrySeo, writeEntrySeo } from "../seo/entry-seo.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { bodyChecksOf, type EntryCheck } from "./body-checks.ts";
import { publishedAddresses } from "./entry-paths.ts";
import {
	type ContentProblem,
	EntryInvalidError,
	EntryLinkedError,
	EntryNotFoundError,
	EntrySlugTakenError,
	PageHasChildrenError,
} from "./errors.ts";
import { ENTRY_TITLE_MAX_LENGTH } from "./field-rules.ts";
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
import { canonicalLanguage, languagesFor, siteLanguages } from "./languages.ts";
import { clearPageCache } from "./page-cache.ts";
import {
	checkDraftParent,
	childPagesOf,
	isPagePostType,
	lockSitePaths,
	pageSlugTaken,
	parentIn,
	withParent,
} from "./pages.ts";
import { getPostType, listPostTypes, type PostType } from "./post-types.ts";
import { checkReferences, type LinkBack, linkingEntries, linksBack, saveLinks } from "./relationships.ts";
import { slugify } from "./slugs.ts";
import { ENTRY_SLUG, ENTRY_SLUG_MAX_LENGTH } from "./url-patterns.ts";
import { type EntryVersion, emptyVersion, readValue, storedVersion, type Writer, writeValue } from "./values.ts";
import { hiddenLanguagesIn, withHiddenLanguages } from "./visibility.ts";

export type { EntryCheck } from "./body-checks.ts";
export { sameJson } from "./json.ts";
export { siteLanguages };

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
	/** The Site languages the Entry is hidden in: it has no page and no place in lists there. */
	hiddenLanguages: string[];
	/** Every Field of the Post Type, by key, as its type gives it (see the Field types). */
	fields: Record<string, Json>;
	/** Its SEO fields (see `seo/entry-seo.ts`): Translatable, except noindex. */
	seo: EntrySeo;
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
	/**
	 * Warnings about the Draft that never stop it being published (Checks): a body's skipped heading
	 * levels, images without alt text, vague link text, tables without a header row, untitled videos.
	 */
	checks: EntryCheck[];
	/**
	 * What search engines and other sites get from the Draft in this language, through the same
	 * fallbacks its page uses: its whole title, description and social image (with where it comes from).
	 */
	seoPreview: SeoPreview;
	/** The Entries whose Drafts point at this one through a two-way Relationship. */
	linkedFrom: LinkBack[];
	/** Where visitors find it (`/blog/fresh-bread`, `/about/team`, `/` for the home page); null until it is published. */
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
	/**
	 * Every Site language the Entry is hidden in (none: shown in all of them), shared by every
	 * language. Hiding goes live when the Entry is published.
	 */
	hiddenLanguages?: string[];
	/**
	 * Values of the Post Type's Fields, by key, each as its type takes it; null or "" clears one. A
	 * Group's value is its Fields' values by key (only those given change); a Repeater's is its whole
	 * list of rows (rows keep their `id`; rows left out are removed).
	 */
	fields?: Record<string, unknown>;
	/**
	 * Its SEO fields (`title`, `description`, `canonical`, `image`, `noindex`): only those given change;
	 * null or "" clears one. noindex is one value for every language.
	 */
	seo?: EntrySeoChange;
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

export { ENTRY_TITLE_MAX_LENGTH };

type EntryRow = typeof entries.$inferSelect;

/**
 * Creates an Entry of a Post Type on the scope's Site (open it with `entry.edit`), its Draft holding
 * the Fields' defaults and the values given. The person who creates it is its author. A slug is made
 * from the title when none is given, unique within the Post Type (for a Page, among the Pages under
 * its parent).
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
			updatedBy: personIdOf(tx.access.actor),
			updatedVia: clientNameOf(tx.access.via),
		});
		const languages = await entryLanguages(tx, input.language);
		const taken = isPagePostType(postType)
			? (candidate: string) => pageSlugTaken(tx, row, input.parentId ?? null, { ...languages, value: candidate })
			: (candidate: string) => slugTaken(tx, postType.id, row.id, languages.language, candidate);
		const slug = input.slug ?? (await freeSlug(taken, slugify(input.title) || slugify(postType.name) || "entry"));
		const { postTypeId: _, ...change } = input;
		const saved = await changeDraft(tx, row, postType, { change: { ...change, slug }, withDefaults: true }, languages);
		return toEntry(tx, saved, postType, languages);
	});
}

/**
 * Saves a change to an Entry's Draft (open the Site with `entry.edit`). Visitors see nothing of it
 * until the Entry is published. Values of the wrong kind are refused (`EntryInvalidError`); values
 * that break a rule are saved, and listed in the Entry's `problems` until they are fixed.
 */
export async function saveDraft(scope: SiteScope, entryId: string, change: DraftChange): Promise<Entry> {
	return scope.transaction(async (tx) => {
		// Moving a Page is checked against the other Pages' parents: hold them first.
		if (change.parentId !== undefined) await lockSitePaths(tx);
		const languages = await entryLanguages(tx, change.language);
		const row = await lockEntry(tx, entryId);
		const postType = await getPostType(tx, row.postTypeId);
		const saved = await changeDraft(tx, row, postType, { change }, languages);
		return toEntry(tx, saved, postType, languages);
	});
}

/** One Entry of the scope's Site, in a language (the Default language unless given). */
export async function getEntry(scope: SiteScope, entryId: string, language?: string): Promise<Entry> {
	const row = isUuid(entryId) ? await scope.first(entries, eq(entries.id, entryId)) : undefined;
	if (!row) throw new EntryNotFoundError();
	const postType = await getPostType(scope, row.postTypeId);
	return toEntry(scope, row, postType, await entryLanguages(scope, language));
}

/** The Entries of a Post Type, newest first, in a language (the Default language unless given). */
export async function listEntries(scope: SiteScope, postTypeId: string, language?: string): Promise<Entry[]> {
	const postType = await getPostType(scope, postTypeId);
	const languages = await entryLanguages(scope, language);
	const rows = await scope.select(entries, eq(entries.postTypeId, postType.id), {
		orderBy: [desc(entries.createdAt), asc(entries.id)],
	});
	return entryViews(scope, rows, postType, languages);
}

/**
 * Deletes an Entry (open the Site with `entry.delete`), in two steps. Without a confirmation it
 * deletes nothing and answers how many other Entries link to it, with a confirmation id; with that
 * id it deletes the Entry and removes the links to it from those Entries' Drafts and published
 * versions, so no Relationship points at nothing. An Entry another Entry must point at (through a
 * required Relationship) can't be deleted: `EntryLinkedError` lists those Entries. Nor can a Page with
 * Pages under it, in their Drafts or published (`PageHasChildrenError`): they would point at nothing.
 */
export async function deleteEntry(scope: SiteScope, entryId: string, confirmation?: string): Promise<EntryDeletion> {
	return scope.transaction(async (tx) => {
		const row = await lockEntry(tx, entryId);
		const allPostTypes = await listPostTypes(tx);
		const { defaultLanguage } = await siteLanguages(tx);
		const postTypeOfRow = allPostTypes.find((postType) => postType.id === row.postTypeId);
		if (postTypeOfRow && isPagePostType(postTypeOfRow)) {
			const children = await childPagesOf(tx, row, defaultLanguage);
			if (children > 0) throw new PageHasChildrenError(children);
		}
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

		await unlinkAndDelete(tx, row.id, linking, allPostTypes, defaultLanguage);
		await clearPageCache(tx);
		const title = readValue(storedVersion(row.draft), { key: "title", language: defaultLanguage, defaultLanguage });
		await tx.audit("entry.delete", { entryId: row.id, postTypeId: row.postTypeId, title, links });
		return { deleted: true, links };
	});
}

/**
 * Deletes Entries of the scope's Site at once, without asking (open the Site with `entry.delete`; the
 * caller confirmed, as Undo of an Import run does), removing the links other Entries make to them
 * from their Drafts and published versions, as `deleteEntry` does. Answers the Entries another Entry
 * outside them must point at (through a required Relationship), deleting nothing then.
 */
export async function removeEntries(scope: SiteScope, ids: readonly string[]): Promise<LinkingBlock[]> {
	return scope.transaction(async (tx) => {
		const allPostTypes = await listPostTypes(tx);
		const { defaultLanguage } = await siteLanguages(tx);
		const removing = new Set(ids);
		const plans: { id: string; linking: Awaited<ReturnType<typeof linkingEntries>> }[] = [];
		const blocked: LinkingBlock[] = [];
		for (const id of ids) {
			const row = await lockEntry(tx, id).catch((error: unknown) => {
				if (error instanceof EntryNotFoundError) return null;
				throw error;
			});
			if (!row) continue;
			const linking = (await linkingEntries(tx, row.id, allPostTypes, defaultLanguage)).filter(
				(entry) => !removing.has(entry.entryId),
			);
			for (const entry of linking.filter((candidate) => candidate.required)) {
				blocked.push({ entryId: row.id, by: { entryId: entry.entryId, title: entry.title } });
			}
			plans.push({ id: row.id, linking });
		}
		if (blocked.length > 0) return blocked;
		for (const plan of plans) await unlinkAndDelete(tx, plan.id, plan.linking, allPostTypes, defaultLanguage);
		return [];
	});
}

/** An Entry that can't be removed: another Entry must point at it. */
export type LinkingBlock = { entryId: string; by: { entryId: string; title: string } };

/**
 * What `removeEntries` would refuse, worked out without changing anything: the Entries another Entry
 * outside `ids` must point at (through a required Relationship). Empty when they can all go.
 */
export async function removalBlocks(scope: SiteScope, ids: readonly string[]): Promise<LinkingBlock[]> {
	if (ids.length === 0) return [];
	const allPostTypes = await listPostTypes(scope);
	const { defaultLanguage } = await siteLanguages(scope);
	const removing = new Set(ids);
	const blocked: LinkingBlock[] = [];
	for (const id of ids) {
		for (const entry of await linkingEntries(scope, id, allPostTypes, defaultLanguage)) {
			if (entry.required && !removing.has(entry.entryId)) {
				blocked.push({ entryId: id, by: { entryId: entry.entryId, title: entry.title } });
			}
		}
	}
	return blocked;
}

/** Removes the links `linking` Entries make to an Entry, then the Entry. */
async function unlinkAndDelete(
	tx: SiteScope,
	entryId: string,
	linking: readonly { entryId: string }[],
	allPostTypes: readonly PostType[],
	defaultLanguage: string,
): Promise<void> {
	const byId = new Map(allPostTypes.map((postType) => [postType.id, postType]));
	for (const linked of linking) {
		const source = await lockEntry(tx, linked.entryId);
		const postType = byId.get(source.postTypeId);
		if (!postType) continue;
		await changeDraft(tx, source, postType, { unlink: entryId }, { language: defaultLanguage, defaultLanguage });
		if (source.published !== null) {
			const published = { values: withoutLinksTo(storedVersion(source.published).values, postType.fields, entryId) };
			await tx.update(entries, { published }, eq(entries.id, source.id));
			await saveLinks(tx, source.id, "published", linksIn(published.values, postType.fields));
		}
	}
	await tx.delete(entries, eq(entries.id, entryId));
}

/**
 * Puts an Entry's Draft back to a version kept earlier, exactly as it was, who wrote each value
 * included (open the Site with `entry.edit`): Undo of an Import run gives back the Drafts it updated.
 */
export async function replaceDraft(scope: SiteScope, entryId: string, version: unknown): Promise<void> {
	await scope.transaction(async (tx) => {
		const languages = await entryLanguages(tx);
		const row = await lockEntry(tx, entryId);
		const postType = await getPostType(tx, row.postTypeId);
		await changeDraft(tx, row, postType, { replace: storedVersion(version) }, languages);
	});
}

/**
 * Puts values of an Entry's Draft back as they are published (open the Site with `entry.edit`):
 * the stored values named in `keys` (`title`, `slug`, `parent` and Field keys), or every value. A
 * value the published version doesn't have is removed. Edit mode's Publish menu undoes changes and
 * discards a page's Drafts with it.
 */
export async function undoDraftChanges(
	scope: SiteScope,
	entryId: string,
	keys: readonly string[] | "all",
): Promise<Entry> {
	return scope.transaction(async (tx) => {
		const languages = await entryLanguages(tx);
		const row = await lockEntry(tx, entryId);
		const postType = await getPostType(tx, row.postTypeId);
		const saved = await changeDraft(tx, row, postType, { restore: keys }, languages);
		return toEntry(tx, saved, postType, languages);
	});
}

/**
 * How a Draft changes: a change people make (with the Fields' defaults first, for a new Entry),
 * removing the links to an Entry being deleted, putting values back as they are published, or
 * putting back a version kept earlier (Undo of an Import run).
 */
type DraftEdit =
	| { change: DraftChange; withDefaults?: boolean }
	| { unlink: string }
	| { restore: readonly string[] | "all" }
	| { replace: EntryVersion };

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
	languages: Languages,
): Promise<EntryRow> {
	const { language, defaultLanguage } = languages;
	const by = writerOf(scope);
	const before = storedVersion(row.draft);
	let version = before;
	let slug: string | undefined;
	if ("unlink" in edit) {
		version = { values: withoutLinksTo(version.values, postType.fields, edit.unlink) };
		if (sameJson(version, before)) return row;
	} else if ("restore" in edit) {
		version = restoredVersion(before, storedVersion(row.published), edit.restore);
		if (sameJson(version, before)) return row;
	} else if ("replace" in edit) {
		version = edit.replace;
		if (sameJson(version, before)) return row;
	} else {
		const { change } = edit;
		const problems: ContentProblem[] = [];
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
		if (change.parentId !== undefined && change.parentId !== null && !isPagePostType(postType)) {
			problems.push({ at: "parentId", message: "Only Pages have a parent Page." });
		} else if (change.parentId !== undefined && isPagePostType(postType)) {
			if (change.parentId !== null) await checkDraftParent(scope, row, change.parentId, defaultLanguage, problems);
			version = withParent(version, change.parentId, defaultLanguage, by);
		}
		if (change.hiddenLanguages !== undefined) {
			const site = await siteLanguages(scope);
			const hidden: string[] = [];
			for (const code of change.hiddenLanguages) {
				const known = site.languages.find((candidate) => candidate.code === canonicalLanguage(code));
				if (known) hidden.push(known.code);
				else problems.push({ at: "hiddenLanguages", message: `The Site has no language ${code}.` });
			}
			version = withHiddenLanguages(version, hidden, defaultLanguage, by);
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
		if (change.seo !== undefined) {
			const context: WriteContext = { ...languages, by, problems, references: [], newRowId: randomRowId };
			version = { values: await writeEntrySeo(scope, version.values, change.seo, context) };
		}
		if (problems.length > 0) throw new EntryInvalidError(problems);
		if (isPagePostType(postType)) {
			// A Page's slug is unique among the Pages under its parent, so a move checks it too.
			const pageSlug = slug || readValue(version, { key: "slug", ...languages });
			const parentId = parentIn(version, defaultLanguage);
			const moved = slug || change.parentId !== undefined;
			if (moved && pageSlug && (await pageSlugTaken(scope, row, parentId, { ...languages, value: pageSlug }))) {
				throw new EntrySlugTakenError(pageSlug, "siblingPages", languages);
			}
		} else if (slug && (await slugTaken(scope, postType.id, row.id, language, slug))) {
			throw new EntrySlugTakenError(slug, "postType", languages);
		}
	}

	const [saved] = await scope.update(
		entries,
		{
			draft: version,
			updatedAt: scope.now(),
			updatedBy: personIdOf(scope.access.actor),
			updatedVia: clientNameOf(scope.access.via),
		},
		eq(entries.id, row.id),
	);
	if (!saved) throw new EntryNotFoundError();
	await saveLinks(scope, row.id, "draft", linksIn(version.values, postType.fields));
	return saved;
}

/**
 * A Draft with values put back as `published` has them, exactly (who wrote them included): those
 * stored under `keys`, or all of them. A key `published` doesn't have is removed.
 */
export function restoredVersion(
	draft: EntryVersion,
	published: EntryVersion,
	keys: readonly string[] | "all",
): EntryVersion {
	if (keys === "all") return { values: { ...published.values } };
	const values = { ...draft.values };
	for (const key of keys) {
		if (Object.hasOwn(published.values, key)) values[key] = published.values[key];
		else delete values[key];
	}
	return { values };
}

/** Reads an Entry for a change, holding it until the transaction ends so changes don't overlap. */
export async function lockEntry(scope: SiteScope, entryId: string): Promise<EntryRow> {
	const [row] = isUuid(entryId)
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

/**
 * The scope's Site's language `language` names (its Default language when absent), with the Default
 * language values fall back to. A language the Site doesn't have is refused (`EntryInvalidError`).
 */
export async function entryLanguages(scope: Pick<SiteScope, "db" | "site">, language?: string): Promise<Languages> {
	const languages = languagesFor(await siteLanguages(scope), language);
	if (!languages) {
		throw new EntryInvalidError([{ at: "language", message: `The Site has no language ${language}.` }]);
	}
	return languages;
}

function writerOf(scope: Pick<SiteScope, "access">): Writer {
	return { kind: "person", personId: actingPerson(scope.access.actor) };
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

async function toEntry(scope: SiteScope, row: EntryRow, postType: PostType, languages: Languages): Promise<Entry> {
	const [entry] = await entryViews(scope, [row], postType, languages);
	if (!entry) throw new EntryNotFoundError();
	return entry;
}

/** Entries of one Post Type as the API shows them, with their problems and links back, in a few queries. */
async function entryViews(
	scope: SiteScope,
	rows: readonly EntryRow[],
	postType: PostType,
	languages: Languages,
): Promise<Entry[]> {
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
	const addresses = await publishedAddresses(
		scope,
		postType,
		rows.filter((row) => row.published !== null).map((row) => row.id),
		languages,
	);
	const findings = rows.map((row) => versionFindings(storedVersion(row.draft), postType.fields, languages));
	await checkReferences(
		scope,
		findings.flatMap((found) => found.references),
		"rule",
	);
	const values = (version: EntryVersion) => entryValues(version, postType.fields, languages);
	const drafts = rows.map((row) => values(storedVersion(row.draft)));
	const checks = await bodyChecksOf(
		scope,
		postType.fields,
		drafts.map((draft) => draft.fields),
		languages,
	);
	// The SEO check, after the body's Checks; the Site's list of open Checks (#95) collects both.
	const seo = await seoReports(scope, postType, drafts, languages);
	return rows.map((row, index) => {
		const address = addresses.get(row.id);
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
			language: languages.language,
			draft: drafts[index] ?? values(storedVersion(row.draft)),
			// Visitors find it by the slug it was published with in this language, which never changes on its own.
			published:
				row.published === null
					? null
					: { ...values(storedVersion(row.published)), ...(address ? { slug: address.slug } : {}) },
			problems: findings[index]?.problems ?? [],
			checks: [
				...(checks[index] ?? []),
				...(seo[index]?.checks ?? []).map((check) => ({
					...check,
					message: SEO_CHECK_MESSAGES[check.check](check.params ?? {}),
				})),
			],
			seoPreview: seo[index]?.preview ?? { title: "", description: null, image: null },
			linkedFrom: back.get(row.id) ?? [],
			path: address?.path ?? null,
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
		parentId: parentIn(version, languages.defaultLanguage),
		hiddenLanguages: hiddenLanguagesIn(version, languages.defaultLanguage),
		fields: readFields(version.values, fields, languages),
		seo: readEntrySeo(version.values, languages),
	};
}

export function entryStatus(row: Pick<EntryRow, "draft" | "published">): EntryStatus {
	if (row.published === null) return "draft";
	return sameJson(row.draft, row.published) ? "published" : "changed";
}
