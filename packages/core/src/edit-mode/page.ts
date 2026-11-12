import { entries, globals, loops, people } from "@webcraft/db/schema";
import { builtInNotFoundPage } from "@webcraft/renderer";
import { eq, inArray } from "drizzle-orm";

import type { InstallConfig } from "../config.ts";
import { draftAddresses } from "../content/draft-paths.ts";
import { getEntry, listEntries, undoDraftChanges } from "../content/entries.ts";
import { ItemInReviewError, PublishInvalidError, ReviewInvalidError } from "../content/errors.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { storedFields } from "../content/fields.ts";
import { undoGlobalsChanges } from "../content/globals.ts";
import { sameJson } from "../content/json.ts";
import { siteLanguages } from "../content/languages.ts";
import { storedLoopVersion, undoLoopItems } from "../content/loops.ts";
import { isPagePostType } from "../content/pages.ts";
import { getPostType, listPostTypes } from "../content/post-types.ts";
import { siteDrafts } from "../content/publish-all.ts";
import { publish } from "../content/publishing.ts";
import { currentReviews, itemKey } from "../content/review-items.ts";
import { listReviews, submitForReview, withdrawReview } from "../content/reviews.ts";
import { getEntryTemplate } from "../content/templates.ts";
import { storedVersion } from "../content/values.ts";
import { itemState } from "../history/items.ts";
import { can } from "../permissions/can.ts";
import type { PageContent, PageInLanguage, SiteHost } from "../site-pages/index.ts";
import type { DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { EditFieldInvalidError, EditPathInvalidError } from "./errors.ts";
import { isEditPath } from "./paths.ts";
import type { EditItem } from "./regions.ts";

/** A value of the page that differs from what is published, as the Publish menu lists it. */
export type PageChange = {
	/** `entry:<id>`, `globals`, or `loop:<id>` for the items of a Loop the page shows. */
	item: string;
	/** The stored value's key: `title`, `slug`, `parent`, `seo` (the SEO fields) or a Field's key; `items` for a Loop's items. */
	key: string;
	/** The Field's label; null for an Entry's built-in values, which the editing bar names itself; a Loop's name. */
	label: string | null;
	/** The Field's type (`text`, `richText`, …), or `text`, `parent` and `seo` for built-in values; `loopItems`. */
	type: string;
	/** Who wrote the Draft's value, when one person did; `you` when it was the person asking. */
	by: { name: string; you: boolean } | null;
	/**
	 * A change to Structure's Draft (a Loop's items): only those who may change Structure publish it
	 * (`canCode`), with the page; everyone who edits may change it, undo it and discard it.
	 */
	structure?: true;
};

/**
 * What a page shows that Edit mode changes: its Entry and the Globals (Content's Drafts), and the
 * Loops of their own items it shows (Loop items are Content, kept in the Loop's Draft).
 */
type PageItem = EditItem | { kind: "loop"; id: string; name: string };

/** The Review of one of the page's items, as the editing bar shows it. */
export type PageReview = {
	/** `entry:<id>` or `globals`. */
	item: string;
	status: "inReview" | "sentBack";
	/** Who submitted it (In review), or who sent it back; `you` when it was the person asking. */
	by: { name: string; you: boolean } | null;
	/** When it was submitted (In review), or sent back. */
	at: Date;
	note: string | null;
	/** Why it was sent back. */
	comment: string | null;
	/** Whether the person may withdraw it: they submitted it, and it still waits. */
	canWithdraw: boolean;
	/** Its Draft changed since it was submitted. */
	changedSinceSubmitted: boolean;
};

/** What the editing bar shows about a page in Edit mode, and what its Publish menu offers. */
export type PageState = {
	page: {
		/** The page's title as its Draft has it; the 404 page's own words on the built-in 404 page. */
		title: string;
		path: string;
		/** The Entry the page shows, as its regions name it (`entry:<id>`); null on the built-in 404 page. */
		item: string | null;
		/** Only the built-in Page Post Type has an arrangeable Page layout. */
		layout: boolean;
	};
	/** Whether the person may publish the page's changes; Authors save them to the Draft only. */
	canPublish: boolean;
	/** Whether the person may use Code mode (ADR 0016): change the Site's Structure (`structure.edit`), as Staff do. */
	canCode: boolean;
	/** The page's changes: its Entry's values, then the values of the Globals it shows. */
	changes: PageChange[];
	/**
	 * The Reviews of the page's items (GLOSSARY.md › Review): each waiting (In review), or sent back
	 * with its comment until it is submitted again or published. Authors submit the page's changes for
	 * Review instead of publishing them.
	 */
	reviews: PageReview[];
	/** Where Publish all is, in the admin, and how many of the Site's other Drafts it would hold. */
	publishAll: { url: string; otherDrafts: number };
	/** The Site's pages, for the page switcher: the home page first, then by path. */
	pages: { title: string; path: string }[];
	/** The person in Edit mode, and the Admin language they chose (null: the Install's default). */
	person: { name: string; adminLanguage: string | null };
	site: { name: string };
	/** The language the page is shown in: its regions save in it. */
	language: { code: string; name: string };
	/** The Site's Default language, which values without one of their own in the page's language show. */
	defaultLanguage: string;
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
			layout: !!entry && isPagePostType(await getPostType(scope, entry.postTypeId)),
		},
		canPublish: can(scope.access.actor, "entry.publish", {
			level: "site",
			workspaceId: scope.workspace.id,
			siteId: scope.site.id,
		}),
		canCode: can(scope.access.actor, "structure.edit", {
			level: "site",
			workspaceId: scope.workspace.id,
			siteId: scope.site.id,
		}),
		changes,
		reviews: await pageReviews(scope, items, editing.personId),
		publishAll: {
			url: publishAllUrl(deps.config.adminOrigin, scope.site.id),
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
		defaultLanguage: (await siteLanguages(scope)).defaultLanguage,
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
	else if (item?.kind === "loop") await undoLoopItems(editing.scope, item.id);
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
			else if (item.kind === "loop") await undoLoopItems(tx, item.id);
			else await undoGlobalsChanges(tx, "all");
		}
	});
	return pageState(deps, editing, host, path);
}

