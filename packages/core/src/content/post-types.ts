import { components, entries, postTypes } from "@webcraft/db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { isUniqueViolation } from "../db-errors.ts";
import { isUuid } from "../ids.ts";
import { markSearchIndexStale } from "../search/index-version.ts";
import {
	defaultSearchedFields,
	indexDefinition,
	keptSearchedFields,
	parseSearchedFields,
	type SearchedField,
} from "../search/searched-fields.ts";
import { keptPostTypeSeo, type PostTypeSeo, type PostTypeSeoChange, parsePostTypeSeo } from "../seo/seo-rules.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { checkPatternLeavesArchives } from "./archives.ts";
import { publishedAddresses } from "./entry-paths.ts";
import { type ContentProblem, PostTypeInvalidError, PostTypeNotFoundError, PostTypeTakenError } from "./errors.ts";
import {
	BUILT_IN_FIELDS,
	type BuiltInField,
	type FieldDefinition,
	type FieldInput,
	parseFields,
	RESERVED_FIELD_KEYS,
	storedFields,
} from "./fields.ts";
import { checkPatternOutsidePrefixes } from "./language-paths.ts";
import { siteLanguages } from "./languages.ts";
import { clearPageCache } from "./page-cache.ts";
import { checkPatternLeavesPages, isPagePostType, lockSitePaths, PAGE_BUILT_IN_FIELDS } from "./pages.ts";
import type { PathChange } from "./publishing.ts";
import { slugify } from "./slugs.ts";
import { parseUrlPattern } from "./url-patterns.ts";

/** A Post Type, as the content store hands it out. */
export type PostType = {
	id: string;
	siteId: string;
	/** Names it in Template markup, the APIs and files, such as `blog`. */
	key: string;
	name: string;
	/**
	 * Which built-in Post Type it is: `page` for the Page Post Type every Site has; null for one Staff
	 * made.
	 */
	builtIn: "page" | null;
	/** Where its Entries are, such as `/blog/{slug}`; `/{path}` for Pages, found by parent Page and slug. */
	urlPattern: string;
	/** The Fields it adds, in order. */
	fields: FieldDefinition[];
	/** The Fields every Entry of it has, whatever its Post Type: Pages add `parent`. */
	builtInFields: readonly (BuiltInField | "parent")[];
	/** Whether its Entries show in Site search (every Post Type is indexed; ADR 0021). */
	searchable: boolean;
	/** Its Searched fields: what Site search and Filters' search boxes look in, with their weights. */
	searchedFields: SearchedField[];
	/**
	 * Its SEO settings: the title pattern, the Fields its Entries' description and social image fall
	 * back to, and its Schema type with each property mapped (see `seo/seo-rules.ts`).
	 */
	seo: PostTypeSeo;
	/**
	 * Its Summary field (GLOSSARY.md › Summary): the text, rich text or Body field (by path) that says
	 * in short what each Entry is about; null for none. Descriptions fall back to it (else to the start
	 * of the Body field), and `llms.txt` and Markdown copies show it. It is one setting with the SEO
	 * settings' `descriptionField`, its older name: both always say the same.
	 */
	summaryField: string | null;
	/** Whether its Entries (and its Archive page) are listed in the Site's sitemaps and `llms.txt`. */
	sitemap: boolean;
	/**
	 * Whether publishing its Entries saves Revisions (the Install's own switch comes first). Revisions
	 * saved before it was turned off stay until the usual retention removes them.
	 */
	revisions: boolean;
	createdAt: Date;
	updatedAt: Date;
};

export type NewPostType = {
	name: string;
	/** Made from the name when not given. */
	key?: string;
	urlPattern: string;
	fields?: FieldInput[];
	/** Whether Site search shows its Entries; true when not given. */
	searchable?: boolean;
	/** Its Searched fields; the title (A) and its Body field (B) when not given. */
	searchedFields?: unknown[];
	/** Its SEO settings; WebCraft's defaults for the parts not given. */
	seo?: PostTypeSeoChange;
	/** Its Summary field (one setting with `seo.descriptionField`); none when not given. */
	summaryField?: unknown;
	/** Whether publishing its Entries saves Revisions; true when not given. */
	revisions?: boolean;
	/** Whether the Site's sitemaps and `llms.txt` list its Entries; true when not given. */
	sitemap?: boolean;
};

