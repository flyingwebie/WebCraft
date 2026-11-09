import {
	components,
	consentBanners,
	designSystems,
	entries,
	filters,
	forms,
	globals,
	loops,
	postTypes,
	scripts,
	templates,
} from "@webcraft/db/schema";
import { defaultDesignSystem } from "@webcraft/renderer";
import { eq } from "drizzle-orm";

import {
	ComponentNotFoundError,
	EntryNotFoundError,
	LoopNotFoundError,
	ScriptNotFoundError,
	TemplateNotFoundError,
} from "../content/errors.ts";
import { siteLanguages } from "../content/languages.ts";
import type { PublishItem } from "../content/publishing.ts";
import { emptyVersion, readValue, storedVersion } from "../content/values.ts";
import { FilterNotFoundError } from "../filters/errors.ts";
import { FormNotFoundError } from "../forms/errors.ts";
import { isUuid } from "../ids.ts";
import type { Permission } from "../permissions/roles.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

/**
 * An item's history is kept for every publishable item, named as publishing names it: an Entry, a
 * Template, a Component, a Loop, a Filter, a script, a Form or a Form's emails by id; the Globals, the
 * Consent banner's words and the Design system, which a Site has one of, by kind alone.
 */
export type HistoryItem = PublishItem;

/** Which of the two change layers an item belongs to: Content (Members edit it) or Structure (Staff only). */
export type HistoryGroup = "content" | "structure";

/** An item as its history names it, as Publish all lists Drafts. */
export type HistoryItemSummary = {
	kind: HistoryItem["kind"];
	/** Its id; absent for the Globals, the Consent banner's words and the Design system. */
	id?: string;
	/**
	 * What it is called: an Entry's title (in the Default language, from its Draft), a Component's,
	 * Loop's, Filter's or Form's name, a page script's Entry's title. Null for the rest, which the admin
	 * names itself.
	 */
	name: string | null;
	/** The Post Type: an Entry's, or an Entry or Archive template's. */
	postType: { id: string; name: string } | null;
	/** A Template's kind (`site`, `entry`, `archive`, `search`); null for anything else. */
	templateKind: string | null;
	/** A script's kind (`site`, `page`); null for anything else. */
	scriptKind: "site" | "page" | null;
};

/** What history reads of an item as it is now. */
export type ItemState = {
	summary: HistoryItemSummary;
	group: HistoryGroup;
	/** Its Draft, as its table stores it. */
	draft: unknown;
	/** Its published version, as its table stores it; null until it is first published. */
	published: unknown;
	/** When its Draft last changed, and who changed it (null: nobody, or they are gone). */
	changedAt: Date;
	changedBy: string | null;
	/** An Entry's Post Type, whose switch says whether its Revisions are saved; null for anything else. */
	postTypeId: string | null;
};

/** The Content kinds: Members edit them; the rest is Structure. */
const CONTENT_KINDS: readonly HistoryItem["kind"][] = ["entry", "globals", "consentBanner", "formEmails"];

/**
 * The Permission reading an item's history needs: whatever reading the item itself needs. Entries,
 * the Globals and the Consent banner's words: `site.view`; a Form's emails: `formEmails.edit`; Structure
 * (Templates, Components, Loops, Filters, scripts, Forms, the Design system): `structure.edit`.
 */
export function historyReadPermission(item: Pick<HistoryItem, "kind">): Permission {
	if (item.kind === "formEmails") return "formEmails.edit";
	return item.kind === "entry" || item.kind === "globals" || item.kind === "consentBanner"
		? "site.view"
		: "structure.edit";
}

/**
 * The Permission restoring into an item's Draft needs: whatever changing its Draft needs. Entries, the
 * Globals and the Consent banner's words: `entry.edit` (Authors too); a Form's emails:
 * `formEmails.edit`; Structure: `structure.edit`.
 */
export function historyEditPermission(item: Pick<HistoryItem, "kind">): Permission {
	if (item.kind === "formEmails") return "formEmails.edit";
	return item.kind === "entry" || item.kind === "globals" || item.kind === "consentBanner"
		? "entry.edit"
		: "structure.edit";
}

/** The id an item's history rows carry: its own, or null for the items a Site has one of. */
export function itemIdOf(item: HistoryItem): string | null {
	return "id" in item ? item.id : null;
}

function summary(item: HistoryItem, name: string | null, more: Partial<HistoryItemSummary> = {}): HistoryItemSummary {
	return {
		kind: item.kind,
		...("id" in item ? { id: item.id } : {}),
		name,
		postType: null,
		templateKind: null,
		scriptKind: null,
		...more,
	};
}

/** A Post Type's id and name; null when there is none. */
async function postTypeNamed(scope: SiteScope, id: string | null): Promise<{ id: string; name: string } | null> {
	if (!id) return null;
	const row = await scope.first(postTypes, eq(postTypes.id, id));
	return row ? { id: row.id, name: row.name } : null;
}

