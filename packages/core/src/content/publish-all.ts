import {
	components,
	consentBanners,
	designSystems,
	entries,
	filters,
	forms,
	globals,
	loops,
	people,
	scripts,
	templates,
} from "@webcraft/db/schema";
import { defaultDesignSystem, type ElementTree, placementsIn, readDesignSystem } from "@webcraft/renderer";
import { inArray, sql } from "drizzle-orm";

import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { CONSENT_TEXT_FIELDS } from "../consent/text.ts";
import { can } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { storedComponentVersion } from "./component-versions.ts";
import { type ComponentSources, NO_MODULE_COMPONENTS } from "./components.ts";
import { draftAddresses } from "./draft-paths.ts";
import type { FieldDefinition } from "./field-types.ts";
import { storedFields } from "./fields.ts";
import { draftVersion, sameJson } from "./json.ts";
import { siteLanguages } from "./languages.ts";
import { isPagePostType, parentIn } from "./pages.ts";
import { listPostTypes } from "./post-types.ts";
import {
	type Published,
	type PublishItem,
	publishItems,
	publishPermission,
	requirePublishPermissions,
} from "./publishing.ts";
import { readValue, storedVersion } from "./values.ts";

/**
 * Publish all (ADR 0014): every Draft of a Site, listed for the person reviewing them, and the ticked
 * ones published together. A Draft is an item whose Draft differs from what is published: an Entry
 * (never published ones too), the Globals, a Form's emails, the Consent banner's words (Content); a Template, a
 * Component, a Loop, a Filter, a script, a Form, the Design system (Structure). Site settings have no Draft
 * (ADR 0025) and are never part of it, nor are Redirect rules.
 */

/** Which of the two change layers a Draft belongs to: Content (Editors and Owners publish it) or Structure (Staff only). */
export type DraftGroup = "content" | "structure";

/** One Draft of a Site, as Publish all lists it. */
export type SiteDraft = {
	item: PublishItem;
	group: DraftGroup;
	/**
	 * What it is called, as its Draft names it: an Entry's title (in the Default language), a
	 * Component's, Loop's, Filter's or Form's name, a page script's Entry's title. Null for the Globals, the
	 * Consent banner, the Design system, the Site script and Templates, which the admin names itself.
	 */
	name: string | null;
	/** The Post Type: an Entry's, or an Entry or Archive template's. */
	postType: { id: string; name: string } | null;
	/** A Template's kind (`site`, `entry`, `archive`, `search`); null for anything else. */
	templateKind: string | null;
	/** A script's kind (`site`, `page`); null for anything else. */
	scriptKind: "site" | "page" | null;
	/** `new`: never published; `changed`: its Draft differs from what is published. */
	status: "new" | "changed";
	/**
	 * What changed: the values of an Entry, the Globals or the Consent banner's words that differ from
	 * what is published (a Field's key and label; built-in values such as `title` have no label), or
	 * the Design system's sections (`tokens`, `classes`, `baseStyles`, `customCss`, `darkMode`).
	 * Empty for the rest, and for anything never published.
	 */
	changes: { key: string; label: string | null }[];
	/**
	 * Who changed the Draft last, and the API client or AI client they changed it through (`via`, its
	 * name; null in the admin or Edit mode): "<person> via <client>". Null when nobody did (an Import,
	 * a Module) or they are gone.
	 */
	changedBy: { id: string; name: string; via: string | null } | null;
	changedAt: Date;
	/** Whether the person may publish it: Structure needs `structure.edit`, Content `entry.publish`. */
	canPublish: boolean;
	/** Where it shows on the Staging address: an Entry's Draft address; null for the rest. */
	path: string | null;
	/** The Draft's version: what a Publish all confirmation was asked for. */
	version: string;
};

/** Publish all's first call: what would go live, in the order it would, and the id that confirms it. */
export type PublishAllPreview = {
	published: false;
	preview: { items: { item: PublishItem; name: string | null; status: "new" | "changed" }[] };
	confirmation: Confirmation;
};