/** What can change on a Post Type. Its key can't: Templates, Loops and files name it. */
export type PostTypeChange = {
	name?: string;
	urlPattern?: string;
	fields?: FieldInput[];
	searchable?: boolean;
	/** Replaces its Searched fields. Without it, a change to its Fields keeps those whose Field is still there. */
	searchedFields?: unknown[];
	/** Changes its SEO settings: each part given replaces that part. */
	seo?: PostTypeSeoChange;
	/** Changes its Summary field (one setting with `seo.descriptionField`); null for none. */
	summaryField?: unknown;
	/** Turns Revisions of its Entries on or off. */
	revisions?: boolean;
	/** Lists its Entries in the Site's sitemaps and `llms.txt`, or leaves them out. */
	sitemap?: boolean;
};

export const POST_TYPE_NAME_MAX_LENGTH = 100;

/** A Post Type key: lower-case letters, digits and dashes, starting with a letter; at most 64. */
const POST_TYPE_KEY = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Creates a Post Type on the scope's Site (open it with `structure.edit`), and records it in the Audit
 * log. Its URL pattern owns every path it matches, so one that would take a published Page's path is
 * refused (`PathTakenError`).
 */
export async function createPostType(scope: SiteScope, input: NewPostType): Promise<PostType> {
	const problems: ContentProblem[] = [];
	const name = checkName(input.name, problems);
	const key = (input.key ?? slugify(input.name)).trim();
	if (!POST_TYPE_KEY.test(key)) {
		problems.push({
			at: "key",
			message: "A Post Type key is lower-case letters, digits and dashes, starting with a letter (at most 64).",
			rule: "postTypeKeyFormat",
		});
	}
	const urlPattern = checkUrlPattern(input.urlPattern, problems);
	// A Relationship may point at the Post Type's own Entries.
	const fields = parseFields(input.fields ?? [], problems, await defineContext(scope, key));
	const searchedFields =
		input.searchedFields === undefined
			? defaultSearchedFields(fields)
			: parseSearchedFields(input.searchedFields, fields, problems);
	const defaults = keptPostTypeSeo({}, fields);
	const seoChange = withSummary(input, problems);
	const seo =
		seoChange === undefined
			? undefined
			: summaryProblems(input, problems, () => parsePostTypeSeo(seoChange, defaults, fields, problems));
	if (problems.length > 0) throw new PostTypeInvalidError(problems);

	return saving(() =>
		scope.transaction(async (tx) => {
			await lockSitePaths(tx);
			await checkPatternLeavesArchives(tx, urlPattern);
			await checkPatternLeavesPages(tx, urlPattern);
			await checkPatternOutsidePrefixes(tx, urlPattern);
			const now = tx.now();
			const row = await tx.insert(postTypes, {
				key,
				name,
				urlPattern,
				fields,
				searchable: input.searchable ?? true,
				revisions: input.revisions ?? true,
				sitemap: input.sitemap ?? true,
				searchedFields,
				// Until Staff set them, the defaults follow its Fields.
				seo: seo ?? {},
				createdAt: now,
				updatedAt: now,
			});
			await tx.audit("postType.create", { postTypeId: row.id, key, name, urlPattern });
			return toPostType(row);
		}),
	);
}

/**
 * Changes a Post Type (open the Site with `structure.edit`). Post Types have no Draft, so a change
 * applies at once and clears the Site's page cache. A new URL pattern moves every published Entry's
 * address: `postType.update` then logs them as `pathChanges` (Redirect rules follow them).
 */
