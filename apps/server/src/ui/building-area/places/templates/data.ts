import type { BuildingAreaApiClient } from "@webcraft/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BuildingDocument } from "../../documents.ts";
import { managementApi } from "../../management.ts";

/** One Template the Site can have, made or not, as `templates.list` answers it. */
export type TemplateListing = Awaited<ReturnType<BuildingAreaApiClient["templates"]["list"]>>["templates"][number];

export type TemplateKind = TemplateListing["kind"];

/** A Template as the place draws it: what it is, whether it is made, and on how many pages it shows. */
export type TemplateCard = {
	kind: TemplateKind;
	postType: { id: string; name: string } | null;
	/** Made: its id and status. Null while it isn't. */
	template: { id: string; status: "draft" | "published" | "changed" } | null;
	/**
	 * Where it shows once published: `every` page (the Site template), or how many pages (an Entry
	 * template: its Post Type's published Entries; an Archive or the Search results template: one).
	 * Null for a Template never published, which shows nowhere yet.
	 */
	shownOn: "every" | number | null;
};

/** A column of the place (`places-content/04`): the Site's Templates, or one Post Type's. */
export type TemplateColumn = {
	/** `site`, or the Post Type's id. */
	key: string;
	postType: { id: string; name: string } | null;
	/** The Templates made, in the column's order (Site, then Search results; Entry, then Archive). */
	made: TemplateCard[];
	/** The kinds not made yet that can be: what its "+" lists. */
	makeable: TemplateCard[];
};

/** What the Templates place shows: its columns, or that the person may not change Templates. */
export type TemplatesData = { columns: TemplateColumn[] } | { forbidden: true };

/** The order of a column: the Site template before the Search results template, Entry before Archive. */
const ORDER: Record<TemplateKind, number> = { site: 0, search: 1, entry: 0, archive: 1 };

/** The reason a call failed, as a code (`network` when the server didn't answer one). */
export function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "network";
}

/** The document a Template opens as (ADR 0037 › Addresses). */
export function documentOf(card: Pick<TemplateCard, "kind" | "postType">): BuildingDocument | null {
	if (card.kind === "site") return { kind: "siteTemplate" };
	if (card.kind === "search") return { kind: "searchTemplate" };
	if (!card.postType) return null;
	return card.kind === "entry"
		? { kind: "entryTemplate", postTypeId: card.postType.id, entryId: null }
		: { kind: "archiveTemplate", postTypeId: card.postType.id };
}

/** Groups the Site's Templates into the place's columns: the Site's, then one per Post Type, in the API's order. */
export function columnsOf(
	listed: readonly TemplateListing[],
	published: ReadonlyMap<string, number>,
): TemplateColumn[] {
	const columns = new Map<string, TemplateColumn>();
	for (const each of listed) {
		const key = each.postType?.id ?? "site";
		let column = columns.get(key);
		if (!column) {
			column = { key, postType: each.postType, made: [], makeable: [] };
			columns.set(key, column);
		}
		const status = each.template?.status ?? null;
		const live = status === "published" || status === "changed";
		const shownOn: TemplateCard["shownOn"] = !live
			? null
			: each.kind === "site"
				? "every"
				: each.kind === "entry"
					? (published.get(each.postType?.id ?? "") ?? 0)
					: 1;
		const card: TemplateCard = {
			kind: each.kind,
			postType: each.postType,
			template: each.template ? { id: each.template.id, status: each.template.status } : null,
			shownOn,
		};
		if (card.template) column.made.push(card);
		else if (!each.unavailable) column.makeable.push(card);
	}
	for (const column of columns.values()) {
		column.made.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
		column.makeable.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
	}
	return [...columns.values()];
}

/** What reading the place gives: its data (null until read), a failure, and reading again. */
export type TemplatesState = {
	data: TemplatesData | null;
	failed: string | null;
	reload(): Promise<void>;
	api: BuildingAreaApiClient;
};

/**
 * Reads the Templates place each time it opens: every Template the Site can have (`templates.list`)
 * and, for each Post Type whose Entry template is published, how many of its Entries are published
 * (the pages that template shows on).
 */
export function useTemplatesData(token: string, siteId: string): TemplatesState {
	const api = useMemo(() => managementApi(token), [token]);
	const [data, setData] = useState<TemplatesData | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const alive = useRef(true);

	const read = useCallback(async () => {
		let listed: TemplateListing[];
		try {
			listed = (await api.templates.list({ siteId })).templates;
		} catch (error) {
			if (codeOf(error) !== "FORBIDDEN") throw error;
			if (alive.current) setData({ forbidden: true });
			return;
		}
		const shown = listed.filter(
			(each) =>
				each.kind === "entry" &&
				each.postType &&
				(each.template?.status === "published" || each.template?.status === "changed"),
		);
		const counts = await Promise.all(
			shown.map(async (each) => {
				const postTypeId = each.postType?.id ?? "";
				const { entries } = await api.entries.list({ siteId, postTypeId });
				return [postTypeId, entries.filter((entry) => entry.status !== "draft").length] as const;
			}),
		);
		if (!alive.current) return;
		setData({ columns: columnsOf(listed, new Map(counts)) });
		setFailed(null);
	}, [api, siteId]);

	useEffect(() => {
		alive.current = true;
		read().catch((error: unknown) => {
			if (alive.current) setFailed(codeOf(error));
		});
		return () => {
			alive.current = false;
		};
	}, [read]);

	return { data, failed, reload: read, api };
}

/** A new Template's first Draft: the Site template holds the page's <main> and its outlet; the rest start empty. */
export async function makeTemplate(
	api: BuildingAreaApiClient,
	siteId: string,
	card: Pick<TemplateCard, "kind" | "postType">,
): Promise<void> {
	const empty = { version: 1, nodes: [] };
	const postTypeId = card.postType?.id ?? "";
	switch (card.kind) {
		case "site":
			await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
			return;
		case "search":
			await api.templates.saveSearchTemplate({ siteId, tree: empty });
			return;
		case "entry":
			await api.templates.saveEntryTemplateMarkup({
				siteId,
				postTypeId,
				markup: "<article><h1>{{ title }}</h1></article>",
			});
			return;
		case "archive":
			await api.templates.saveArchiveTemplate({ siteId, postTypeId, tree: empty });
			return;
	}
}

/**
 * Revert to published: the published tree becomes the Draft again, saved as any Draft is (a
 * Checkpoint of what was there). Nothing changes for visitors.
 */
export async function revertTemplate(
	api: BuildingAreaApiClient,
	siteId: string,
	card: Pick<TemplateCard, "kind" | "postType">,
): Promise<void> {
	const postTypeId = card.postType?.id ?? "";
	switch (card.kind) {
		case "site": {
			const { template } = await api.templates.getSiteTemplate({ siteId });
			if (template?.published) await api.templates.saveSiteTemplate({ siteId, tree: template.published });
			return;
		}
		case "search": {
			const { template } = await api.templates.getSearchTemplate({ siteId });
			if (template?.published) await api.templates.saveSearchTemplate({ siteId, tree: template.published });
			return;
		}
		case "entry": {
			const { template } = await api.templates.getEntryTemplate({ siteId, postTypeId });
			if (template?.published) await api.templates.saveEntryTemplate({ siteId, postTypeId, tree: template.published });
			return;
		}
		case "archive": {
			const { template } = await api.templates.getArchiveTemplate({ siteId, postTypeId });
			if (template?.published)
				await api.templates.saveArchiveTemplate({ siteId, postTypeId, tree: template.published });
			return;
		}
	}
}
