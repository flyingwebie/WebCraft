import { contentApiSettings, globals } from "@webcraft/db/schema";

import type { InstallConfig } from "../config.ts";
import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { storedFields } from "../content/fields.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { listPostTypes } from "../content/post-types.ts";
import { siteAddresses } from "../domains/addresses.ts";
import { stagingUrl } from "../site-pages/addresses.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { ContentApiInvalidError, type ContentKeyView, listContentKeys } from "./keys.ts";
import { type ContentApiHidden, readContentApiSettings } from "./settings.ts";

/** Where the Content API's version 1 starts on every Site hostname. */
export const CONTENT_API_BASE = "/_content/v1";

/** A Site's Content API as Staff see it: the switch, what is hidden, the keys, and where it answers. */
export type ContentApiView = {
	enabled: boolean;
	/** What is hidden, as far as it still exists (Post Types and Fields removed since are left out). */
	hidden: ContentApiHidden;
	keys: ContentKeyView[];
	/** Where frontends call it: on the Site's main address (its Primary domain, else its Staging address), and on its Staging address. */
	addresses: { main: string | null; staging: string | null };
};

/** A change to a Site's Content API settings: the switch, and what is hidden (each list given replaces it). */
export type ContentApiChange = {
	enabled?: boolean;
	hidden?: {
		postTypes?: readonly string[];
		fields?: Readonly<Record<string, readonly string[]>>;
		globals?: readonly string[];
	};
};

/** Every Field's path in a list of Fields: top-level keys, then the Fields inside Groups and Repeaters (`address.city`). */
export function fieldPaths(fields: readonly FieldDefinition[], at = ""): string[] {
	return fields.flatMap((field) => {
		const path = `${at}${field.key}`;
		return field.type === "group" || field.type === "repeater"
			? [path, ...fieldPaths(field.fields, `${path}.`)]
			: [path];
	});
}

async function globalsFields(scope: Pick<SiteScope, "first">): Promise<FieldDefinition[]> {
	return storedFields((await scope.first(globals))?.fields);
}

/** The Site's Content API settings, keys and addresses (open the Site with `structure.edit`). */
export async function contentApiView(scope: SiteScope, config: InstallConfig): Promise<ContentApiView> {
	const settings = await readContentApiSettings(scope);
	const postTypes = await listPostTypes(scope);
	const globalPaths = new Set(fieldPaths(await globalsFields(scope)));
	const fields: Record<string, string[]> = {};
	for (const postType of postTypes) {
		const paths = new Set(fieldPaths(postType.fields));
		const hidden = (settings.hidden.fields[postType.id] ?? []).filter((path) => paths.has(path));
		if (hidden.length > 0) fields[postType.id] = hidden;
	}
	const addresses = await siteAddresses(scope.db, config, scope.site);
	const staging = stagingUrl(config, scope.site.slug);
	return {
		enabled: settings.enabled,
		hidden: {
			postTypes: settings.hidden.postTypes.filter((id) => postTypes.some((postType) => postType.id === id)),
			fields,
			globals: settings.hidden.globals.filter((path) => globalPaths.has(path)),
		},
		keys: await listContentKeys(scope),
		addresses: {
			main: addresses ? `${addresses.main}${CONTENT_API_BASE}` : null,
			staging: staging ? `${staging}${CONTENT_API_BASE}` : null,
		},
	};
}

/**
 * Changes a Site's Content API settings (open the Site with `structure.edit`): switches it on or off
 * and replaces the lists of hidden Post Types (ids) and Fields (paths, by Post Type id; the Globals'
 * own) that are given. It applies at once: the Site's page cache is cleared, so no answer the API
 * kept shows what is now hidden, and it is logged as `contentApi.change` with what changed.
 */
export async function updateContentApi(
	scope: SiteScope,
	change: ContentApiChange,
	config: InstallConfig,
): Promise<ContentApiView> {
	await scope.transaction(async (tx) => {
		const current = await readContentApiSettings(tx);
		const postTypes = await listPostTypes(tx);
		const problems: ContentProblem[] = [];
		const next = { enabled: current.enabled, hidden: { ...current.hidden } };
		const changed: Record<string, unknown> = {};
		if (change.enabled !== undefined && change.enabled !== current.enabled) {
			next.enabled = change.enabled;
			changed.enabled = { from: current.enabled, to: change.enabled };
		}
		const hidden = change.hidden;
		if (hidden?.postTypes !== undefined) {
			const ids: string[] = [];
			hidden.postTypes.forEach((id, index) => {
				if (!postTypes.some((postType) => postType.id === id)) {
					problems.push({
						at: `hidden.postTypes[${index}]`,
						message: "The Site has no such Post Type.",
						rule: "postTypeUnknown",
					});
				} else if (!ids.includes(id)) ids.push(id);
			});
			next.hidden.postTypes = ids;
			changed.postTypes = ids;
		}
		if (hidden?.fields !== undefined) {
			const fields: Record<string, string[]> = {};
			for (const [postTypeId, paths] of Object.entries(hidden.fields)) {
				const postType = postTypes.find((candidate) => candidate.id === postTypeId);
				if (!postType) {
					problems.push({
						at: `hidden.fields.${postTypeId}`,
						message: "The Site has no such Post Type.",
						rule: "postTypeUnknown",
					});
					continue;
				}
				const known = new Set(fieldPaths(postType.fields));
				const kept: string[] = [];
				paths.forEach((path, index) => {
					if (!known.has(path)) {
						problems.push({
							at: `hidden.fields.${postTypeId}[${index}]`,
							message: `${postType.name} has no Field ${path}.`,
							rule: "fieldUnknown",
						});
					} else if (!kept.includes(path)) kept.push(path);
				});
				if (kept.length > 0) fields[postTypeId] = kept;
			}
			next.hidden.fields = fields;
			changed.fields = fields;
		}
		if (hidden?.globals !== undefined) {
			const known = new Set(fieldPaths(await globalsFields(tx)));
			const kept: string[] = [];
			hidden.globals.forEach((path, index) => {
				if (!known.has(path)) {
					problems.push({
						at: `hidden.globals[${index}]`,
						message: `The Globals have no Field ${path}.`,
						rule: "fieldUnknown",
					});
				} else if (!kept.includes(path)) kept.push(path);
			});
			next.hidden.globals = kept;
			changed.globals = kept;
		}
		if (problems.length > 0) throw new ContentApiInvalidError(problems);
		if (Object.keys(changed).length === 0) return;
		const now = tx.now();
		const values = { enabled: next.enabled, hidden: next.hidden, updatedAt: now };
		const [row] = await tx.update(contentApiSettings, values);
		if (!row) await tx.insert(contentApiSettings, { ...values, createdAt: now });
		await clearPageCache(tx);
		await tx.audit("contentApi.change", changed);
	});
	return contentApiView(scope, config);
}