export async function updatePostType(scope: SiteScope, postTypeId: string, change: PostTypeChange): Promise<PostType> {
	const row = await findPostType(scope, postTypeId);
	const existing = { ...toPostType(row), storedSeo: row.seo };
	const problems: ContentProblem[] = [];
	const name = change.name === undefined ? existing.name : checkName(change.name, problems);
	let urlPattern = existing.urlPattern;
	if (change.urlPattern !== undefined && isPagePostType(existing)) {
		if (change.urlPattern.trim() !== existing.urlPattern) {
			problems.push({
				at: "urlPattern",
				message: "Pages are found by their parent Page and slug, so their URL pattern can't change.",
				rule: "pageUrlPattern",
			});
		}
	} else if (change.urlPattern !== undefined) {
		urlPattern = checkUrlPattern(change.urlPattern, problems);
	}
	const fields =
		change.fields === undefined
			? existing.fields
			: parseFields(change.fields, problems, await defineContext(scope, existing.key, existing), existing.fields);
	const searchedFields =
		change.searchedFields === undefined
			? keptSearchedFields(existing.searchedFields, fields)
			: parseSearchedFields(change.searchedFields, fields, problems);
	const seoChange = withSummary(change, problems);
	const seo =
		seoChange === undefined
			? undefined
			: summaryProblems(change, problems, () =>
					parsePostTypeSeo(seoChange, keptPostTypeSeo(existing.storedSeo, fields), fields, problems),
				);
	if (problems.length > 0) throw new PostTypeInvalidError(problems);
	// The search documents of its Entries are built from these: when they change, the index is rebuilt.
	const searchChanged =
		indexDefinition(existing.fields, existing.searchedFields) !== indexDefinition(fields, searchedFields);

	return saving(() =>
		scope.transaction(async (tx) => {
			let pathChanges: PathChange[] = [];
			if (urlPattern !== existing.urlPattern) {
				await lockSitePaths(tx);
				await checkPatternLeavesArchives(tx, urlPattern, existing.id);
				await checkPatternLeavesPages(tx, urlPattern);
				await checkPatternOutsidePrefixes(tx, urlPattern, existing.id);
				pathChanges = await urlPatternPathChanges(tx, existing, urlPattern);
			}
			const [row] = await tx.update(
				postTypes,
				{
					name,
					urlPattern,
					fields,
					searchable: change.searchable ?? existing.searchable,
					revisions: change.revisions ?? existing.revisions,
					sitemap: change.sitemap ?? existing.sitemap,
					searchedFields,
					...(seo ? { seo } : {}),
					updatedAt: tx.now(),
				},
				eq(postTypes.id, existing.id),
			);
			if (!row) throw new PostTypeNotFoundError();
			await clearPageCache(tx);
			if (searchChanged) await markSearchIndexStale(tx);
			await tx.audit("postType.update", {
				postTypeId: existing.id,
				key: existing.key,
				changed: Object.keys(change).filter((setting) => change[setting as keyof PostTypeChange] !== undefined),
				...(pathChanges.length > 0 ? { pathChanges } : {}),
			});
			return toPostType(row);
		}),
	);
}

/**
 * Every published address a new URL pattern moves: each published Entry of the Post Type, in each of
 * the Site's languages, from its path under the old pattern to its path under the new one.
 */
async function urlPatternPathChanges(scope: SiteScope, postType: PostType, urlPattern: string): Promise<PathChange[]> {
	const site = await siteLanguages(scope);
	const ids = (await scope.select(entries, and(eq(entries.postTypeId, postType.id), isNotNull(entries.published)))).map(
		(row) => row.id,
	);
	const changes: PathChange[] = [];
	for (const { code } of site.languages) {
		const languages = { language: code, defaultLanguage: site.defaultLanguage };
		const before = await publishedAddresses(scope, postType, ids, languages);
		const after = await publishedAddresses(scope, { ...postType, urlPattern }, ids, languages);
		for (const [entryId, address] of before) {
			const next = after.get(entryId);
			if (next && next.path !== address.path)
				changes.push({ entryId, language: code, from: address.path, to: next.path });
		}
	}
	return changes;
}

/** What defining a Post Type's Fields needs to know: the Post Types Relationships may point at. */
async function defineContext(
	scope: Pick<SiteScope, "select" | "site" | "componentSources">,
	ownKey: string,
	postType: { builtIn: string | null; fields?: readonly FieldDefinition[] } = { builtIn: null },
) {
	const keys = new Set((await listPostTypes(scope)).map((existing) => existing.key));
	keys.add(ownKey);
	// A Page's parent is one of its built-in Fields.
	const reservedKeys = isPagePostType(postType) ? new Set([...RESERVED_FIELD_KEYS, "parent"]) : RESERVED_FIELD_KEYS;
	const owner = isPagePostType(postType) ? ("page" as const) : ("postType" as const);
	// The Site's own Components, which its Body field may allow.
	const componentIds = new Set((await scope.select(components)).map((component) => component.id));
	for (const component of await scope.componentSources.moduleComponentsAt(scope.site)) componentIds.add(component.id);
	for (const field of postType.fields ?? [])
		if (field.type === "body") for (const id of field.components) if (id.includes(":")) componentIds.add(id);
	return { postTypeKeys: keys, owner, reservedKeys, componentIds };
}

