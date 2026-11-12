import { entries as entryRows } from "@webcraft/db/schema";
import { asc, desc, eq } from "drizzle-orm";
import { archiveParts } from "../content/archives.ts";
import { type ComponentSources, listComponents } from "../content/components.ts";
import { draftAddresses } from "../content/draft-paths.ts";
import { publishedAddresses } from "../content/entry-paths.ts";
import type { ComponentUse } from "../content/errors.ts";
import { siteLanguages } from "../content/languages.ts";
import { isPagePostType } from "../content/pages.ts";
import { listPostTypes } from "../content/post-types.ts";
import { readValue, storedVersion } from "../content/values.ts";
import { can } from "../permissions/can.ts";
import type { Permission } from "../permissions/roles.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

/**
 * The Permissions the Command menu's commands declare (ADR 0028): the menu shows a command only to
 * someone `can()` allows on the Site. Add a Permission here when a command needs a new one.
 */
export const COMMAND_PERMISSIONS = [
	"site.view",
	"structure.edit",
	"entry.edit",
	"entry.publish",
] as const satisfies readonly Permission[];

/** The most Entries Go to lists for one Post Type: its newest. */
export const GO_TO_ENTRIES = 200;

/** One page Go to opens in Code mode, at its address on the Site. */
export type GoToPage = { id: string; title: string; path: string };

/**
 * What the Command menu needs from the Site: the Permissions the person holds on it, and Go to's
 * lists (Pages, each Post Type's Entries, Templates and the Site's own Components).
 */
export type CommandMenuData = {
	permissions: (typeof COMMAND_PERMISSIONS)[number][];
	pages: GoToPage[];
	postTypes: {
		id: string;
		name: string;
		/** Whether its Archive template has an address (a Post Type whose URL pattern has a fixed start). */
		archive: boolean;
		entries: GoToPage[];
	}[];
	/**
	 * The Site's own Components, each with what places it directly (its Placements' holders, in their
	 * Draft or published version): Go to lists them when a Placement's "on N pages" badge is clicked.
	 * Components are Structure: empty for anyone who may not change it (`structure.edit`).
	 */
	components: { id: string; name: string; usedIn: ComponentUse[] }[];
};

export async function commandMenuData(scope: SiteScope, sources: ComponentSources): Promise<CommandMenuData> {
	const resource = { level: "site", workspaceId: scope.site.workspaceId, siteId: scope.site.id } as const;
	const permissions = COMMAND_PERMISSIONS.filter((permission) => can(scope.access.actor, permission, resource));
	const { defaultLanguage } = await siteLanguages(scope);
	const languages = { language: defaultLanguage, defaultLanguage };
	const pages: GoToPage[] = [];
	const postTypes: CommandMenuData["postTypes"] = [];
	for (const postType of await listPostTypes(scope)) {
		// Only what Go to shows is read, of only the Entries it lists: the menu opens for everyone in Edit
		// mode, on Sites with any number of Entries.
		const listed = await scope.select(entryRows, eq(entryRows.postTypeId, postType.id), {
			orderBy: [desc(entryRows.createdAt), asc(entryRows.id)],
			limit: GO_TO_ENTRIES,
		});
		const published = await publishedAddresses(
			scope,
			postType,
			listed.filter((row) => row.published !== null).map((row) => row.id),
			languages,
		);
		const drafts = await draftAddresses(
			scope,
			postType,
			listed.filter((row) => !published.has(row.id)).map((row) => row.id),
			languages,
		);
		const entries: GoToPage[] = [];
		for (const row of listed) {
			const path = (published.get(row.id) ?? drafts.get(row.id))?.path ?? null;
			const title = readValue(storedVersion(row.draft), { key: "title", ...languages }) ?? "";
			if (path !== null) entries.push({ id: row.id, title, path });
		}
		if (isPagePostType(postType)) pages.push(...entries);
		else
			postTypes.push({
				id: postType.id,
				name: postType.name,
				archive: archiveParts(postType.urlPattern) !== null,
				entries,
			});
	}
	pages.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)));
	const components = permissions.includes("structure.edit")
		? (await listComponents(scope, sources))
				.filter((component) => component.module === null)
				.map((component) => ({ id: component.id, name: component.name, usedIn: component.usage.usedIn }))
		: [];
	return { permissions, pages, postTypes, components };
}