/** Publish all's second call: what was published, in the order it was. */
export type PublishAllDone = { published: true; items: Published[] };

/**
 * Items Publish all was asked for that aren't Drafts of the Site: another Site's, unknown, or with
 * nothing to publish. Nothing is published.
 */
export class PublishAllInvalidError extends Error {
	override name = "PublishAllInvalidError";
	readonly items: PublishItem[];
	constructor(items: PublishItem[]) {
		super("Some of these items have no Draft to publish on this Site. Look at the list of Drafts again.");
		this.items = items;
	}
}

/**
 * One of the ticked items couldn't be published, so none of them was (they go live together or not at
 * all). `item` and `name` say which; `cause` is the reason it gave, as publishing it alone would.
 */
export class PublishAllRefusedError extends Error {
	override name = "PublishAllRefusedError";
	readonly item: PublishItem;
	readonly itemName: string | null;
	override readonly cause: unknown;
	constructor(item: PublishItem, itemName: string | null, cause: unknown) {
		super(`Nothing was published: ${itemName ?? item.kind} can't be published yet.`);
		this.item = item;
		this.itemName = itemName;
		this.cause = cause;
	}
}

/** The action Publish all's confirmations are for. */
const PUBLISH_ALL_ACTION = "site.publishAll";

/** The Design system's sections, in the order its changes are listed. */
const DESIGN_SYSTEM_SECTIONS = ["tokens", "classes", "baseStyles", "customCss", "darkMode"] as const;

/** Built-in values an Entry stores beside its Fields, in the order its changes are listed. */
const ENTRY_BUILT_INS = ["title", "slug", "parent", "seo", "hiddenLanguages"];

/** The order Templates are listed and published in, by kind. */
const TEMPLATE_KINDS = ["site", "entry", "archive", "search"];

/** An empty version: what never-published Globals and Consent banner words are compared with. */
const NOTHING = { values: {} };