/** The Post Types of the scope's Site, by name. */
export async function listPostTypes(scope: Pick<SiteScope, "select">): Promise<PostType[]> {
	const rows = await scope.select(postTypes, undefined, { orderBy: [asc(postTypes.name), asc(postTypes.key)] });
	return rows.map(toPostType);
}

/** One Post Type of the scope's Site; `PostTypeNotFoundError` when it has none with that id. */
export async function getPostType(scope: Pick<SiteScope, "first">, postTypeId: string): Promise<PostType> {
	return toPostType(await findPostType(scope, postTypeId));
}

async function findPostType(scope: Pick<SiteScope, "first">, postTypeId: string) {
	const row = isUuid(postTypeId) ? await scope.first(postTypes, eq(postTypes.id, postTypeId)) : undefined;
	if (!row) throw new PostTypeNotFoundError();
	return row;
}

/**
 * The SEO settings' change with the Summary field in it: `summaryField` and `seo.descriptionField` are
 * one setting, so a change giving both must give the same Field (`summaryFieldTwice` otherwise).
 */
function withSummary(
	change: { seo?: PostTypeSeoChange; summaryField?: unknown },
	problems: ContentProblem[],
): PostTypeSeoChange | undefined {
	if (change.summaryField === undefined) return change.seo;
	const given = change.seo?.descriptionField;
	if (given !== undefined && (given || null) !== (change.summaryField || null)) {
		problems.push({
			at: "summaryField",
			message: "summaryField and seo.descriptionField are one setting: give one of them.",
			rule: "summaryFieldTwice",
		});
	}
	return { ...change.seo, descriptionField: change.summaryField };
}

/** Reads the SEO settings, a refused Summary field reported where it was given (`summaryField`). */
function summaryProblems<Result>(
	change: { summaryField?: unknown },
	problems: ContentProblem[],
	read: () => Result,
): Result {
	const before = problems.length;
	const result = read();
	if (change.summaryField !== undefined) {
		for (let index = before; index < problems.length; index++) {
			const problem = problems[index] as ContentProblem;
			if (problem.at !== "seo.descriptionField") continue;
			problems[index] = {
				...problem,
				at: "summaryField",
				rule: "summaryField",
				message: "A Summary comes from a text, rich text or Body field of the Post Type.",
			};
		}
	}
	return result;
}

function checkName(input: string, problems: ContentProblem[]): string {
	const name = input.trim();
	if (!name || name.length > POST_TYPE_NAME_MAX_LENGTH) {
		problems.push({
			at: "name",
			message: `A Post Type's name has 1 to ${POST_TYPE_NAME_MAX_LENGTH} characters.`,
			rule: "postTypeNameLength",
			params: { max: POST_TYPE_NAME_MAX_LENGTH },
		});
	}
	return name;
}

function checkUrlPattern(input: string, problems: ContentProblem[]): string {
	const parsed = parseUrlPattern(input);
	if ("problem" in parsed) {
		problems.push({
			at: "urlPattern",
			message: parsed.problem,
			rule: parsed.rule,
			...(parsed.params ? { params: parsed.params } : {}),
		});
		return input;
	}
	return parsed.pattern;
}

/** Runs a save, turning a duplicate key or URL pattern into `PostTypeTakenError`. */
async function saving<Result>(save: () => Promise<Result>): Promise<Result> {
	try {
		return await save();
	} catch (error) {
		if (isUniqueViolation(error, "post_types_site_id_key_unique")) throw new PostTypeTakenError("key");
		if (isUniqueViolation(error, "post_types_site_id_url_pattern_unique")) throw new PostTypeTakenError("urlPattern");
		throw error;
	}
}

export function toPostType(row: typeof postTypes.$inferSelect): PostType {
	const fields = storedFields(row.fields);
	const seo = keptPostTypeSeo(row.seo, fields);
	return {
		id: row.id,
		siteId: row.siteId,
		key: row.key,
		name: row.name,
		builtIn: row.builtIn === "page" ? "page" : null,
		urlPattern: row.urlPattern,
		fields,
		builtInFields: row.builtIn === "page" ? PAGE_BUILT_IN_FIELDS : BUILT_IN_FIELDS,
		searchable: row.searchable,
		searchedFields: keptSearchedFields(row.searchedFields, fields),
		seo,
		summaryField: seo.descriptionField,
		sitemap: row.sitemap,
		revisions: row.revisions,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}
