import { globals, templates } from "@webcraft/db/schema";
import {
	type ComponentCatalogue,
	checkSiteTemplate,
	type DesignSystem,
	type ElementTree,
	type LoopCatalogue,
	type MarkupNotice,
	parseElementTree,
	parseTemplateMarkup,
	printTemplateMarkup,
	refuseSiteTemplateCommands,
} from "@webcraft/renderer";
import { and, eq, isNull, type SQL } from "drizzle-orm";

import { isUniqueViolation } from "../db-errors.ts";
import { type ClassCatalogue, ClassRaceError, classCatalogue, saveCreatedClasses } from "../design-system/classes.ts";
import { draftDesignSystem } from "../design-system/design-systems.ts";
import { isUuid } from "../ids.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { archiveAddressOf } from "./archives.ts";
import {
	type ComponentSources,
	lockComponents,
	NO_MODULE_COMPONENTS,
	type SiteComponents,
	siteComponents,
} from "./components.ts";
import { DraftChangedError, PagesHaveNoEntryTemplateError, TemplateNotFoundError } from "./errors.ts";
import type { FieldDefinition } from "./field-types.ts";
import { storedFields } from "./fields.ts";
import { draftVersion, type SaveBase, sameJson } from "./json.ts";
import { loopCatalogue } from "./loops.ts";
import { isPagePostType } from "./pages.ts";
import { getPostType, listPostTypes, type PostType } from "./post-types.ts";
import { knownValues } from "./render-values.ts";

/**
 * The kinds of Template: the Site template (one per Site, around every page), Entry templates (one
 * per Post Type, rendering each Entry) and Archive templates (one per Post Type, listing its Entries
 * at its archive address, `archives.ts`).
 */
export type TemplateKind = "entry" | "site" | "archive";

/** Where a Template stands, as for Entries: never published, published as it is, or changed since. */
export type TemplateStatus = "draft" | "published" | "changed";

/** A Template, with its Draft and published element trees (ADR 0002). */
export type Template = {
	id: string;
	siteId: string;
	kind: TemplateKind;
	/** The Post Type an Entry or Archive template belongs to; null for the Site template. */
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

/**
 * A Template's Draft saved from Template markup: the Template, its markup as printed now, the Draft's
 * version (which the next save names as `basedOn`), and notices.
 */
export type SavedTemplateMarkup = { template: Template; markup: string; version: string; notices: MarkupNotice[] };

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
 * `site.x` (see `render-values.ts`); neither `<main>` nor `{{@outlet}}`, which are the Site
 * template's, around it.
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
		refuseCommand: refuseSiteTemplateCommands,
	};
}

/** The Site as an Entry template of `postTypeId` reads it now. */
async function entryTemplateContext(scope: SiteScope, postTypeId: string): Promise<EntryTemplateContext> {
	const postType = await getPostType(scope, postTypeId);
	const postTypes = await listPostTypes(scope);
	return { postType, postTypes, globalFields: await globalFieldsOf(scope) };
}

/** The Globals' Fields, which Templates read as `site.x`. */
async function globalFieldsOf(scope: Pick<SiteScope, "first">): Promise<FieldDefinition[]> {
	return storedFields((await scope.first(globals))?.fields);
}

/**
 * What the Site template may hold: the Globals as `site.x` (it wraps every page, so it reads no
 * Entry's values), and one <main> at the top level of the page holding the one `{{@outlet}}`
 * (`checkSiteTemplate`).
 */
function siteTemplateRules(globalFields: readonly FieldDefinition[]) {
	const known = knownValues({ fields: [], postTypes: [], globalFields });
	return { isKnownValue: (path: string) => path.startsWith("site.") && known(path), checkTree: checkSiteTemplate };
}

/**
 * What an Archive template may hold: the Globals as `site.x` and the Loops of the Site (no Entry's
 * values: it lists them through Loops); neither `<main>` nor `{{@outlet}}`, which are the Site
 * template's, around it.
 */
function archiveTemplateRules(globalFields: readonly FieldDefinition[]) {
	const known = knownValues({ fields: [], postTypes: [], globalFields });
	return {
		isKnownValue: (path: string) => path.startsWith("site.") && known(path),
		refuseElement: (tag: string) =>
			tag === "main" ? "An Archive template renders inside the page's <main>; it can't hold another." : undefined,
		refuseCommand: refuseSiteTemplateCommands,
	};
}