/** Every Draft of the Site: Content first (Entries, newest change first, the Globals, the Consent banner), then Structure. */
export async function siteDrafts(scope: SiteScope): Promise<SiteDraft[]> {
	const postTypes = await listPostTypes(scope);
	const { defaultLanguage } = await siteLanguages(scope);
	const languages = { language: defaultLanguage, defaultLanguage };
	const resource = { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id } as const;
	const drafts: Omit<SiteDraft, "changedBy" | "canPublish">[] = [];
	const writers: (string | null)[] = [];
	const vias: (string | null)[] = [];
	const add = (
		draft: Omit<SiteDraft, "changedBy" | "canPublish">,
		writer: { updatedBy: string | null; updatedVia: string | null },
	) => {
		drafts.push(draft);
		writers.push(writer.updatedBy);
		vias.push(writer.updatedVia);
	};
	const postTypeOf = (id: string | null) => {
		const found = postTypes.find((postType) => postType.id === id);
		return found ? { id: found.id, name: found.name } : null;
	};
	const status = (published: unknown) => (published === null ? "new" : "changed");

	// Content: Entries whose Draft differs from what is published, newest change first.
	const changedEntries = await scope.select(entries, sql`${entries.draft} is distinct from ${entries.published}`, {
		orderBy: [sql`${entries.updatedAt} desc`, entries.id],
	});
	const paths = new Map<string, string>();
	for (const postType of postTypes) {
		const ids = changedEntries.filter((row) => row.postTypeId === postType.id).map((row) => row.id);
		for (const [id, address] of await draftAddresses(scope, postType, ids, languages)) paths.set(id, address.path);
	}
	for (const row of changedEntries) {
		const postType = postTypes.find((candidate) => candidate.id === row.postTypeId);
		const draft = storedVersion(row.draft);
		add(
			{
				item: { kind: "entry", id: row.id },
				group: "content",
				name: readValue(draft, { key: "title", language: defaultLanguage, defaultLanguage }) ?? "",
				postType: postTypeOf(row.postTypeId),
				templateKind: null,
				scriptKind: null,
				status: status(row.published),
				changes:
					row.published === null
						? []
						: valueChanges(draft, storedVersion(row.published), postType?.fields ?? [], ENTRY_BUILT_INS),
				changedAt: row.updatedAt,
				path: paths.get(row.id) ?? null,
				version: draftVersion(row.draft),
			},
			row,
		);
	}
	const globalsRow = await scope.first(globals);
	if (globalsRow && !sameJson(globalsRow.draft, globalsRow.published ?? NOTHING)) {
		add(
			{
				item: { kind: "globals" },
				group: "content",
				name: null,
				postType: null,
				templateKind: null,
				scriptKind: null,
				status: status(globalsRow.published),
				changes: valueChanges(
					storedVersion(globalsRow.draft),
					storedVersion(globalsRow.published ?? NOTHING),
					storedFields(globalsRow.fields),
					[],
				),
				changedAt: globalsRow.updatedAt,
				path: null,
				version: draftVersion(globalsRow.draft),
			},
			globalsRow,
		);
	}
	// A Form's emails (its Notifications and Auto-reply) are Content of their own, beside the Form.
	const changedEmails = await scope.select(
		forms,
		sql`${forms.emailsDraft} is not null and ${forms.emailsDraft} is distinct from ${forms.emailsPublished}`,
		{ orderBy: [forms.name] },
	);
	for (const row of changedEmails) {
		add(
			{
				item: { kind: "formEmails", id: row.id },
				group: "content",
				name: row.name,
				postType: null,
				templateKind: null,
				scriptKind: null,
				status: row.emailsPublished === null ? "new" : "changed",
				changes: (row.emailsPublished === null ? [] : (["notifications", "autoReply"] as const))
					.filter(
						(key) =>
							!sameJson(
								(row.emailsDraft as Record<string, unknown> | null)?.[key] ?? null,
								(row.emailsPublished as Record<string, unknown> | null)?.[key] ?? null,
							),
					)
					.map((key) => ({ key, label: null })),
				changedAt: row.emailsUpdatedAt ?? row.updatedAt,
				path: null,
				version: draftVersion(row.emailsDraft),
			},
			{ updatedBy: row.emailsUpdatedBy, updatedVia: row.emailsUpdatedVia },
		);
	}
	const banner = await scope.first(consentBanners);
	if (banner && !sameJson(banner.draft, banner.published ?? NOTHING)) {
		add(
			{
				item: { kind: "consentBanner" },
				group: "content",
				name: null,
				postType: null,
				templateKind: null,
				scriptKind: null,
				status: status(banner.published),
				changes: valueChanges(
					storedVersion(banner.draft),
					storedVersion(banner.published ?? NOTHING),
					CONSENT_TEXT_FIELDS,
					[],
				),
				changedAt: banner.updatedAt,
				path: null,
				version: draftVersion(banner.draft),
			},
			banner,
		);
	}

	// Structure: the Design system, then Components, Loops, Filters, Forms, Templates and scripts.
	const designSystem = await scope.first(designSystems);
	if (designSystem) {
		const draft = readDesignSystem(designSystem.draft);
		const published = designSystem.published ? readDesignSystem(designSystem.published) : defaultDesignSystem();
		const sections = DESIGN_SYSTEM_SECTIONS.filter((section) => !sameJson(draft[section], published[section]));
		if (sections.length > 0) {
			add(
				{
					item: { kind: "designSystem" },
					group: "structure",
					name: null,
					postType: null,
					templateKind: null,
					scriptKind: null,
					status: status(designSystem.published),
					changes: sections.map((key) => ({ key, label: null })),
					changedAt: designSystem.updatedAt,
					path: null,
					version: draftVersion(designSystem.draft),
				},
				designSystem,
			);
		}
	}
	const changedComponents = await scope.select(
		components,
		sql`${components.draft} is distinct from ${components.published}`,
		{ orderBy: [components.name] },
	);
	for (const row of changedComponents) {
		add(structure({ kind: "component", id: row.id }, row, row.name), row);
	}
	const changedLoops = await scope.select(loops, sql`${loops.draft} is distinct from ${loops.published}`, {
		orderBy: [loops.name],
	});
	for (const row of changedLoops) {
		add(structure({ kind: "loop", id: row.id }, row, row.name), row);
	}
	const changedFilters = await scope.select(filters, sql`${filters.draft} is distinct from ${filters.published}`, {
		orderBy: [filters.name],
	});
	for (const row of changedFilters) {
		add(structure({ kind: "filter", id: row.id }, row, row.name), row);
	}
	const changedForms = await scope.select(forms, sql`${forms.draft} is distinct from ${forms.published}`, {
		orderBy: [forms.name],
	});
	for (const row of changedForms) {
		add(structure({ kind: "form", id: row.id }, row, row.name), row);
	}
	const changedTemplates = (
		await scope.select(templates, sql`${templates.draft} is distinct from ${templates.published}`)
	).sort(
		(a, b) =>
			TEMPLATE_KINDS.indexOf(a.kind) - TEMPLATE_KINDS.indexOf(b.kind) ||
			(postTypeOf(a.postTypeId)?.name ?? "").localeCompare(postTypeOf(b.postTypeId)?.name ?? ""),
	);
	for (const row of changedTemplates) {
		add(
			{
				...structure({ kind: "template", id: row.id }, row, null),
				postType: postTypeOf(row.postTypeId),
				templateKind: row.kind,
			},
			row,
		);
	}
	const changedScripts = await scope.select(
		scripts,
		sql`${scripts.draftHash} is distinct from ${scripts.publishedHash} and not (${scripts.published} is null and btrim(${scripts.draft}) = '')`,
	);
	const pageTitles = await entryTitles(
		scope,
		changedScripts.flatMap((row) => (row.entryId ? [row.entryId] : [])),
		defaultLanguage,
	);
	for (const row of changedScripts.sort((a, b) => (a.kind === "site" ? -1 : b.kind === "site" ? 1 : 0))) {
		const kind = row.kind === "page" ? "page" : "site";
		add(
			{
				...structure(
					{ kind: "script", id: row.id },
					{ ...row, draft: row.draftHash },
					row.entryId ? (pageTitles.get(row.entryId) ?? "") : null,
				),
				scriptKind: kind,
			},
			row,
		);
	}

	const names = await namesOf(scope, writers);
	return drafts.map((draft, index) => {
		const writer = writers[index] ?? null;
		const name = writer ? names.get(writer) : undefined;
		return {
			...draft,
			changedBy: writer && name !== undefined ? { id: writer, name, via: vias[index] ?? null } : null,
			canPublish: can(scope.access.actor, publishPermission(draft.item), resource),
		};
	});
}

