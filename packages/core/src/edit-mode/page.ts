import { entries, globals, people } from "@webcraft/db/schema";
import { builtInNotFoundPage } from "@webcraft/renderer";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import type { InstallConfig } from "../config.ts";
import { getEntry, listEntries, undoDraftChanges } from "../content/entries.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { storedFields } from "../content/fields.ts";
import { undoGlobalsChanges } from "../content/globals.ts";
import { sameJson } from "../content/json.ts";
import { siteLanguages } from "../content/languages.ts";
import { isPagePostType } from "../content/pages.ts";
import { getPostType, listPostTypes } from "../content/post-types.ts";
import { publish } from "../content/publishing.ts";
import { getEntryTemplate } from "../content/templates.ts";
import { storedVersion } from "../content/values.ts";
import { can } from "../permissions/can.ts";
import type { PageContent, PageInLanguage, SiteHost } from "../site-pages/index.ts";
import type { DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { EditFieldInvalidError, EditPathInvalidError } from "./errors.ts";
import { isEditPath } from "./paths.ts";
import type { EditItem } from "./regions.ts";

/** A value of the page that differs from what is published, as the Publish menu lists it. */
export type PageChange = {
	/** `entry:<id>` or `globals`. */
	item: string;
	/** The stored value's key: `title`, `slug`, `parent` or a Field's key. */
	key: string;
	/** The Field's label; null for an Entry's built-in values, which the editing bar names itself. */
	label: string | null;
	/** The Field's type (`text`, `richText`, …), or `text` and `parent` for built-in values. */
	type: string;
	/** Who wrote the Draft's value, when one person did; `you` when it was the person asking. */
	by: { name: string; you: boolean } | null;
};

/** What the editing bar shows about a page in Edit mode, and what its Publish menu offers. */
export type PageState = {
	page: {
		/** The page's title as its Draft has it; the 404 page's own words on the built-in 404 page. */
		title: string;
		path: string;
		/** The Entry the page shows, as its regions name it (`entry:<id>`); null on the built-in 404 page. */
		item: string | null;
	};
	/** Whether the person may publish the page's changes; Authors save them to the Draft only. */
	canPublish: boolean;
	/** The page's changes: its Entry's values, then the values of the Globals it shows. */
	changes: PageChange[];
	/** Where Publish all is, in the admin, and how many of the Site's other Drafts it would hold. */
	publishAll: { url: string; otherDrafts: number };
	/** The Site's pages, for the page switcher: the home page first, then by path. */
	pages: { title: string; path: string }[];
	/** The person in Edit mode, and the Admin language they chose (null: the Install's default). */
	person: { name: string; adminLanguage: string | null };
	site: { name: string };
	/** The language the page is shown in: its regions save in it. */
	language: { code: string; name: string };
	/** The page in each of the Site's languages, to switch to (that language's home page where it is hidden). */
	languages: PageInLanguage[];
};

/** How many of the Site's pages the page switcher lists at most. */
const PAGE_SWITCHER_LIMIT = 200;

export type PageDeps = {
	config: Pick<InstallConfig, "adminOrigin">;
	data: DataLayer;
	pageContent(host: SiteHost, pathname: string): Promise<PageContent>;
};

/** The person in Edit mode and the Site they edit, as an Edit mode session holds them. */
type Editing = { personId: string; scope: SiteScope };

/** What the editing bar shows for the page at `path`. */
export async function pageState(deps: PageDeps, editing: Editing, host: SiteHost, path: string): Promise<PageState> {
	if (!isEditPath(path)) throw new EditPathInvalidError();
	const { scope } = editing;
	const { content, items, changes } = await pageItems(deps, editing, host, path);
	const entry = content.entryId ? await getEntry(scope, content.entryId, content.language) : null;
	const [person] = await scope.db
		.select({ name: people.name, adminLanguage: people.adminLanguage })
		.from(people)
		.where(eq(people.id, editing.personId));
	return {
		page: {
			title: entry?.draft.title ?? builtInNotFoundPage(content.language).title,
			path,
			item: content.entryId ? `entry:${content.entryId}` : null,
		},
		canPublish: can(scope.access.actor, "entry.publish", {
			level: "site",
			workspaceId: scope.workspace.id,
			siteId: scope.site.id,
		}),
		changes,
		publishAll: {
			url: new URL(`/sites/${scope.site.id}`, deps.config.adminOrigin).toString(),
			otherDrafts: await otherDrafts(scope, items),
		},
		pages: await sitePages(scope),
		person: { name: person?.name ?? "", adminLanguage: person?.adminLanguage ?? null },
		site: { name: scope.site.name },
		language: {
			code: content.language,
			name: content.languages.find((language) => language.code === content.language)?.name ?? content.language,
		},
		languages: content.languages,
	};
}

/**
 * Undoes one of the page's changes: the value goes back to what is published. Refuses anything
 * that isn't one of the page's changes (`EditFieldInvalidError`).
 */
export async function undoChange(
	deps: PageDeps,
	editing: Editing,
	host: SiteHost,
	input: { path: string; item: string; key: string },
): Promise<PageState> {
	if (!isEditPath(input.path)) throw new EditPathInvalidError();
	const { items, changes } = await pageItems(deps, editing, host, input.path);
	if (!changes.some((change) => change.item === input.item && change.key === input.key)) {
		throw new EditFieldInvalidError();
	}
	const item = items.find((candidate) => nameOf(candidate) === input.item);
	if (item?.kind === "entry") await undoDraftChanges(editing.scope, item.id, [input.key]);
	else await undoGlobalsChanges(editing.scope, [input.key]);
	return pageState(deps, editing, host, input.path);
}

/** Discards the page's changes: its Entry and the Globals it shows go back to what is published, together. */
export async function discardChanges(
	deps: PageDeps,
	editing: Editing,
	host: SiteHost,
	path: string,
): Promise<PageState> {
	if (!isEditPath(path)) throw new EditPathInvalidError();
	const changed = await changedItems(deps, editing, host, path);
	await editing.scope.transaction(async (tx) => {
		for (const item of changed) {
			if (item.kind === "entry") await undoDraftChanges(tx, item.id, "all");
			else await undoGlobalsChanges(tx, "all");
		}
	});
	return pageState(deps, editing, host, path);
}

/**
 * Publishes the page: its Entry and the Globals it shows, those with changes, all or none of them.
 * Needs `entry.publish` (Authors can't); refuses Drafts that can't be published yet, as publishing
 * from the admin does.
 */
export async function publishPage(deps: PageDeps, editing: Editing, host: SiteHost, path: string): Promise<PageState> {
	if (!isEditPath(path)) throw new EditPathInvalidError();
	const changed = await changedItems(deps, editing, host, path);
	const scope = await deps.data.site(editing.scope.access, editing.scope.site.id, "entry.publish");
	await scope.transaction(async (tx) => {
		for (const item of changed) await publish(tx, item);
	});
	return pageState(deps, editing, host, path);
}

/** The page's items that have changes, its Entry first. */
async function changedItems(deps: PageDeps, editing: Editing, host: SiteHost, path: string): Promise<EditItem[]> {
	const { items, changes } = await pageItems(deps, editing, host, path);
	return items.filter((item) => changes.some((change) => change.item === nameOf(item)));
}

/**
 * What the page at `path` shows and what of it has changed: its content, its items (its Entry,
 * then the Globals when its Templates read them) and their changes.
 */
async function pageItems(
	deps: PageDeps,
	editing: Editing,
	host: SiteHost,
	path: string,
): Promise<{ content: PageContent; items: EditItem[]; changes: PageChange[] }> {
	const content = await deps.pageContent(host, path);
	const items: EditItem[] = [
		...(content.entryId ? [{ kind: "entry", id: content.entryId } as const] : []),
		...(content.readsGlobals ? [{ kind: "globals" } as const] : []),
	];
	return { content, items, changes: await changesOf(editing.scope, items, editing.personId) };
}

function nameOf(item: EditItem): string {
	return item.kind === "entry" ? `entry:${item.id}` : "globals";
}

/** Built-in values an Entry stores beside its Fields, in the order the Publish menu lists them. */
const BUILT_IN_KEYS = ["title", "slug", "parent"] as const;

/** Every stored value of the items whose Draft differs from what is published. */
async function changesOf(scope: SiteScope, items: readonly EditItem[], you: string): Promise<PageChange[]> {
	const found: (Omit<PageChange, "by"> & { writer: string | null })[] = [];
	const { defaultLanguage } = await siteLanguages(scope);
	for (const item of items) {
		let draft: Record<string, unknown>;
		let published: Record<string, unknown>;
		let fields: readonly FieldDefinition[];
		let builtIns: readonly string[] = [];
		if (item.kind === "entry") {
			const row = await scope.first(entries, eq(entries.id, item.id));
			if (!row) continue;
			draft = storedVersion(row.draft).values;
			published = storedVersion(row.published).values;
			fields = (await getPostType(scope, row.postTypeId)).fields;
			builtIns = BUILT_IN_KEYS;
		} else {
			const row = await scope.first(globals);
			draft = storedVersion(row?.draft).values;
			published = storedVersion(row?.published).values;
			fields = storedFields(row?.fields);
		}
		const keys = [
			...new Set([...builtIns, ...fields.map((field) => field.key), ...Object.keys(draft), ...Object.keys(published)]),
		];
		for (const key of keys) {
			if (sameJson(draft[key] ?? null, published[key] ?? null)) continue;
			const field = fields.find((candidate) => candidate.key === key);
			found.push({
				item: nameOf(item),
				key,
				label: field?.label ?? (builtIns.includes(key) ? null : key),
				type: field?.type ?? (key === "parent" ? "parent" : "text"),
				writer: writerOf(draft[key], defaultLanguage),
			});
		}
	}
	const ids = [...new Set(found.map((change) => change.writer).filter((id): id is string => id !== null))];
	const names = new Map(
		ids.length === 0
			? []
			: (await scope.db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, ids))).map(
					(row) => [row.id, row.name],
				),
	);
	return found.map(({ writer, ...change }) => {
		const name = writer ? names.get(writer) : undefined;
		return { ...change, by: writer && name !== undefined ? { name, you: writer === you } : null };
	});
}