/** Which Template a save or read is about, with what it may read: an Entry or Archive template, or the Site template. */
type TemplateTarget =
	| { kind: "entry"; context: EntryTemplateContext }
	| { kind: "archive"; postType: PostType; globalFields: readonly FieldDefinition[] }
	| { kind: "site"; globalFields: readonly FieldDefinition[] };

/**
 * What the Template `target` names may hold, placing the Components of `components` and naming the
 * Loops of `loops`: their Drafts for a Draft, their published versions for a publish.
 */
function rulesFor(target: TemplateTarget, components: ComponentCatalogue, loops: LoopCatalogue) {
	const rules =
		target.kind === "entry"
			? entryTemplateRules(target.context)
			: target.kind === "archive"
				? archiveTemplateRules(target.globalFields)
				: siteTemplateRules(target.globalFields);
	return { ...rules, components, loops };
}

function whereFor(target: TemplateTarget): SQL {
	if (target.kind === "site") return and(eq(templates.kind, "site"), isNull(templates.postTypeId)) as SQL;
	return and(eq(templates.kind, target.kind), eq(templates.postTypeId, postTypeOf(target).id)) as SQL;
}

/** The Post Type an Entry or Archive template belongs to. */
function postTypeOf(target: Exclude<TemplateTarget, { kind: "site" }>): PostType {
	return target.kind === "entry" ? target.context.postType : target.postType;
}

/** Checks a tree as the Template `target` names, answering it in canonical form. */
function parseTemplate(
	tree: unknown,
	target: TemplateTarget,
	classIds: ReadonlySet<string>,
	components: ComponentCatalogue,
	loops: LoopCatalogue,
): ElementTree {
	return parseElementTree(tree, { ...rulesFor(target, components, loops), classIds });
}

/** An Entry template to save: Pages have none, being arranged with a Page layout (`PagesHaveNoEntryTemplateError`). */
async function entryTemplateTarget(scope: SiteScope, postTypeId: string): Promise<TemplateTarget> {
	const context = await entryTemplateContext(scope, postTypeId);
	if (isPagePostType(context.postType)) throw new PagesHaveNoEntryTemplateError();
	return { kind: "entry", context };
}

/** The Site template to save, with the Globals it may read. */
async function siteTemplateTarget(scope: SiteScope): Promise<TemplateTarget> {
	return { kind: "site", globalFields: await globalFieldsOf(scope) };
}

/**
 * A Post Type's Archive template to save: Pages have none, nor has a Post Type whose URL pattern
 * starts with `{slug}` (`ArchiveUnavailableError`).
 */
async function archiveTemplateTarget(scope: SiteScope, postTypeId: string): Promise<TemplateTarget> {
	const postType = await getPostType(scope, postTypeId);
	archiveAddressOf(postType);
	return { kind: "archive", postType, globalFields: await globalFieldsOf(scope) };
}

/**
 * Saves the Draft of a Post Type's Archive template (open the Site with `structure.edit`), creating
 * it the first time. Visitors see it at the Post Type's archive address once it is published.
 */
