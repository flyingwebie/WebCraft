import { draftAddresses } from "../content/draft-paths.ts";
import { type DraftChange, getEntry, saveDraft } from "../content/entries.ts";
import { homePageId } from "../content/entry-paths.ts";
import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition, Json } from "../content/field-types.ts";
import { languagesFor, siteLanguages } from "../content/languages.ts";
import { getPostType } from "../content/post-types.ts";
import { MediaNotFoundError } from "../media/errors.ts";
import type { MediaLibrary } from "../media/library.ts";
import { type SeoPreview, seoReports } from "../seo/checks.ts";
import type { EntrySeo, EntrySeoChange } from "../seo/entry-seo.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { EditFieldInvalidError } from "./errors.ts";
import { type EditMediaItem, editMediaItem } from "./media.ts";
import { readEditItem } from "./regions.ts";

/**
 * Page details (Edit mode's drawer): the values of the page's Entry that don't show on the page, its
 * title, its address (its slug), its SEO fields, its Summary, its social image and noindex, each in
 * the page's language where it is translatable. They are Content (`entry.edit`, Authors too), saved to
 * the Draft through `saveDraft` as the admin's Entry editor saves them, so its refusals are the same
 * (a slug another Entry has is `ENTRY_SLUG_TAKEN`).
 */
export type PageDetails = {
	/** `entry:<id>`, as the page's regions name it. */
	item: string;
	/** The language the translatable values are in. */
	language: string;
	title: string;
	/**
	 * Where the page is (or will be, once its Draft is published): the part before its slug (`/recipes/`,
	 * a Page's parents, the language's prefix), its slug, and the whole path. The home page is at the
	 * Site's root, whatever its slug (`home`).
	 */
	address: { prefix: string; slug: string; path: string | null; home: boolean };
	/** The SEO fields as the Draft has them in the language; null where the page falls back. */
	seo: EntrySeo;
	/** What the page shows where an SEO field is empty: the title pattern, the Summary, an image. */
	fallbacks: SeoPreview;
	/** The Post Type's Summary field and its value, when it has one; a Body's can't be changed here. */
	summary: { field: string; label: string; type: string; value: Json } | null;
	/** Which values are kept per language: the title, slug and SEO fields always (noindex aside), the Summary when its Field is. */
	translatable: { title: true; slug: true; seo: true; summary: boolean };
	/** The social image the page shares now (its own, else the one it falls back to), to show; null for none. */
	image: EditMediaItem | null;
	/** Whether the Entry was published: a page never published is found at its Draft's address, which its slug moves. */
	published: boolean;
};

/** A change from the Page details drawer: only what is given changes; null or "" clears an SEO field. */
export type PageDetailsChange = {
	item: string;
	language?: string;
	title?: string;
	slug?: string;
	seo?: EntrySeoChange;
	/** The Summary field's new value (text, or rich text's HTML). */
	summary?: string | null;
};

/** The page's details, in a language (the Default language unless given). */
export async function pageDetails(
	scope: SiteScope,
	media: MediaLibrary,
	item: string,
	language?: string,
): Promise<PageDetails> {
	const entryId = entryOf(item);
	const languages = languagesFor(await siteLanguages(scope), language);
	if (!languages) throw new EditFieldInvalidError();
	const entry = await getEntry(scope, entryId, languages.language);
	const postType = await getPostType(scope, entry.postTypeId);
	const [report] = await seoReports(
		scope,
		postType,
		[
			{
				title: entry.draft.title,
				fields: entry.draft.fields,
				seo: { ...entry.draft.seo, title: null, description: null, image: null },
			},
		],
		languages,
	);
	const fallbacks: SeoPreview = report?.preview ?? { title: entry.draft.title, description: null, image: null };
	const address = (await draftAddresses(scope, postType, [entryId], languages)).get(entryId);
	const home = (await homePageId(scope)) === entryId;
	const path = address?.path ?? null;
	const slug = entry.draft.slug;
	const summaryField = postType.summaryField ? fieldAt(postType.fields, postType.summaryField) : undefined;
	const shown =
		entry.draft.seo.image ?? (fallbacks.image && "mediaId" in fallbacks.image ? fallbacks.image.mediaId : null);
	return {
		item: `entry:${entryId}`,
		language: languages.language,
		title: entry.draft.title,
		address: {
			prefix: path === null ? "" : !home && path.endsWith(slug) ? path.slice(0, path.length - slug.length) : path,
			slug,
			path,
			home,
		},
		seo: entry.draft.seo,
		fallbacks,
		summary:
			summaryField && postType.summaryField
				? {
						field: postType.summaryField,
						label: summaryField.label,
						type: summaryField.type,
						value: valueAt(entry.draft.fields, postType.summaryField),
					}
				: null,
		translatable: { title: true, slug: true, seo: true, summary: summaryField?.translatable ?? false },
		image: shown ? await shownImage(scope, media, shown, languages.language) : null,
		published: entry.published !== null,
	};
}