/**
 * Publishes the page: its Entry and the Globals it shows, those with changes, all or none of them,
 * and for those who may change Structure (Staff) the Loops whose items changed, first. Needs
 * `entry.publish` (Authors can't). Refuses Drafts that can't be published yet, as publishing from the
 * admin does, and refuses a page whose only changes are Loop items while the person may not change
 * Structure (`PublishInvalidError`): there is nothing they may publish, so nothing is. Everyone else's
 * Loop item changes wait in the Loop's Draft for Staff.
 */
export async function publishPage(deps: PageDeps, editing: Editing, host: SiteHost, path: string): Promise<PageState> {
	if (!isEditPath(path)) throw new EditPathInvalidError();
	const changed = await changedItems(deps, editing, host, path);
	const structure = holds(editing.scope, "structure.edit");
	const scope = await deps.data.site(editing.scope.access, editing.scope.site.id, "entry.publish");
	// A Loop's items are Structure's Draft: only those who may change it may publish them here.
	const publishable = changed.filter((item) => item.kind !== "loop" || structure);
	if (publishable.length === 0) throw new PublishInvalidError();
	const publishing = structure ? await deps.data.site(scope.access, scope.site.id, "structure.edit") : scope;
	const order = [
		...publishable.filter((item) => item.kind === "loop"),
		...publishable.filter((item) => item.kind !== "loop"),
	];
	await publishing.transaction(async (tx) => {
		for (const item of order) {
			if (item.kind !== "loop") await publish(tx, item);
			else await publish(tx, { kind: "loop", id: item.id });
		}
	});
	return pageState(deps, editing, host, path);
}

/** Whether the person in Edit mode holds a Permission on the Site. */
function holds(scope: SiteScope, permission: "entry.publish" | "structure.edit"): boolean {
	return can(scope.access.actor, permission, { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id });
}

/**
 * Submits the page's changes for Review, with an optional note: its changed items (its Entry, then the
 * Globals it shows) that aren't In review already, together, so the people who may publish them hear
 * of the page once. Refuses a page with nothing changed (`ReviewInvalidError`, `nothingToReview`) and
 * one whose changed items all wait already (`ItemInReviewError`).
 */