export async function saveArchiveTemplate(
	scope: SiteScope,
	postTypeId: string,
	tree: unknown,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<Template> {
	return saveTemplate(scope, await archiveTemplateTarget(scope, postTypeId), tree, sources);
}

/** Saves the Draft of a Post Type's Archive template from Template markup, as `saveEntryTemplateMarkup` does. */
export async function saveArchiveTemplateMarkup(
	scope: SiteScope,
	postTypeId: string,
	markup: string,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
	base: SaveBase = {},
): Promise<SavedTemplateMarkup> {
	return saveTemplateMarkup(scope, await archiveTemplateTarget(scope, postTypeId), markup, sources, base);
}

/** A Post Type's Archive template, or null while it has none. */
export async function getArchiveTemplate(scope: SiteScope, postTypeId: string): Promise<Template | null> {
	const postType = await getPostType(scope, postTypeId);
	const row = await scope.first(templates, and(eq(templates.kind, "archive"), eq(templates.postTypeId, postType.id)));
	return row ? toTemplate(row) : null;
}

/** A Post Type's Archive template as Template markup, or null while it has none. */
export async function getArchiveTemplateMarkup(
	scope: SiteScope,
	postTypeId: string,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<{ template: Template | null; markup: TemplateMarkup | null; version: string | null }> {
	return templateMarkup(scope, await getArchiveTemplate(scope, postTypeId), sources);
}

/**
 * Saves the Draft of a Post Type's Entry template (open the Site with `structure.edit`), creating
 * the template the first time. Visitors see nothing of it until it is published. Pages have none:
 * they are arranged with a Page layout.
 */
export async function saveEntryTemplate(
	scope: SiteScope,
	postTypeId: string,
	tree: unknown,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<Template> {
	return saveTemplate(scope, await entryTemplateTarget(scope, postTypeId), tree, sources);
}

/**
 * Saves the Draft of the Site template (open the Site with `structure.edit`), creating it the first
 * time. Visitors see the built-in one until it is published.
 */
export async function saveSiteTemplate(
	scope: SiteScope,
	tree: unknown,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<Template> {
	return saveTemplate(scope, await siteTemplateTarget(scope), tree, sources);
}

async function saveTemplate(
	scope: SiteScope,
	target: TemplateTarget,
	tree: unknown,
	sources: ComponentSources,
): Promise<Template> {
	return retryOnRace(() =>
		scope.transaction(async (tx) => {
			// The Components it places can't be deleted while it is saved.
			await lockComponents(tx);
			const { ids } = classCatalogue(await draftDesignSystem(tx));
			const draft = parseTemplate(
				tree,
				target,
				ids,
				await siteComponents(tx, "draft", sources),
				await loopCatalogue(tx, "draft"),
			);
			return writeTemplateDraft(tx, target, draft);
		}),
	);
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
	sources: ComponentSources = NO_MODULE_COMPONENTS,
	base: SaveBase = {},
): Promise<SavedTemplateMarkup> {
	return saveTemplateMarkup(scope, await entryTemplateTarget(scope, postTypeId), markup, sources, base);
}

/** Saves the Draft of the Site template from Template markup, as `saveEntryTemplateMarkup` does. */
export async function saveSiteTemplateMarkup(
	scope: SiteScope,
	markup: string,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
	base: SaveBase = {},
): Promise<SavedTemplateMarkup> {
	return saveTemplateMarkup(scope, await siteTemplateTarget(scope), markup, sources, base);
}

async function saveTemplateMarkup(
	scope: SiteScope,
	target: TemplateTarget,
	markup: string,
	sources: ComponentSources,
	base: SaveBase,
): Promise<SavedTemplateMarkup> {
	return retryOnRace(() =>
		scope.transaction(async (tx) => {
			// The Components it places can't be deleted while it is saved; Template saves take turns.
			await lockComponents(tx);
			if (base.basedOn !== undefined) {
				const current = await tx.first(templates, whereFor(target));
				const version = current ? draftVersion(current.draft) : null;
				if (version !== base.basedOn) throw new DraftChangedError(version);
			}
			const catalogue = classCatalogue(await draftDesignSystem(tx));
			const components = await siteComponents(tx, "draft", sources);
			const { tree, notices } = parseTemplateMarkup(markup, {
				...rulesFor(target, components, await loopCatalogue(tx, "draft")),
				classNamed: catalogue.named,
				classForStyle: catalogue.forStyle,
			});
			await saveCreatedClasses(tx, catalogue);
			const template = await writeTemplateDraft(tx, target, tree);
			return {
				template,
				markup: printMarkup(template.draft, catalogue, components),
				version: draftVersion(template.draft),
				notices,
			};
		}),
	);
}

/** Which Template markup is read for: see `readTemplateMarkup`. */
export type TemplateMarkupTarget = { kind: "entry"; postTypeId: string } | { kind: "site" };

/**
 * Reads Template markup as saving the Template's Draft would, without saving anything: the tree,
 * notices, and the Design system's Draft with the generated Classes its inline styles would add.
 * Code mode previews unsaved markup with it. Throws `TemplateMarkupInvalidError` as saving does.
 */
export async function readTemplateMarkup(
	scope: SiteScope,
	target: TemplateMarkupTarget,
	markup: string,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<{ tree: ElementTree; notices: MarkupNotice[]; designSystem: DesignSystem }> {
	const rules =
		target.kind === "entry" ? await entryTemplateTarget(scope, target.postTypeId) : await siteTemplateTarget(scope);
	const designSystem = await draftDesignSystem(scope);
	const catalogue = classCatalogue(designSystem);
	const { tree, notices } = parseTemplateMarkup(markup, {
		...rulesFor(rules, await siteComponents(scope, "draft", sources), await loopCatalogue(scope, "draft")),
		classNamed: catalogue.named,
		classForStyle: catalogue.forStyle,
	});
	return { tree, notices, designSystem: { ...designSystem, classes: [...designSystem.classes, ...catalogue.created] } };
}

/** A Post Type's Entry template as Template markup, or null while it has none. */
export async function getEntryTemplateMarkup(
	scope: SiteScope,
	postTypeId: string,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<{ template: Template | null; markup: TemplateMarkup | null; version: string | null }> {
	return templateMarkup(scope, await getEntryTemplate(scope, postTypeId), sources);
}

/** The Site template as Template markup, or null while the Site has none (and shows the built-in one). */
export async function getSiteTemplateMarkup(
	scope: SiteScope,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<{ template: Template | null; markup: TemplateMarkup | null; version: string | null }> {
	return templateMarkup(scope, await getSiteTemplate(scope), sources);
}

async function templateMarkup(
	scope: SiteScope,
	template: Template | null,
	sources: ComponentSources,
): Promise<{ template: Template | null; markup: TemplateMarkup | null; version: string | null }> {
	if (!template) return { template: null, markup: null, version: null };
	const catalogue = classCatalogue(await draftDesignSystem(scope));
	const components = await siteComponents(scope, "draft", sources);
	return {
		template,
		version: draftVersion(template.draft),
		markup: {
			draft: printMarkup(template.draft, catalogue, components),
			published: template.published ? printMarkup(template.published, catalogue, components) : null,
		},
	};
}

/** A tree as Template markup: Classes by name, Placements by their Components' names. */
function printMarkup(tree: ElementTree, catalogue: ClassCatalogue, components: SiteComponents): string {
	return printTemplateMarkup(tree, { className: catalogue.nameOf, componentName: components.nameOf });
}

/** Writes a checked tree as the Draft of the Template `target` names, creating it the first time. */
async function writeTemplateDraft(scope: SiteScope, target: TemplateTarget, draft: ElementTree): Promise<Template> {
	const now = scope.now();
	const [updated] = await scope.update(templates, { draft, updatedAt: now }, whereFor(target));
	return toTemplate(
		updated ??
			(await scope.insert(templates, {
				kind: target.kind,
				postTypeId: target.kind === "site" ? null : postTypeOf(target).id,
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
				isUniqueViolation(error, "templates_site_id_kind_post_type_id_unique") || error instanceof ClassRaceError;
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

/** The Site template, or null while the Site has none (and shows the built-in one). */
export async function getSiteTemplate(scope: Pick<SiteScope, "first">): Promise<Template | null> {
	const row = await scope.first(templates, and(eq(templates.kind, "site"), isNull(templates.postTypeId)));
	return row ? toTemplate(row) : null;
}

/**
 * Checks a Template's Draft again before it is published, answering it in canonical form: what it
 * reads (its Post Type, the Globals, what Relationships point at) or its Classes may have changed
 * since it was saved.
 */
export async function checkTemplateForPublish(
	scope: SiteScope,
	row: TemplateRow,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<ElementTree> {
	const target: TemplateTarget =
		row.kind === "site"
			? await siteTemplateTarget(scope)
			: row.kind === "archive"
				? await archiveTemplateTarget(scope, row.postTypeId ?? "")
				: { kind: "entry", context: await entryTemplateContext(scope, row.postTypeId ?? "") };
	const { ids } = classCatalogue(await draftDesignSystem(scope));
	// Visitors will see the Components it places and the Loops it names as they are published.
	return parseTemplate(
		row.draft,
		target,
		ids,
		await siteComponents(scope, "published", sources),
		await loopCatalogue(scope, "published"),
	);
}

/** Reads a Template for publishing, holding it until the transaction ends. */
export async function lockTemplate(scope: SiteScope, templateId: string): Promise<TemplateRow> {
	const [row] = isUuid(templateId)
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