/** Who wrote a stored value in the Draft: one person, for a value held per language; null otherwise. */
function writerOf(value: unknown, language: string): string | null {
	if (!value || typeof value !== "object" || "values" in value || Array.isArray(value)) return null;
	const own = (value as Record<string, { by?: { kind?: string; personId?: unknown } | null }>)[language];
	return own?.by?.kind === "person" && typeof own.by.personId === "string" ? own.by.personId : null;
}

/** How many Drafts the Site has besides the page's own: Entries and the Globals that differ from what is published. */
async function otherDrafts(scope: SiteScope, items: readonly EditItem[]): Promise<number> {
	const pageEntries = items.flatMap((item) => (item.kind === "entry" ? [item.id] : []));
	const changed = sql`${entries.draft} is distinct from ${entries.published}`;
	const count = await scope.count(
		entries,
		pageEntries.length > 0 ? and(changed, ...pageEntries.map((id) => ne(entries.id, id))) : changed,
	);
	if (items.some((item) => item.kind === "globals")) return count;
	const globalsChanged = await scope.count(
		globals,
		or(isNull(globals.published), sql`${globals.draft} is distinct from ${globals.published}`),
	);
	return count + globalsChanged;
}

/**
 * The Site's pages, for the page switcher: every published Entry with a page (its Post Type's Entry
 * template is published) and every published Page, by the title its Draft has; the home page first.
 */
async function sitePages(scope: SiteScope): Promise<{ title: string; path: string }[]> {
	const pages: { title: string; path: string }[] = [];
	for (const postType of await listPostTypes(scope)) {
		if (!isPagePostType(postType) && !(await getEntryTemplate(scope, postType.id))?.published) continue;
		for (const entry of await listEntries(scope, postType.id)) {
			if (entry.path !== null) pages.push({ title: entry.draft.title, path: entry.path });
		}
	}
	return pages
		.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)))
		.slice(0, PAGE_SWITCHER_LIMIT);
}
