import { templates } from "@webcraft/db/schema";
import {
	checkSiteTemplate,
	type ElementTree,
	type MarkupNotice,
	parseElementTree,
	parseTemplateMarkup,
	printTemplateMarkup,
	refuseSiteTemplateCommands,
} from "@webcraft/renderer";
import { and, eq, isNull, type SQL } from "drizzle-orm";

import { isUniqueViolation } from "../db-errors.ts";
import { type ClassCatalogue, classCatalogue, listClasses, saveCreatedClasses } from "../design-system/classes.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { sameJson } from "./entries.ts";
import { PagesHaveNoEntryTemplateError, TemplateNotFoundError } from "./errors.ts";
import { BUILT_IN_FIELDS } from "./fields.ts";
import { isPagePostType } from "./pages.ts";
import { getPostType, type PostType, UUID } from "./post-types.ts";

/**
 * The kinds of Template: the Site template (one per Site, around every page) and Entry templates
 * (one per Post Type). Archive templates join them.
 */
export type TemplateKind = "entry" | "site";

/** Where a Template stands, as for Entries: never published, published as it is, or changed since. */
export type TemplateStatus = "draft" | "published" | "changed";

/** A Template, with its Draft and published element trees (ADR 0002). */
export type Template = {
	id: string;
	siteId: string;
	kind: TemplateKind;
	/** The Post Type an Entry template renders; null for the Site template. */
	postTypeId: string | null;
	status: TemplateStatus;
	draft: ElementTree;
	/** What visitors see; null until it is first published. */
	published: ElementTree | null;
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	lastPublishedAt: Date | null;
};

type TemplateRow = typeof templates.$inferSelect;

/** A Template's Draft saved from Template markup: the Template, its markup as printed now, and notices. */
export type SavedTemplateMarkup = { template: Template; markup: string; notices: MarkupNotice[] };

/** A Template's Draft and published version as Template markup. */
export type TemplateMarkup = { draft: string; published: string | null };

/**
 * What an Entry template of `postType` may hold: the built-in Fields and its Fields, and neither
 * `<main>` nor `{{@outlet}}` (both belong to the Site template around it).
 */
function entryTemplateRules(postType: PostType) {
	const names = new Set<string>([...BUILT_IN_FIELDS, ...postType.fields.map((field) => field.key)]);
	return {
		isKnownValue: (path: string) => names.has(path),
		refuseElement: (tag: string) =>
			tag === "main" ? "An Entry template renders inside the page's <main>; it can't hold another." : undefined,
		refuseCommand: refuseSiteTemplateCommands,
	};
}

/**
 * What the Site template may hold: one <main> at the top level of the page, holding the one
 * `{{@outlet}}` (`checkSiteTemplate`). It reads no values yet; the Globals join them.
 */
function siteTemplateRules() {
	return { isKnownValue: (_path: string) => false, checkTree: checkSiteTemplate };
}

/** Which Template a save or read is about: a Post Type's Entry template, or the Site template. */
type TemplateTarget = { kind: "entry"; postType: PostType } | { kind: "site" };

function rulesFor(target: TemplateTarget) {
	return target.kind === "entry" ? entryTemplateRules(target.postType) : siteTemplateRules();
}

function whereFor(target: TemplateTarget): SQL {
	return target.kind === "entry"
		? (and(eq(templates.kind, "entry"), eq(templates.postTypeId, target.postType.id)) as SQL)
		: (and(eq(templates.kind, "site"), isNull(templates.postTypeId)) as SQL);
}

/** Checks a tree as the Template `target` names, answering it in canonical form. */
function parseTemplate(tree: unknown, target: TemplateTarget, classIds: ReadonlySet<string>): ElementTree {
	return parseElementTree(tree, { ...rulesFor(target), classIds });
}

/**
 * Checks a tree as an Entry template of `postType` and answers it in canonical form. It may read the
 * built-in Fields and the Post Type's Fields, and reference the Site's Classes (`classIds`); `<main>`
 * belongs to the Site template, around it. Throws `ElementTreeInvalidError` listing what is wrong.
 */
export function parseEntryTemplate(tree: unknown, postType: PostType, classIds: ReadonlySet<string>): ElementTree {
	return parseElementTree(tree, { ...entryTemplateRules(postType), classIds });
}

/**
 * Saves the Draft of a Post Type's Entry template (open the Site with `structure.edit`), creating
 * the template the first time. Visitors see nothing of it until it is published. Pages have none:
 * they are arranged with a Page layout.
 */
export async function saveEntryTemplate(scope: SiteScope, postTypeId: string, tree: unknown): Promise<Template> {
	return saveTemplate(scope, await entryTemplateTarget(scope, postTypeId), tree);
}

/** The Entry template of a Post Type; Pages have none (`PagesHaveNoEntryTemplateError`). */
async function entryTemplateTarget(scope: SiteScope, postTypeId: string): Promise<TemplateTarget> {
	const postType = await getPostType(scope, postTypeId);
	if (isPagePostType(postType)) throw new PagesHaveNoEntryTemplateError();
	return { kind: "entry", postType };
}

/**
 * Saves the Draft of the Site template (open the Site with `structure.edit`), creating it the first
 * time. Visitors see the built-in one until it is published.
 */
export async function saveSiteTemplate(scope: SiteScope, tree: unknown): Promise<Template> {
	return saveTemplate(scope, { kind: "site" }, tree);
}

async function saveTemplate(scope: SiteScope, target: TemplateTarget, tree: unknown): Promise<Template> {
	const { ids } = classCatalogue(await listClasses(scope));
	const draft = parseTemplate(tree, target, ids);
	return retryOnRace(() => scope.transaction((tx) => writeTemplateDraft(tx, target, draft)));
}

