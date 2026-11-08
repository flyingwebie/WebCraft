import { globals, templates } from "@webcraft/db/schema";
import {
	type ElementTree,
	type MarkupNotice,
	parseElementTree,
	parseTemplateMarkup,
	printTemplateMarkup,
} from "@webcraft/renderer";
import { and, eq } from "drizzle-orm";

import { isUniqueViolation } from "../db-errors.ts";
import { type ClassCatalogue, classCatalogue, listClasses, saveCreatedClasses } from "../design-system/classes.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { TemplateNotFoundError } from "./errors.ts";
import type { FieldDefinition } from "./field-types.ts";
import { storedFields } from "./fields.ts";
import { sameJson } from "./json.ts";
import { getPostType, listPostTypes, type PostType, UUID } from "./post-types.ts";
import { knownValues } from "./render-values.ts";

/** The kinds of Template. The Site template and Archive templates join the Entry template. */
export type TemplateKind = "entry";

/** Where a Template stands, as for Entries: never published, published as it is, or changed since. */
export type TemplateStatus = "draft" | "published" | "changed";

/** A Template, with its Draft and published element trees (ADR 0002). */
export type Template = {
	id: string;
	siteId: string;
	kind: TemplateKind;
	/** The Post Type an Entry template renders. */
	postTypeId: string;
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

/** What an Entry template's values may come from: its Post Type, what Relationships point at, the Globals. */
export type EntryTemplateContext = {
	postType: PostType;
	/** Every Post Type of the Site, for what Relationships point at. */
	postTypes: readonly PostType[];
	/** The Globals' Fields, for `site.x`. */
	globalFields: readonly FieldDefinition[];
};

/**
 * What an Entry template may hold: the built-in Fields, the Post Type's Fields and their parts
 * (`address.city`, `team.name`, what a Relationship points at: `category.title`) and the Globals as
 * `site.x` (see `render-values.ts`); no `<main>`, which is the Site template's, around it.
 */
function entryTemplateRules(context: EntryTemplateContext) {
	return {
		isKnownValue: knownValues({
			fields: context.postType.fields,
			postTypes: context.postTypes,
			globalFields: context.globalFields,
		}),
		refuseElement: (tag: string) =>
			tag === "main" ? "An Entry template renders inside the page's <main>; it can't hold another." : undefined,
	};
}

/** The Site as an Entry template of `postTypeId` reads it now. */
async function entryTemplateContext(scope: SiteScope, postTypeId: string): Promise<EntryTemplateContext> {
	const postType = await getPostType(scope, postTypeId);
	const postTypes = await listPostTypes(scope);
	const globalFields = storedFields((await scope.first(globals))?.fields);
	return { postType, postTypes, globalFields };
}

/**
 * Checks a tree as an Entry template and answers it in canonical form: it may read what
 * `entryTemplateRules` allows and reference the Site's Classes (`classIds`). Throws
 * `ElementTreeInvalidError` listing what is wrong.
 */
export function parseEntryTemplate(
	tree: unknown,
	context: EntryTemplateContext,
	classIds: ReadonlySet<string>,
): ElementTree {
	return parseElementTree(tree, { ...entryTemplateRules(context), classIds });
}

/**
 * Checks a tree as the Entry template of a Post Type of the scope's Site, with the Site as it is now:
 * on save, and again on publish (the Post Type, the Globals, what Relationships point at or the
 * Classes may have changed since).
 */
export async function checkEntryTemplate(scope: SiteScope, postTypeId: string, tree: unknown): Promise<ElementTree> {
	const context = await entryTemplateContext(scope, postTypeId);
	const { ids } = classCatalogue(await listClasses(scope));
	return parseEntryTemplate(tree, context, ids);
}

/**
 * Saves the Draft of a Post Type's Entry template (open the Site with `structure.edit`), creating
 * the template the first time. Visitors see nothing of it until it is published.
 */
export async function saveEntryTemplate(scope: SiteScope, postTypeId: string, tree: unknown): Promise<Template> {
	const context = await entryTemplateContext(scope, postTypeId);
	const { ids } = classCatalogue(await listClasses(scope));
	const draft = parseEntryTemplate(tree, context, ids);
	return retryOnRace(() => scope.transaction((tx) => writeEntryTemplateDraft(tx, context.postType, draft)));
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
	const context = await entryTemplateContext(scope, postTypeId);
	return retryOnRace(async () => {
		const catalogue = classCatalogue(await listClasses(scope));
		const { tree, notices } = parseTemplateMarkup(markup, {
			...entryTemplateRules(context),
			classNamed: catalogue.named,
			classForStyle: catalogue.forStyle,
		});
		const template = await scope.transaction(async (tx) => {
			await saveCreatedClasses(tx, catalogue);
			return writeEntryTemplateDraft(tx, context.postType, tree);
		});
		return { template, markup: printMarkup(template.draft, catalogue), notices };
	});
}

/** A Post Type's Entry template as Template markup, or null while it has none. */
export async function getEntryTemplateMarkup(
	scope: SiteScope,
	postTypeId: string,
): Promise<{ template: Template | null; markup: TemplateMarkup | null }> {
	const template = await getEntryTemplate(scope, postTypeId);
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

/** Writes a checked tree as the Draft of a Post Type's Entry template, creating the template the first time. */
async function writeEntryTemplateDraft(scope: SiteScope, postType: PostType, draft: ElementTree): Promise<Template> {
	const now = scope.now();
	const where = and(eq(templates.kind, "entry"), eq(templates.postTypeId, postType.id));
	const [updated] = await scope.update(templates, { draft, updatedAt: now }, where);
	return toTemplate(
		updated ??
			(await scope.insert(templates, {
				kind: "entry",
				postTypeId: postType.id,
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
	const row = await scope.first(templates, and(eq(templates.kind, "entry"), eq(templates.postTypeId, postType.id)));
	return row ? toTemplate(row) : null;
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
		postTypeId: row.postTypeId ?? "",
		status: row.published === null ? "draft" : sameJson(row.draft, row.published) ? "published" : "changed",
		draft: row.draft as ElementTree,
		published: row.published as ElementTree | null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
	};
}
