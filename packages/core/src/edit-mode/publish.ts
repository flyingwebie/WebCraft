import { components, entries, loops, scripts, siteLanguages as siteLanguageRows } from "@webcraft/db/schema";
import { type ElementTree, loopNamesIn, placementsIn } from "@webcraft/renderer";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { InstallConfig } from "../config.ts";
import { storedComponentVersion } from "../content/component-versions.ts";
import { type SiteDraft, siteDrafts } from "../content/publish-all.ts";
import type { PublishItem } from "../content/publishing.ts";
import { getArchiveTemplate, getEntryTemplate, getSearchTemplate, getSiteTemplate } from "../content/templates.ts";
import { storedVersion } from "../content/values.ts";
import { domainOrigin, verifiedDomains } from "../domains/addresses.ts";
import { can } from "../permissions/can.ts";
import { stagingUrl } from "../site-pages/addresses.ts";
import type { SiteHost } from "../site-pages/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type PageChange, type PageDeps, type PageReview, pageState } from "./page.ts";

/**
 * Publish in the building area's bottom bar (ADR 0037 › 1.5, plan BA-12): what the open document and
 * the place in view have changed, in one list, and what publishing them publishes. The shell then
 * publishes those items together through Publish all's two calls (`publishing.publishAll`), so the
 * rules, the order and the confirmation are Publish all's.
 *
 * - Content: the page's own changes (its Entry, the Globals it shows, the Loops of its own items it
 *   shows), one row per value as the editing bar's Publish menu listed them, each with its Revert.
 * - Structure, for those who may change it (`structure.edit`, Staff): the Templates rendering the page,
 *   the Components they place (and those a Page's layout places, at any depth), the Loops they name,
 *   the Site script and the page's own script, and the Design system; one row per item.
 * - What the shell names besides (`sources`): the Template or Component open as the document when no
 *   page shows it, and what the place in view has open (the Design system in Styles, a Loop, a
 *   Component, the Globals).
 *
 * Only items whose Draft differs from what is published are listed (they are Publish all's Drafts).
 */

/** Something the shell names for Publish besides the page: the open document, or what the place in view has open. */
export type PublishSource =
	| { kind: "siteTemplate" }
	| { kind: "searchTemplate" }
	| { kind: "entryTemplate" | "archiveTemplate"; postTypeId: string }
	| { kind: "component" | "loop"; id: string }
	| { kind: "designSystem" }
	| { kind: "globals" };

/** One of the page's changed values, with when its item changed last. */
export type PublishChange = PageChange & { at: Date | null };

/** A whole item listed as one row (a Template, a Component, the Design system…), as Publish all lists it. */
export type PublishDraft = {
	item: PublishItem;
	group: SiteDraft["group"];
	name: string | null;
	templateKind: string | null;
	scriptKind: "site" | "page" | null;
	postType: { id: string; name: string } | null;
	status: SiteDraft["status"];
	/** Who changed it last; `you` when it was the person asking. */
	by: { name: string; you: boolean } | null;
	at: Date;
	canPublish: boolean;
};

/** What Publish shows and publishes for the open document and the place in view. */
export type DocumentPublish = {
	/** Whether the person may publish (Authors send their changes for Review instead). */
	canPublish: boolean;
	/** Whether the person may change Structure: Structure rows are listed and published for them only. */
	canCode: boolean;
	/** The page the frame shows, when it shows one. */
	page: { title: string; path: string } | null;
	/** The page's changed values: Content, one row each, with Revert. */
	changes: PublishChange[];
	/** Whole items, one row each: Structure for Staff, and the Content a place names without a page. */
	drafts: PublishDraft[];
	/** What Publish publishes: every listed item the person may publish, for `publishing.publishAll`. */
	items: PublishItem[];
	/** The Reviews of the page's items (Authors send them, then may withdraw them). */
	reviews: PageReview[];
	/** How many of the Site's other Drafts the person may publish (Publish all in the admin holds them). */
	otherDrafts: number;
	/** Publish all in the admin. */
	publishAll: string;
	/**
	 * The Site's languages that AI translation keeps up to date once the Default language is published:
	 * Automatic (published together) and Review (waits in the Draft for a person).
	 */
	translations: { code: string; name: string; mode: "automatic" | "review" }[];
	/**
	 * The published page as visitors see it, on an address other than the building area's own (a load
	 * on its own address opens the building area again); null when the Site has no other address.
	 */
	live: string | null;
};

export type PublishDeps = PageDeps & { config: InstallConfig };

/** The person in Edit mode and the Site they edit, as an Edit mode session holds them. */
type Editing = { personId: string; scope: SiteScope };

/** How many Components deep a page's Placements are followed (a Component placing itself stops at once). */
const COMPONENT_DEPTH = 20;