/**
 * Saves the Draft of a Post Type's Entry template from Template markup (open the Site with
 * `structure.edit`), creating the template the first time. Inline styles become generated Classes,
 * in the same transaction. Throws `TemplateMarkupInvalidError` with each problem's line and column.
 */
export async function saveEntryTemplateMarkup(
	scope: SiteScope,
	postTypeId: string,
	markup: string,
): Promise<SavedTemplateMarkup> {
	return saveTemplateMarkup(scope, await entryTemplateTarget(scope, postTypeId), markup);
}

/** Saves the Draft of the Site template from Template markup, as `saveEntryTemplateMarkup` does. */
export async function saveSiteTemplateMarkup(scope: SiteScope, markup: string): Promise<SavedTemplateMarkup> {
	return saveTemplateMarkup(scope, { kind: "site" }, markup);
}

async function saveTemplateMarkup(
	scope: SiteScope,
	target: TemplateTarget,
	markup: string,
): Promise<SavedTemplateMarkup> {
	return retryOnRace(async () => {
		const catalogue = classCatalogue(await listClasses(scope));
		const { tree, notices } = parseTemplateMarkup(markup, {
			...rulesFor(target),
			classNamed: catalogue.named,
			classForStyle: catalogue.forStyle,
		});
		const template = await scope.transaction(async (tx) => {
			await saveCreatedClasses(tx, catalogue);
			return writeTemplateDraft(tx, target, tree);
		});
		return { template, markup: printMarkup(template.draft, catalogue), notices };
	});
}

/** A Post Type's Entry template as Template markup, or null while it has none. */
export async function getEntryTemplateMarkup(
	scope: SiteScope,
	postTypeId: string,
): Promise<{ template: Template | null; markup: TemplateMarkup | null }> {
	return templateMarkup(scope, await getEntryTemplate(scope, postTypeId));
}

/** The Site template as Template markup, or null while the Site has none (and shows the built-in one). */
export async function getSiteTemplateMarkup(
	scope: SiteScope,
): Promise<{ template: Template | null; markup: TemplateMarkup | null }> {
	return templateMarkup(scope, await getSiteTemplate(scope));
}

async function templateMarkup(
	scope: SiteScope,
	template: Template | null,
): Promise<{ template: Template | null; markup: TemplateMarkup | null }> {
	if (!template) return { template: null, markup: null };
	const catalogue = classCatalogue(await listClasses(scope));
	return {
		template,
		markup: {
			draft: printMarkup(template.draft, catalogue),
			published: template.published ? printMarkup(template.published, catalogue) : null,
		},
	};
}

function printMarkup(tree: ElementTree, catalogue: ClassCatalogue): string {
	return printTemplateMarkup(tree, { className: catalogue.nameOf });
}

/** Writes a checked tree as the Draft of the Template `target` names, creating it the first time. */
async function writeTemplateDraft(scope: SiteScope, target: TemplateTarget, draft: ElementTree): Promise<Template> {
	const now = scope.now();
	const [updated] = await scope.update(templates, { draft, updatedAt: now }, whereFor(target));
	return toTemplate(
		updated ??
			(await scope.insert(templates, {
				kind: target.kind,
				postTypeId: target.kind === "entry" ? target.postType.id : null,
				draft,
				createdAt: now,
				updatedAt: now,
			})),
	);
}

/**
 * Runs a save again when someone else created the same template or generated Class at the same
 * moment: the second try finds theirs and saves over it.
 */
async function retryOnRace<T>(save: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await save();
		} catch (error) {
			const raced =
				isUniqueViolation(error, "templates_site_id_kind_post_type_id_unique") ||
				isUniqueViolation(error, "classes_site_id_name_unique");
			if (!raced || attempt >= 3) throw error;
		}
	}
}

/** The Entry template of a Post Type, or null while it has none. */
export async function getEntryTemplate(scope: SiteScope, postTypeId: string): Promise<Template | null> {
	const postType = await getPostType(scope, postTypeId);
	const row = await scope.first(templates, whereFor({ kind: "entry", postType }));
	return row ? toTemplate(row) : null;
}

/** The Site template, or null while the Site has none (and shows the built-in one). */
export async function getSiteTemplate(scope: Pick<SiteScope, "first">): Promise<Template | null> {
	const row = await scope.first(templates, whereFor({ kind: "site" }));
	return row ? toTemplate(row) : null;
}

/**
 * Checks a Template's Draft again before it is published, answering it in canonical form: its Post
 * Type may have lost a Field the Draft reads since it was saved.
 */
export async function checkTemplateForPublish(scope: SiteScope, row: TemplateRow): Promise<ElementTree> {
	const target: TemplateTarget =
		row.kind === "site"
			? { kind: "site" }
			: { kind: "entry", postType: await getPostType(scope, row.postTypeId ?? "") };
	const { ids } = classCatalogue(await listClasses(scope));
	return parseTemplate(row.draft, target, ids);
}

/** Reads a Template for publishing, holding it until the transaction ends. */
export async function lockTemplate(scope: SiteScope, templateId: string): Promise<TemplateRow> {
	const [row] = UUID.test(templateId)
		? await scope.db
				.select()
				.from(templates)
				.where(scope.where(templates, eq(templates.id, templateId)))
				.for("update")
		: [];
	if (!row) throw new TemplateNotFoundError();
	return row;
}

export function toTemplate(row: TemplateRow): Template {
	return {
		id: row.id,
		siteId: row.siteId,
		kind: row.kind as TemplateKind,
		postTypeId: row.postTypeId,
		status: row.published === null ? "draft" : sameJson(row.draft, row.published) ? "published" : "changed",
		draft: row.draft as ElementTree,
		published: row.published as ElementTree | null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
	};
}
