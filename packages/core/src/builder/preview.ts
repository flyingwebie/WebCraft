/**
 * The builder's canvas: one tree rendered as the Site renders it (the same renderer, escaping and
 * URL rules), with real values where the Site has them, and nothing of the Site's scripts. Every
 * element is tagged with its id (`data-wc-code="b#<id>"`, an element shown by a Placement with the
 * Placement's id first), so the builder finds what was clicked and draws its outlines over the
 * canvas itself, never in the Site's HTML. What only a page has (its content at `{{@outlet}}`, a
 * Form, the Search element, the theme toggle, the Language switcher, Cookie settings) shows as a
 * placeholder the builder words.
 */
import { entries, globals, people } from "@webcraft/db/schema";
import {
	type ElementTree,
	escapeAttribute,
	mediaReferencesIn,
	type PageMedia,
	pageWords,
	renderTree,
	type TemplateValue,
	type ValueReader,
} from "@webcraft/renderer";
import { desc, eq } from "drizzle-orm";

import type { ComponentSources } from "../content/components.ts";
import { entryStatus, entryValues } from "../content/entries.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { linksIn } from "../content/field-values.ts";
import { globalsVersion } from "../content/globals.ts";
import { siteLanguages } from "../content/languages.ts";
import { listPostTypes, type PostType } from "../content/post-types.ts";
import { propValue } from "../content/props.ts";
import { entryParts, globalsParts, type Parts, placementValues, resolvePath } from "../content/render-values.ts";
import { storedVersion } from "../content/values.ts";
import { uuidsIn } from "../ids.ts";
import { pageMedia } from "../media/page-media.ts";
import { pageComponents } from "../site-pages/index.ts";
import { pageLoops } from "../site-pages/loops.ts";
import { relatedEntries } from "../site-pages/related.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import type { SourceKind } from "./sources.ts";

/** Where the admin shows a Site's Media files: the canvas is on the admin host, not the Site's. */
export function adminMediaPath(siteId: string): string {
	return `/api/media/${siteId}/`;
}

/** The tag the canvas gives every element: `b#<id>`, after the Placements showing it (`b/<placement id>#<id>`). */
export const CANVAS_SOURCE = "b";

/** What only a page shows, which the canvas shows as a placeholder the builder words. */
export type CanvasPlaceholder =
	| "outlet"
	| "form"
	| "filter"
	| "search"
	| "themeToggle"
	| "languageSwitcher"
	| "consentSettings";

/** What the builder previews: a tree of one kind, with a Component's Props as it has them. */
export type PreviewInput = {
	kind: SourceKind;
	postType: PostType | null;
	props: readonly FieldDefinition[] | null;
	tree: ElementTree;
	/** The class name of a Class or token utility id, from the Design system's Draft. */
	className(classId: string): string | undefined;
	/** The key of a Form of the Site, for its placeholder. */
	formKey(formId: string): string | undefined;
	/** The name of a Filter of the Site, for its placeholder. */
	filterName(filterId: string): string | undefined;
};