/**
 * Saves a change from the Page details drawer to the Entry's Draft, in a language, and answers the
 * page's details afterwards with the problems of what it changed.
 */
export async function savePageDetails(
	scope: SiteScope,
	media: MediaLibrary,
	change: PageDetailsChange,
): Promise<{ details: PageDetails; problems: ContentProblem[] }> {
	const entryId = entryOf(change.item);
	const draft: DraftChange = { language: change.language };
	if (change.title !== undefined) draft.title = change.title;
	if (change.slug !== undefined) draft.slug = change.slug;
	if (change.seo !== undefined) draft.seo = change.seo;
	let summaryPath: string | null = null;
	if (change.summary !== undefined) {
		const entry = await getEntry(scope, entryId, change.language);
		const postType = await getPostType(scope, entry.postTypeId);
		const field = postType.summaryField ? fieldAt(postType.fields, postType.summaryField) : undefined;
		// A Body's text is the block editor's; the drawer changes a text or rich text Summary.
		if (!postType.summaryField || (field?.type !== "text" && field?.type !== "richText")) {
			throw new EditFieldInvalidError();
		}
		summaryPath = postType.summaryField;
		draft.fields = nested(summaryPath, change.summary);
	}
	const saved = await saveDraft(scope, entryId, draft);
	const touched = (at: string) =>
		(change.title !== undefined && at === "title") ||
		(change.slug !== undefined && at === "slug") ||
		(change.seo !== undefined && at.startsWith("seo.")) ||
		(summaryPath !== null && at === `fields.${summaryPath}`);
	return {
		details: await pageDetails(scope, media, change.item, saved.language),
		problems: saved.problems.filter((problem) => touched(problem.at)),
	};
}

/** The Entry an item names (`entry:<id>`); the drawer has nothing for the Globals. */
function entryOf(item: string): string {
	const read = readEditItem(item);
	if (read.kind !== "entry") throw new EditFieldInvalidError();
	return read.id;
}

/** The Field at a path among `fields` (`summary`, `intro.text` inside a Group). */
function fieldAt(fields: readonly FieldDefinition[], path: string): FieldDefinition | undefined {
	let within: readonly FieldDefinition[] = fields;
	let found: FieldDefinition | undefined;
	for (const name of path.split(".")) {
		found = within.find((field) => field.key === name);
		if (!found) return undefined;
		within = found.type === "group" ? found.fields : [];
	}
	return found;
}

function valueAt(values: Record<string, Json>, path: string): Json {
	let current: Json = values;
	for (const name of path.split(".")) {
		current = current && typeof current === "object" && !Array.isArray(current) ? (current[name] ?? null) : null;
	}
	return current;
}

function nested(path: string, value: unknown): Record<string, unknown> {
	return path.split(".").reduceRight<unknown>((inner, name) => ({ [name]: inner }), value) as Record<string, unknown>;
}

/** The social image the drawer shows; null when it is no longer the Site's (deleted since). */
async function shownImage(
	scope: SiteScope,
	media: MediaLibrary,
	mediaId: string,
	language: string,
): Promise<EditMediaItem | null> {
	try {
		return editMediaItem(await media.get(scope, mediaId, language));
	} catch (error) {
		if (error instanceof MediaNotFoundError) return null;
		throw error;
	}
}
