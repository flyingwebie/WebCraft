import { globals, templates } from "@webcraft/db/schema";
import { type ElementTree, parseElementTree } from "@webcraft/renderer";
import { and, eq } from "drizzle-orm";

import { isUniqueViolation } from "../db-errors.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { TemplateNotFoundError } from "./errors.ts";
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

/**
 * Checks a tree as an Entry template of `postType` and answers it in canonical form. It may read the
 * built-in Fields, the Post Type's Fields and their parts (`address.city`, `team.name`, what a
 * Relationship points at: `category.title`), and the Globals as `site.x`; `<main>` belongs to the
 * Site template, around it. Throws `ElementTreeInvalidError` listing what is wrong.
 */
export function parseEntryTemplate(
	tree: unknown,
	context: {
		postType: PostType;
		postTypes: readonly PostType[];
		globalFields: Parameters<typeof knownValues>[0]["globalFields"];
	},
): ElementTree {
	const isKnownValue = knownValues({
		fields: context.postType.fields,
		postTypes: context.postTypes,
		globalFields: context.globalFields,
	});
	return parseElementTree(tree, {
		isKnownValue,
		refuseElement: (tag) =>
			tag === "main" ? "An Entry template renders inside the page's <main>; it can't hold another." : undefined,
	});
}

/** Checks a tree as the Entry template of a Post Type of the scope's Site, with the Site as it is now. */
export async function checkEntryTemplate(scope: SiteScope, postTypeId: string, tree: unknown): Promise<ElementTree> {
	const postType = await getPostType(scope, postTypeId);
	const postTypes = await listPostTypes(scope);
	const globalFields = storedFields((await scope.first(globals))?.fields);
	return parseEntryTemplate(tree, { postType, postTypes, globalFields });
}

/**
 * Saves the Draft of a Post Type's Entry template (open the Site with `structure.edit`), creating
 * the template the first time. Visitors see nothing of it until it is published.
 */
export async function saveEntryTemplate(scope: SiteScope, postTypeId: string, tree: unknown): Promise<Template> {
	const postType = await getPostType(scope, postTypeId);
	const draft = await checkEntryTemplate(scope, postType.id, tree);
	const save = () =>
		scope.transaction(async (tx) => {
			const now = tx.now();
			const where = and(eq(templates.kind, "entry"), eq(templates.postTypeId, postType.id));
			const [updated] = await tx.update(templates, { draft, updatedAt: now }, where);
			return (
				updated ??
				(await tx.insert(templates, { kind: "entry", postTypeId: postType.id, draft, createdAt: now, updatedAt: now }))
			);
		});
	try {
		return toTemplate(await save());
	} catch (error) {
		// Someone created the template at the same moment: save over theirs.
		if (isUniqueViolation(error, "templates_site_id_kind_post_type_id_unique")) return toTemplate(await save());
		throw error;
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