/** What Publish shows for the page at `path` (null when the frame shows none) and the `sources` the shell names. */
export async function documentPublish(
	deps: PublishDeps,
	editing: Editing,
	host: SiteHost,
	input: { path: string | null; sources: readonly PublishSource[] },
): Promise<DocumentPublish> {
	const { scope } = editing;
	const canCode = holds(scope, "structure.edit");
	const canPublish = holds(scope, "entry.publish");
	const state = input.path === null ? null : await pageState(deps, editing, host, input.path);
	const drafts = await siteDrafts(scope);
	const byKey = new Map(drafts.map((draft) => [keyOf(draft.item), draft]));

	// The page's own changes: Content, one row per value.
	const changes: PublishChange[] = (state?.changes ?? []).map((change) => ({
		...change,
		at: byKey.get(change.item)?.changedAt ?? null,
	}));
	const pageKeys = new Set(changes.map((change) => change.item));

	// Whole items: what the page shows of Structure (Staff only), and what the shell names.
	const wanted = new Set<string>();
	if (canCode) {
		if (input.path !== null) for (const key of await pageStructure(deps, scope, host, input.path)) wanted.add(key);
		for (const key of await sourceStructure(scope, input.sources)) wanted.add(key);
	}
	if (input.sources.some((source) => source.kind === "globals")) wanted.add("globals");
	const rows = drafts.filter((draft) => wanted.has(keyOf(draft.item)) && !pageKeys.has(keyOf(draft.item)));

	// What Publish publishes: the page's changed items, then the rows, each only if the person may.
	const items: PublishItem[] = [];
	for (const key of pageKeys) {
		const draft = byKey.get(key);
		if (draft?.canPublish) items.push(draft.item);
	}
	for (const draft of rows) if (draft.canPublish) items.push(draft.item);

	const listed = new Set([...pageKeys, ...rows.map((draft) => keyOf(draft.item))]);
	return {
		canPublish,
		canCode,
		page: state ? { title: state.page.title, path: state.page.path } : null,
		changes,
		drafts: rows.map((draft) => ({
			item: draft.item,
			group: draft.group,
			name: draft.name,
			templateKind: draft.templateKind,
			scriptKind: draft.scriptKind,
			postType: draft.postType,
			status: draft.status,
			by: draft.changedBy ? { name: draft.changedBy.name, you: draft.changedBy.id === editing.personId } : null,
			at: draft.changedAt,
			canPublish: draft.canPublish,
		})),
		items,
		reviews: state?.reviews ?? [],
		otherDrafts: drafts.filter((draft) => draft.canPublish && !listed.has(keyOf(draft.item))).length,
		publishAll: publishAllUrl(deps.config.adminOrigin, scope.site.id),
		translations: await translatedLanguages(scope),
		live: input.path === null ? null : await liveAddress(deps.config, scope, host, input.path),
	};
}

/** Whether the person in Edit mode holds a Permission on the Site. */
function holds(scope: SiteScope, permission: "entry.publish" | "structure.edit"): boolean {
	return can(scope.access.actor, permission, { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id });
}

/** An item as Publish all's Drafts and a page's changes name it: `entry:<id>`, `globals`, `designSystem`. */
function keyOf(item: PublishItem): string {
	return "id" in item ? `${item.kind}:${item.id}` : item.kind;
}

/**
 * The Structure a page shows, as Drafts name it: the Site template and the Template rendering the
 * page's content, the Components they and the page's layout place (in their Drafts, at any depth),
 * the Loops they name, the Site script and the page's script, and the Design system.
 */
async function pageStructure(deps: PageDeps, scope: SiteScope, host: SiteHost, path: string): Promise<Set<string>> {
	const keys = new Set<string>(["designSystem"]);
	const content = await deps.pageContent(host, path);
	const trees: ElementTree[] = [];
	const placed: string[] = [];
	const site = await getSiteTemplate(scope);
	if (site) {
		keys.add(`template:${site.id}`);
		trees.push(site.draft);
	}
	const target = content.contentTemplate;
	const template = !target
		? null
		: target.kind === "searchTemplate"
			? await getSearchTemplate(scope)
			: target.kind === "archiveTemplate"
				? await getArchiveTemplate(scope, target.postTypeId)
				: await getEntryTemplate(scope, target.postTypeId);
	if (template) {
		keys.add(`template:${template.id}`);
		trees.push(template.draft);
	}
	if (content.entryId) {
		const entry = await scope.first(entries, eq(entries.id, content.entryId));
		const layout = entry ? storedVersion(entry.draft).layout : undefined;
		for (const placement of layout?.placements ?? []) placed.push(placement.component);
		const own = await scope.first(scripts, and(eq(scripts.kind, "page"), eq(scripts.entryId, content.entryId)));
		if (own) keys.add(`script:${own.id}`);
	}
	const siteScript = await scope.first(scripts, and(eq(scripts.kind, "site"), isNull(scripts.entryId)));
	if (siteScript) keys.add(`script:${siteScript.id}`);
	const { componentIds, loopNames } = await followPlacements(scope, trees, placed);
	for (const id of componentIds) keys.add(`component:${id}`);
	for (const id of await loopIds(scope, [...content.loops, ...loopNames])) keys.add(`loop:${id}`);
	return keys;
}

