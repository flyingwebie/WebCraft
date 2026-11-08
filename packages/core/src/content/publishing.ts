import { entries, publishedSlugs, templates } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import { isUniqueViolation } from "../db-errors.ts";
import { can } from "../permissions/can.ts";
import type { Permission } from "../permissions/roles.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import { entryValues, lockEntry, siteLanguages } from "./entries.ts";
import { EntryIncompleteError, EntrySlugTakenError } from "./errors.ts";
import { clearPageCache } from "./page-cache.ts";
import { checkPublishedParent, isPagePostType, parentIn } from "./pages.ts";
import { getPostType } from "./post-types.ts";
import { checkTemplateForPublish, lockTemplate } from "./templates.ts";
import { storedVersion } from "./values.ts";

/**
 * One item to publish. Globals, Components, Forms and the Design system join Entries and Templates;
 * Publish all publishes a ticked set of them, and a Scheduled publish a frozen version.
 */
export type PublishItem = { kind: "entry"; id: string } | { kind: "template"; id: string };

/** What publishing did. */
export type Published = { kind: PublishItem["kind"]; id: string; publishedAt: Date };

/**
 * The Permission publishing an item needs: Content takes `entry.publish` (Editors, Owners, Staff);
 * Structure, such as a Template, takes `structure.edit` (Staff only).
 */
export function publishPermission(item: Pick<PublishItem, "kind">): Permission {
	return item.kind === "entry" ? "entry.publish" : "structure.edit";
}

/**
 * Publishes one item: its Draft becomes what visitors see. In one transaction it copies the Draft
 * over the published version, clears the Site's page cache and writes the Audit log, so visitors get
 * the new version with the next request. Open the Site with `publishPermission(item)`; the check runs
 * again here, so every caller (the admin, the worker's Scheduled publishes) holds it.
 *
 * Refuses an Entry whose required values are empty (`EntryIncompleteError`) or whose slug another
 * published Entry of its Post Type has (`EntrySlugTakenError`; for a Page, another published Page
 * under the same parent), a Page whose parent Page isn't published (`PageParentUnpublishedError`),
 * and a Template that no longer fits what it renders (`ElementTreeInvalidError`).
 */
export async function publish(scope: SiteScope, item: PublishItem): Promise<Published> {
	const permission = publishPermission(item);
	const resource = { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id } as const;
	if (!can(scope.access.actor, permission, resource)) throw new PermissionDeniedError(permission);
	return scope.transaction(async (tx) => {
		const published = item.kind === "entry" ? await publishEntry(tx, item.id) : await publishTemplate(tx, item.id);
		await clearPageCache(tx);
		return published;
	});
}

async function publishEntry(scope: SiteScope, entryId: string): Promise<Published> {
	const row = await lockEntry(scope, entryId);
	const postType = await getPostType(scope, row.postTypeId);
	const { defaultLanguage } = await siteLanguages(scope);
	const draft = storedVersion(row.draft);
	const values = entryValues(draft, postType.fields, { language: defaultLanguage, defaultLanguage });
	const missing = [
		...(values.title ? [] : ["title"]),
		...(values.slug ? [] : ["slug"]),
		...postType.fields.filter((field) => field.required && !values.fields[field.key]).map((field) => field.key),
	];
	if (missing.length > 0) throw new EntryIncompleteError(missing);
	// A Page nests under its published parent Page; publishing moves it, with every Page under it.
	const parentId = isPagePostType(postType) ? parentIn(draft, defaultLanguage) : null;
	if (parentId !== null) await checkPublishedParent(scope, row.id, parentId, defaultLanguage);

	const now = scope.now();
	await scope.update(
		entries,
		{ published: draft, publishedAt: row.publishedAt ?? now, lastPublishedAt: now },
		eq(entries.id, row.id),
	);
	await scope.delete(publishedSlugs, eq(publishedSlugs.entryId, row.id));
	try {
		await scope.insert(publishedSlugs, {
			entryId: row.id,
			postTypeId: row.postTypeId,
			language: defaultLanguage,
			slug: values.slug,
			parentId,
		});
	} catch (error) {
		if (isUniqueViolation(error, "published_slugs_slug_unique")) {
			throw new EntrySlugTakenError(values.slug, isPagePostType(postType) ? "siblingPages" : "postType");
		}
		throw error;
	}
	await scope.audit("entry.publish", {
		entryId: row.id,
		postTypeId: row.postTypeId,
		title: values.title,
		slug: values.slug,
	});
	return { kind: "entry", id: row.id, publishedAt: now };
}

async function publishTemplate(scope: SiteScope, templateId: string): Promise<Published> {
	const row = await lockTemplate(scope, templateId);
	const tree = await checkTemplateForPublish(scope, row);
	const now = scope.now();
	await scope.update(
		templates,
		{ published: tree, publishedAt: row.publishedAt ?? now, lastPublishedAt: now },
		eq(templates.id, row.id),
	);
	await scope.audit("template.publish", { templateId: row.id, kind: row.kind, postTypeId: row.postTypeId });
	return { kind: "template", id: row.id, publishedAt: now };
}