/** An Entry's title in the Site's Default language, from its Draft. */
async function entryTitle(scope: SiteScope, draft: unknown): Promise<string> {
	const { defaultLanguage } = await siteLanguages(scope);
	return readValue(storedVersion(draft), { key: "title", language: defaultLanguage, defaultLanguage }) ?? "";
}

/**
 * An item of the scope's Site as it is now. Refuses one that isn't the Site's with its own not-found
 * error (`EntryNotFoundError`, `ComponentNotFoundError`, …). The Globals, the Consent banner's words and
 * the Design system always exist: before anyone changed them, as they start.
 */
export async function itemState(scope: SiteScope, item: HistoryItem): Promise<ItemState> {
	const group: HistoryGroup = CONTENT_KINDS.includes(item.kind) ? "content" : "structure";
	const id = itemIdOf(item);
	const known = id !== null && isUuid(id) ? id : null;
	const base = { group, postTypeId: null };
	switch (item.kind) {
		case "entry": {
			const row = known ? await scope.first(entries, eq(entries.id, known)) : undefined;
			if (!row) throw new EntryNotFoundError();
			return {
				...base,
				summary: summary(item, await entryTitle(scope, row.draft), {
					postType: await postTypeNamed(scope, row.postTypeId),
				}),
				draft: row.draft,
				published: row.published,
				changedAt: row.updatedAt,
				changedBy: row.updatedBy,
				postTypeId: row.postTypeId,
			};
		}
		case "template": {
			const row = known ? await scope.first(templates, eq(templates.id, known)) : undefined;
			if (!row) throw new TemplateNotFoundError();
			return {
				...base,
				summary: summary(item, null, {
					postType: await postTypeNamed(scope, row.postTypeId),
					templateKind: row.kind,
				}),
				draft: row.draft,
				published: row.published,
				changedAt: row.updatedAt,
				changedBy: row.updatedBy,
			};
		}
		case "component": {
			const row = known ? await scope.first(components, eq(components.id, known)) : undefined;
			if (!row) throw new ComponentNotFoundError();
			return { ...base, ...rowState(row), summary: summary(item, row.name) };
		}
		case "loop": {
			const row = known ? await scope.first(loops, eq(loops.id, known)) : undefined;
			if (!row) throw new LoopNotFoundError();
			return { ...base, ...rowState(row), summary: summary(item, row.name) };
		}
		case "filter": {
			const row = known ? await scope.first(filters, eq(filters.id, known)) : undefined;
			if (!row) throw new FilterNotFoundError();
			return { ...base, ...rowState(row), summary: summary(item, row.name) };
		}
		case "form": {
			const row = known ? await scope.first(forms, eq(forms.id, known)) : undefined;
			if (!row) throw new FormNotFoundError();
			return { ...base, ...rowState(row), summary: summary(item, row.name) };
		}
		case "formEmails": {
			const row = known ? await scope.first(forms, eq(forms.id, known)) : undefined;
			if (!row) throw new FormNotFoundError();
			return {
				...base,
				summary: summary(item, row.name),
				draft: row.emailsDraft,
				published: row.emailsPublished,
				changedAt: row.emailsUpdatedAt ?? row.updatedAt,
				changedBy: row.emailsUpdatedBy,
			};
		}
		case "script": {
			const row = known ? await scope.first(scripts, eq(scripts.id, known)) : undefined;
			if (!row) throw new ScriptNotFoundError();
			const page = row.entryId ? await scope.first(entries, eq(entries.id, row.entryId)) : undefined;
			return {
				...base,
				...rowState(row),
				summary: summary(item, page ? await entryTitle(scope, page.draft) : null, {
					scriptKind: row.kind === "page" ? "page" : "site",
				}),
			};
		}
		case "globals": {
			const row = await scope.first(globals);
			return {
				...base,
				summary: summary(item, null),
				draft: row?.draft ?? emptyVersion(),
				published: row?.published ?? null,
				changedAt: row?.updatedAt ?? scope.site.createdAt,
				changedBy: row?.updatedBy ?? null,
			};
		}
		case "consentBanner": {
			const row = await scope.first(consentBanners);
			return {
				...base,
				summary: summary(item, null),
				draft: row?.draft ?? emptyVersion(),
				published: row?.published ?? null,
				changedAt: row?.updatedAt ?? scope.site.createdAt,
				changedBy: row?.updatedBy ?? null,
			};
		}
		case "designSystem": {
			const row = await scope.first(designSystems);
			return {
				...base,
				summary: summary(item, null),
				draft: row?.draft ?? defaultDesignSystem(),
				published: row?.published ?? null,
				changedAt: row?.updatedAt ?? scope.site.createdAt,
				changedBy: row?.updatedBy ?? null,
			};
		}
	}
}

function rowState(row: {
	draft: unknown;
	published: unknown;
	updatedAt: Date;
	updatedBy: string | null;
}): Pick<ItemState, "draft" | "published" | "changedAt" | "changedBy"> {
	return { draft: row.draft, published: row.published, changedAt: row.updatedAt, changedBy: row.updatedBy };
}