/** The Structure the shell names (the open Template or Component, a place's Loop or the Design system), with what they place. */
async function sourceStructure(scope: SiteScope, sources: readonly PublishSource[]): Promise<Set<string>> {
	const keys = new Set<string>();
	const trees: ElementTree[] = [];
	const placed: string[] = [];
	for (const source of sources) {
		if (source.kind === "designSystem") keys.add("designSystem");
		else if (source.kind === "loop") keys.add(`loop:${source.id}`);
		else if (source.kind === "component") placed.push(source.id);
		else if (source.kind !== "globals") {
			const template =
				source.kind === "siteTemplate"
					? await getSiteTemplate(scope)
					: source.kind === "searchTemplate"
						? await getSearchTemplate(scope)
						: "postTypeId" in source
							? source.kind === "archiveTemplate"
								? await getArchiveTemplate(scope, source.postTypeId)
								: await getEntryTemplate(scope, source.postTypeId)
							: null;
			if (template) {
				keys.add(`template:${template.id}`);
				trees.push(template.draft);
			}
		}
	}
	if (trees.length === 0 && placed.length === 0) return keys;
	const { componentIds, loopNames } = await followPlacements(scope, trees, placed);
	for (const id of componentIds) keys.add(`component:${id}`);
	for (const id of await loopIds(scope, loopNames)) keys.add(`loop:${id}`);
	return keys;
}

/**
 * The Site's own Components placed in `trees` (and `placed` themselves), following each Component's
 * Draft to the Components it places, with every Loop name they hold on the way.
 */
async function followPlacements(
	scope: SiteScope,
	trees: readonly ElementTree[],
	placed: readonly string[],
): Promise<{ componentIds: string[]; loopNames: string[] }> {
	const loopNames = new Set(trees.flatMap((tree) => loopNamesIn(tree)));
	const found = new Set<string>();
	let next = [
		...new Set([...placed, ...trees.flatMap((tree) => [...placementsIn(tree.nodes)].map((p) => p.component))]),
	];
	for (let depth = 0; depth < COMPONENT_DEPTH && next.length > 0; depth++) {
		// Module Components have no Draft of the Site's own: only ids of the Site's rows are read.
		const ids = next.filter((id) => !found.has(id) && /^[0-9a-f-]{36}$/.test(id));
		if (ids.length === 0) break;
		const rows = await scope.select(components, inArray(components.id, ids));
		next = [];
		for (const row of rows) {
			found.add(row.id);
			const tree = storedComponentVersion(row.draft).tree as ElementTree;
			for (const name of loopNamesIn(tree)) loopNames.add(name);
			for (const placement of placementsIn(tree.nodes)) next.push(placement.component);
		}
	}
	return { componentIds: [...found], loopNames: [...loopNames] };
}

/** The ids of the Site's Loops by name. */
async function loopIds(scope: SiteScope, names: readonly string[]): Promise<string[]> {
	const unique = [...new Set(names)];
	if (unique.length === 0) return [];
	return (await scope.select(loops, inArray(loops.name, unique))).map((row) => row.id);
}

/** The Site's languages AI translation writes into when the Default language is published. */
async function translatedLanguages(scope: SiteScope): Promise<DocumentPublish["translations"]> {
	const rows = await scope.db
		.select({ code: siteLanguageRows.code, name: siteLanguageRows.name, mode: siteLanguageRows.translationMode })
		.from(siteLanguageRows)
		.where(eq(siteLanguageRows.siteId, scope.site.id))
		.orderBy(siteLanguageRows.position, siteLanguageRows.code);
	return rows.flatMap((row) =>
		row.mode === "automatic" || row.mode === "review" ? [{ code: row.code, name: row.name, mode: row.mode }] : [],
	);
}

/**
 * The page on the Site's other address, as visitors see it: on the Staging address when the building
 * area is on a domain of the Site's, on the verified Primary domain when it is on the Staging address.
 */
async function liveAddress(
	config: InstallConfig,
	scope: SiteScope,
	host: SiteHost,
	path: string,
): Promise<string | null> {
	let origin: string | null;
	if (host.address === "staging") {
		const { primary } = await verifiedDomains(scope.db, scope.site);
		origin = primary ? domainOrigin(config, primary) : null;
	} else origin = stagingUrl(config, scope.site.slug);
	if (!origin || origin === host.origin) return null;
	return new URL(path, origin).toString();
}

/** Where Publish all is in the admin: the Site's pages, with its list open. */
function publishAllUrl(adminOrigin: string, siteId: string): string {
	const url = new URL(`/sites/${siteId}`, adminOrigin);
	url.searchParams.set("publishAll", "1");
	return url.toString();
}