export async function submitPage(
	deps: PageDeps,
	editing: Editing,
	host: SiteHost,
	input: { path: string; note: string | null },
): Promise<PageState> {
	if (!isEditPath(input.path)) throw new EditPathInvalidError();
	// A Loop's items are Structure's Draft: Staff publish them, never through a Review.
	const changed = (await changedItems(deps, editing, host, input.path)).filter(
		(item): item is EditItem => item.kind !== "loop",
	);
	if (changed.length === 0) throw new ReviewInvalidError("nothingToReview");
	const waiting = await listReviews(editing.scope);
	const open = changed.filter((item) => !waiting.some((review) => itemKey(review.item) === nameOf(item)));
	if (open.length === 0) {
		const first = waiting.find((review) => itemKey(review.item) === nameOf(changed[0] as EditItem));
		throw new ItemInReviewError(first?.item ?? null, first?.id ?? "");
	}
	await submitForReview(editing.scope, open, input.note);
	return pageState(deps, editing, host, input.path);
}

/** Withdraws the Reviews of the page's items that the person submitted and that still wait. */
export async function withdrawPage(deps: PageDeps, editing: Editing, host: SiteHost, path: string): Promise<PageState> {
	if (!isEditPath(path)) throw new EditPathInvalidError();
	const { items } = await pageItems(deps, editing, host, path);
	const names = new Set(items.map(nameOf));
	for (const review of await listReviews(editing.scope)) {
		if (review.canWithdraw && names.has(itemKey(review.item))) await withdrawReview(editing.scope, review.id);
	}
	return pageState(deps, editing, host, path);
}

/** The Reviews of the page's items, as the editing bar shows them. */
async function pageReviews(scope: SiteScope, pageItems: readonly PageItem[], you: string): Promise<PageReview[]> {
	const items = pageItems.filter((item): item is EditItem => item.kind !== "loop");
	const states = await Promise.all(
		items.map(async (item) => {
			const state = await itemState(scope, item);
			return { item, draft: state.draft, name: state.summary.name, postType: state.summary.postType };
		}),
	);
	const found = await currentReviews(scope, states);
	return items.flatMap((item) => {
		const review = found.get(nameOf(item));
		if (!review || (review.status !== "inReview" && review.status !== "sentBack")) return [];
		const person = review.status === "inReview" ? review.submittedBy : review.decidedBy;
		return [
			{
				item: nameOf(item),
				status: review.status,
				by: person ? { name: person.name, you: person.id === you } : null,
				at: review.status === "inReview" ? review.submittedAt : (review.decidedAt ?? review.submittedAt),
				note: review.note,
				comment: review.comment,
				canWithdraw: review.canWithdraw,
				changedSinceSubmitted: review.changedSinceSubmitted,
			},
		];
	});
}

/** The page's items that have changes, its Entry first. */
async function changedItems(deps: PageDeps, editing: Editing, host: SiteHost, path: string): Promise<PageItem[]> {
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
): Promise<{ content: PageContent; items: PageItem[]; changes: PageChange[] }> {
	const content = await deps.pageContent(host, path);
	const shownLoops =
		content.loops.length === 0 ? [] : await editing.scope.select(loops, inArray(loops.name, content.loops));
	const items: PageItem[] = [
		...(content.entryId ? [{ kind: "entry", id: content.entryId } as const] : []),
		...(content.readsGlobals ? [{ kind: "globals" } as const] : []),
		...shownLoops
			.filter((row) => storedLoopVersion(row.draft).source === "items")
			.sort((a, b) => content.loops.indexOf(a.name) - content.loops.indexOf(b.name))
			.map((row) => ({ kind: "loop" as const, id: row.id, name: row.name })),
	];
	return { content, items, changes: await changesOf(editing.scope, items, editing.personId, content.language) };
}

function nameOf(item: PageItem): string {
	return item.kind === "globals" ? "globals" : `${item.kind}:${item.id}`;
}

/** Built-in values an Entry stores beside its Fields, in the order the Publish menu lists them. */
const BUILT_IN_KEYS = ["title", "slug", "parent", "seo"] as const;