/** The canvas's HTML for a tree, in the Site's Default language. */
export async function renderPreview(scope: SiteScope, sources: ComponentSources, input: PreviewInput): Promise<string> {
	const site = await siteLanguages(scope);
	const language = site.languages.find((each) => each.code === site.defaultLanguage);
	const code = language?.code ?? site.defaultLanguage;
	const languages = { language: code, defaultLanguage: code };
	const globalValues = globalsVersion(await scope.first(globals), languages, "draft");
	const siteValues = globalsParts(globalValues.fields, globalValues.values, { language: code, name: scope.site.name });
	const postTypes = await listPostTypes(scope);

	let root: Parts = { text: null, part: (name) => (name === "site" ? siteValues : undefined) };
	let current: string | null = null;
	let contentValues: unknown = null;
	if (input.kind === "entry" && input.postType) {
		const sample = await sampleEntry(scope, input.postType, postTypes, languages, siteValues);
		if (sample) ({ root, current, values: contentValues } = sample);
	}
	let values: ValueReader = (path) => resolvePath(root, path);
	if (input.kind === "component") {
		const outer = values;
		values = placementValues(input.props ?? [], new Map(), outer, {
			site: siteValues,
			related: new Map(),
			read: propValue,
		});
	}
	const placed = await pageComponents(scope, [input.tree], sources, siteValues, languages, { which: "draft" });
	const searchable = postTypes.filter((postType) => postType.searchable).map((postType) => postType.key);
	const loops = await pageLoops(
		scope,
		[input.tree, ...placed.trees],
		{
			current,
			languages,
			page: input.kind === "archive" ? 1 : null,
			path: "/",
			version: "published",
			...(input.kind === "search" ? { search: { query: "", postTypes: searchable } } : {}),
		},
		postTypes,
	);
	const shown = await pageMedia(
		scope,
		[
			...mediaReferencesIn(JSON.stringify([input.tree, placed.trees])),
			...uuidsIn(JSON.stringify([contentValues, globalValues.values, loops.values])),
		],
		languages,
	);
	const placeholder = (kind: CanvasPlaceholder, name?: string) =>
		`<span data-wc-builder-placeholder="${kind}"${name ? ` data-wc-builder-name="${escapeAttribute(name)}"` : ""}></span>`;
	return renderTree(input.tree, {
		values: withPlaceholders(values),
		language: code,
		className: input.className,
		outlet: () => placeholder("outlet"),
		themeToggle: () => placeholder("themeToggle"),
		languageSwitcher: () => placeholder("languageSwitcher"),
		search: () => placeholder("search"),
		consentSettings: () => placeholder("consentSettings"),
		form: (formId) => placeholder("form", input.formKey(formId)),
		filter: (node) => placeholder("filter", input.filterName(node.filter)),
		media: (id) => onAdminHost(shown.get(id), scope.site.id),
		words: pageWords(code),
		loop: loops.run,
		component: placed.render,
		time: { now: scope.now(), changesAt: () => {} },
		codeSource: CANVAS_SOURCE,
	});
}

/** The Entry of the Post Type saved last, as its page shows it from its Draft: what the Data tab shows too. */
async function sampleEntry(
	scope: SiteScope,
	postType: PostType,
	postTypes: readonly PostType[],
	languages: { language: string; defaultLanguage: string },
	site: Parts,
): Promise<{ root: Parts; current: string; values: unknown } | undefined> {
	const row = await scope.first(entries, eq(entries.postTypeId, postType.id), { orderBy: [desc(entries.updatedAt)] });
	if (!row) return undefined;
	const version = storedVersion(row.draft);
	const draft = entryValues(version, postType.fields, languages);
	const [author] = row.authorId
		? await scope.db.select({ name: people.name }).from(people).where(eq(people.id, row.authorId))
		: [];
	const builtIns: Record<string, TemplateValue> = {
		title: draft.title,
		slug: draft.slug,
		status: entryStatus(row),
		author: author?.name ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
	};
	const related = await relatedEntries(
		scope,
		postTypes,
		linksIn(version.values, postType.fields).map((link) => link.targetId),
		languages,
	);
	return {
		root: entryParts(builtIns, postType.fields, draft.fields, { related, site }),
		current: row.id,
		values: [draft.fields, [...related.values()].map((entry) => entry.values)],
	};
}

/**
 * Values with something to show where the Site has none yet: a binding with no value shows as it is
 * written (`{{ summary }}`), so an empty element doesn't vanish from the canvas.
 */
function withPlaceholders(values: ValueReader): ValueReader {
	return (path) => {
		const value = values(path);
		return value === undefined || value === null || value === "" ? `{{ ${path} }}` : value;
	};
}

/** A Media item with its files where the admin serves them. */
function onAdminHost(media: PageMedia | undefined, siteId: string): PageMedia | undefined {
	if (!media) return undefined;
	const moved = (url: string) => (url.startsWith("/_media/") ? `${adminMediaPath(siteId)}${url.slice(8)}` : url);
	return {
		...media,
		url: moved(media.url),
		sources: media.sources.map((source) => ({
			...source,
			candidates: source.candidates.map((candidate) => ({ ...candidate, url: moved(candidate.url) })),
		})),
	};
}