/** How many of the Site's Drafts the person may publish: what the admin's Publish all says beside its name. */
export async function countDrafts(scope: SiteScope): Promise<number> {
	return (await siteDrafts(scope)).filter((draft) => draft.canPublish).length;
}

/**
 * Publish all, in two calls (spec › Management API): without `confirmation`, it works out what the
 * ticked items would publish, in the order they would go live, and asks the person to confirm; with
 * the id it answered, it publishes them, all or none, in one transaction: every item is checked as
 * publishing it alone checks it, in the order they need each other (the Design system, Loops, Forms
 * and Components before the Templates that use them, a Page's parent before it), the Site's page
 * cache is cleared once, and each item writes its own Audit log entry (its Webhooks and Module events
 * follow once it is saved), then Publish all writes one of its own (`site.publishAll`).
 *
 * Open the Site with `site.view`; every item needs its own Permission (`publishPermission`), so a
 * Member ticking Structure is refused (`PermissionDeniedError`). Items that aren't Drafts of the
 * Site are refused (`PublishAllInvalidError`); an item that can't be published stops all of them
 * (`PublishAllRefusedError`, with its reason); a Draft changed after the preview asks for a new
 * confirmation (`ConfirmationInvalidError`).
 */
export async function publishAll(
	scope: SiteScope,
	items: readonly PublishItem[],
	confirmation: string | undefined,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<PublishAllPreview | PublishAllDone> {
	requirePublishPermissions(scope, items);
	const ordered = async (reader: SiteScope) => {
		const drafts = await siteDrafts(reader);
		const keyOf = (item: PublishItem) => `${item.kind}:${"id" in item ? item.id : ""}`;
		const byKey = new Map(drafts.map((draft) => [keyOf(draft.item), draft]));
		const unique = [...new Map(items.map((item) => [keyOf(item), item])).values()];
		const unknown = unique.filter((item) => !byKey.has(keyOf(item)));
		if (unknown.length > 0) throw new PublishAllInvalidError(unknown);
		const chosen = unique.map((item) => byKey.get(keyOf(item)) as SiteDraft);
		return publishOrder(reader, chosen);
	};
	const previewOf = (chosen: readonly SiteDraft[]) => ({
		items: chosen.map((draft) => ({ item: draft.item, version: draft.version })),
	});
	const request = (chosen: readonly SiteDraft[]) => ({
		action: PUBLISH_ALL_ACTION,
		target: scope.site.id,
		preview: previewOf(chosen),
	});

	if (!confirmation) {
		const chosen = await ordered(scope);
		return {
			published: false,
			preview: { items: chosen.map((draft) => ({ item: draft.item, name: draft.name, status: draft.status })) },
			confirmation: await askConfirmation(scope, request(chosen)),
		};
	}
	return scope.transaction(async (tx) => {
		const chosen = await ordered(tx);
		await useConfirmation(tx, confirmation, request(chosen));
		const published = await publishItems(
			tx,
			chosen.map((draft) => draft.item),
			sources,
			(item, error) => {
				const draft = chosen.find((candidate) => sameJson(candidate.item, item));
				return new PublishAllRefusedError(item, draft?.name ?? null, error);
			},
		);
		await tx.audit(PUBLISH_ALL_ACTION, {
			count: published.length,
			items: chosen.map((draft) => draft.item),
		});
		return { published: true, items: published };
	});
}

/**
 * The order items go live in, so each finds what it needs already published: the Design system,
 * Loops, Filters, Forms and their emails, Components (one before those placing it), Templates, scripts, the
 * Globals, the Consent banner's words, then Entries (a Page after its parent).
 */
async function publishOrder<Chosen extends { item: PublishItem }>(
	scope: SiteScope,
	chosen: readonly Chosen[],
): Promise<Chosen[]> {
	const rank: Record<PublishItem["kind"], number> = {
		designSystem: 0,
		loop: 1,
		filter: 2,
		form: 3,
		formEmails: 4,
		component: 5,
		template: 6,
		script: 7,
		globals: 8,
		consentBanner: 9,
		entry: 10,
	};
	const byKind = [...chosen].sort((a, b) => rank[a.item.kind] - rank[b.item.kind]);
	const componentOrder = await componentsInOrder(
		scope,
		chosen.flatMap((draft) => (draft.item.kind === "component" ? [draft.item.id] : [])),
	);
	const entryOrder = await entriesInOrder(
		scope,
		chosen.flatMap((draft) => (draft.item.kind === "entry" ? [draft.item.id] : [])),
	);
	const within = (draft: Chosen) =>
		draft.item.kind === "component"
			? componentOrder.indexOf(draft.item.id)
			: draft.item.kind === "entry"
				? entryOrder.indexOf(draft.item.id)
				: 0;
	return byKind.sort((a, b) => rank[a.item.kind] - rank[b.item.kind] || within(a) - within(b));
}

/**
 * Items in the order they go live together (`publishOrder`), each as its Draft is now: what a Publish
 * all set scheduled for later is stored in.
 */
export async function orderForPublish(scope: SiteScope, items: readonly PublishItem[]): Promise<PublishItem[]> {
	return (
		await publishOrder(
			scope,
			items.map((item) => ({ item })),
		)
	).map(({ item }) => item);
}

/** Components, each after the Components its Draft places (directly or not). */
async function componentsInOrder(scope: SiteScope, ids: readonly string[]): Promise<string[]> {
	if (ids.length === 0) return [];
	const rows = await scope.select(components, inArray(components.id, [...ids]));
	const places = new Map(
		rows.map((row) => [
			row.id,
			Array.from(
				placementsIn((storedComponentVersion(row.draft).tree as ElementTree).nodes),
				(placement) => placement.component,
			),
		]),
	);
	const ordered: string[] = [];
	const visiting = new Set<string>();
	const visit = (id: string) => {
		if (ordered.includes(id) || visiting.has(id)) return;
		visiting.add(id);
		for (const placed of places.get(id) ?? []) if (places.has(placed)) visit(placed);
		ordered.push(id);
	};
	for (const id of ids) visit(id);
	return ordered;
}

/** Entries, Pages first, each Page after its Draft parent; the rest as they came. */
async function entriesInOrder(scope: SiteScope, ids: readonly string[]): Promise<string[]> {
	if (ids.length === 0) return [];
	const { defaultLanguage } = await siteLanguages(scope);
	const postTypes = await listPostTypes(scope);
	const pagesId = postTypes.find(isPagePostType)?.id;
	const rows = await scope.select(entries, inArray(entries.id, [...ids]));
	const parentOf = new Map(
		rows.map((row) => [
			row.id,
			row.postTypeId === pagesId ? parentIn(storedVersion(row.draft), defaultLanguage) : null,
		]),
	);
	const depth = (id: string, seen = new Set<string>()): number => {
		const parent = parentOf.get(id);
		if (!parent || !parentOf.has(parent) || seen.has(id)) return 0;
		seen.add(id);
		return 1 + depth(parent, seen);
	};
	const isPage = (id: string) => rows.find((row) => row.id === id)?.postTypeId === pagesId;
	return [...ids].sort((a, b) => Number(isPage(b)) - Number(isPage(a)) || depth(a) - depth(b));
}

/** A Structure item's listing: its name, `new` or `changed`, who and when. */
function structure(
	item: PublishItem,
	row: { draft: unknown; published: unknown; updatedAt: Date },
	name: string | null,
): Omit<SiteDraft, "changedBy" | "canPublish"> {
	return {
		item,
		group: "structure",
		name,
		postType: null,
		templateKind: null,
		scriptKind: null,
		status: row.published === null ? "new" : "changed",
		changes: [],
		changedAt: row.updatedAt,
		path: null,
		version: draftVersion(row.draft),
	};
}

/**
 * The values of a version that differ from what is published: built-in values first (by key, no
 * label), then Fields in their order (with their labels), then anything else stored.
 */
function valueChanges(
	draft: ReturnType<typeof storedVersion>,
	published: ReturnType<typeof storedVersion>,
	fields: readonly FieldDefinition[],
	builtIns: readonly string[],
): { key: string; label: string | null }[] {
	const keys = [
		...new Set([
			...builtIns,
			...fields.map((field) => field.key),
			...Object.keys(draft.values),
			...Object.keys(published.values),
		]),
	];
	return keys
		.filter((key) => !sameJson(draft.values[key] ?? null, published.values[key] ?? null))
		.map((key) => ({ key, label: fields.find((field) => field.key === key)?.label ?? null }));
}

/** Entries' titles in the Default language, by id: the Entry a page script belongs to. */
async function entryTitles(
	scope: SiteScope,
	ids: readonly string[],
	defaultLanguage: string,
): Promise<Map<string, string>> {
	if (ids.length === 0) return new Map();
	const rows = await scope.select(entries, inArray(entries.id, [...ids]));
	return new Map(
		rows.map((row) => [
			row.id,
			readValue(storedVersion(row.draft), { key: "title", language: defaultLanguage, defaultLanguage }) ?? "",
		]),
	);
}

/** People's names by id, in one query. */
async function namesOf(scope: SiteScope, ids: readonly (string | null)[]): Promise<Map<string, string>> {
	const unique = [...new Set(ids.filter((id): id is string => id !== null))];
	if (unique.length === 0) return new Map();
	const rows = await scope.db
		.select({ id: people.id, name: people.name })
		.from(people)
		.where(inArray(people.id, unique));
	return new Map(rows.map((row) => [row.id, row.name]));
}