/** Every stored value of the items whose Draft differs from what is published. */
async function changesOf(
	scope: SiteScope,
	items: readonly PageItem[],
	you: string,
	language: string,
): Promise<PageChange[]> {
	const found: (Omit<PageChange, "by"> & { writer: string | null })[] = [];
	const { defaultLanguage } = await siteLanguages(scope);
	for (const item of items) {
		if (item.kind === "loop") {
			// A Loop's items, as one change: they differ from what is published (or there are some, while
			// it was never published). Changes to the rest of its Draft are Staff's, in the admin.
			const row = await scope.first(loops, eq(loops.id, item.id));
			if (!row) continue;
			const draftItems = storedLoopVersion(row.draft).values.items ?? null;
			const publishedItems = row.published === null ? null : (storedLoopVersion(row.published).values.items ?? null);
			if (sameJson(draftItems, publishedItems) || (row.published === null && isEmptyItems(draftItems))) continue;
			found.push({
				item: nameOf(item),
				key: "items",
				label: row.name,
				type: "loopItems",
				structure: true,
				writer: row.updatedBy,
			});
			continue;
		}
		let draft: Record<string, unknown>;
		let published: Record<string, unknown>;
		let fields: readonly FieldDefinition[];
		let builtIns: readonly string[] = [];
		if (item.kind === "entry") {
			const row = await scope.first(entries, eq(entries.id, item.id));
			if (!row) continue;
			if (!sameJson(storedVersion(row.draft).layout ?? null, storedVersion(row.published).layout ?? null))
				found.push({
					item: nameOf(item),
					key: "layout",
					label: "Page layout",
					type: "pageLayout",
					writer: row.updatedBy,
				});
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
				type: field?.type ?? (key === "parent" || key === "seo" ? key : "text"),
				// Who wrote it in the page's language; a shared value is kept under the Default language.
				writer: writerOf(draft[key], language) ?? writerOf(draft[key], defaultLanguage),
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

/** Whether a Loop's stored items hold no item. */
function isEmptyItems(items: unknown): boolean {
	const rows = items && typeof items === "object" ? (items as { rows?: unknown }).rows : undefined;
	return !Array.isArray(rows) || rows.length === 0;
}

/** Who wrote a stored value in the Draft: one person, for a value held per language; null otherwise. */
function writerOf(value: unknown, language: string): string | null {
	if (!value || typeof value !== "object" || "values" in value || Array.isArray(value)) return null;
	const own = (value as Record<string, { by?: { kind?: string; personId?: unknown } | null }>)[language];
	return own?.by?.kind === "person" && typeof own.by.personId === "string" ? own.by.personId : null;
}

/** Where Publish all is in the admin: the Site's pages, with its list open. */
function publishAllUrl(adminOrigin: string, siteId: string): string {
	const url = new URL(`/sites/${siteId}`, adminOrigin);
	url.searchParams.set("publishAll", "1");
	return url.toString();
}

/**
 * How many of the Site's Drafts Publish all would hold for the person besides the page's own: every
 * Draft they may publish (Content, and Structure for Staff), but the page's Entry and the Globals.
 */
async function otherDrafts(scope: SiteScope, items: readonly PageItem[]): Promise<number> {
	const own = new Set(items.map(nameOf));
	const drafts = await siteDrafts(scope);
	const nameOfDraft = (item: { kind: string; id?: string }) =>
		item.kind === "entry" || item.kind === "loop" ? `${item.kind}:${item.id}` : item.kind;
	return drafts.filter((draft) => draft.canPublish && !own.has(nameOfDraft(draft.item))).length;
}

/**
 * The Site's pages, for the page switcher: every Entry with a page (its Post Type's Entry template is
 * published) and every Page, by the title its Draft has, at its published address, or at its Draft's
 * while it was never published; the home page first.
 */
async function sitePages(scope: SiteScope): Promise<{ title: string; path: string }[]> {
	const pages: { title: string; path: string }[] = [];
	const { defaultLanguage } = await siteLanguages(scope);
	for (const postType of await listPostTypes(scope)) {
		if (!isPagePostType(postType) && !(await getEntryTemplate(scope, postType.id))?.published) continue;
		const listed = await listEntries(scope, postType.id);
		const drafts = await draftAddresses(
			scope,
			postType,
			listed.filter((entry) => entry.path === null).map((entry) => entry.id),
			{ language: defaultLanguage, defaultLanguage },
		);
		for (const entry of listed) {
			const path = entry.path ?? drafts.get(entry.id)?.path ?? null;
			if (path !== null) pages.push({ title: entry.draft.title, path });
		}
	}
	return pages
		.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)))
		.slice(0, PAGE_SWITCHER_LIMIT);
}
