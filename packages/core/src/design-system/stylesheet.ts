/**
 * Each Site's stylesheet (ADR 0009): one file per published Design system, built from what the Site
 * has published (its Design system, and the Classes and token utilities its published element trees
 * use), named by the hash of what it holds and served from the Site's own domain under
 * `/_wc/css/<hash>.css`, so browsers may keep it for good.
 *
 * Building it again from the same published data always gives the same file, so every web process
 * agrees on its name without storing it. A publish that changes it keeps the one it replaces for a
 * while (`stylesheets`), so a page a visitor loaded just before still finds its stylesheet.
 */
import { components, designSystems, stylesheets, templates } from "@webcraft/db/schema";
import {
	compileStylesheet,
	contentHash,
	type DesignSystem,
	defaultDesignSystem,
	designSystemNames,
	type ElementTree,
	elementsOf,
	readDesignSystem,
	THEME_TOGGLE_SCRIPT,
} from "@webcraft/renderer";
import { eq, isNotNull, lt } from "drizzle-orm";

import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";

/** Where every Site serves its stylesheets: `/_wc/css/<hash>.css`. */
export const STYLESHEET_PATH = "/_wc/css/";

/** A stylesheet's file name: 16 hexadecimal digits of its SHA-256, then `.css`. */
const STYLESHEET_NAME = /^([0-9a-f]{16})\.css$/;

/** How long a stylesheet a publish replaced is still served, for pages loaded before it. */
export const RETIRED_STYLESHEET_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** The Site's styling as visitors get it: its published Design system and the stylesheet built from it. */
export type SiteStyles = {
	designSystem: DesignSystem;
	/** The class name of a Class or token utility id, as published. */
	className(classId: string): string | undefined;
	stylesheet: { hash: string; css: string; href: string };
};

type Reader = Pick<VisitorScope, "first" | "select">;

/** The Design system visitors see: the published one, or the default one until there is one. */
export async function publishedDesignSystem(scope: Pick<VisitorScope, "first">): Promise<DesignSystem> {
	const row = await scope.first(designSystems);
	return row?.published ? readDesignSystem(row.published) : defaultDesignSystem();
}

/**
 * The published element trees of the Site: its Templates and its own Components (a Module's hold
 * no Classes). Popups join them.
 */
export async function publishedTrees(scope: Pick<VisitorScope, "select">): Promise<ElementTree[]> {
	const rows = await scope.select(templates, isNotNull(templates.published));
	const placed = await scope.select(components, isNotNull(components.published));
	return [
		...rows.map((row) => row.published as ElementTree),
		...placed.flatMap((row) => {
			const tree = (row.published as { tree?: ElementTree } | null)?.tree;
			return tree ? [tree] : [];
		}),
	];
}

/** Every Class and token utility the trees give elements, by id. */
export function classIdsIn(trees: readonly ElementTree[]): Set<string> {
	const ids = new Set<string>();
	for (const tree of trees) {
		for (const element of elementsOf(tree.nodes)) for (const classId of element.classes) ids.add(classId);
	}
	return ids;
}

/** The Site's styling as visitors get it now. */
export async function siteStyles(scope: Reader): Promise<SiteStyles> {
	const designSystem = await publishedDesignSystem(scope);
	const css = compileStylesheet(designSystem, { classIds: classIdsIn(await publishedTrees(scope)) });
	const hash = contentHash(css);
	return {
		designSystem,
		className: designSystemNames(designSystem).nameOf,
		stylesheet: { hash, css, href: `${STYLESHEET_PATH}${hash}.css` },
	};
}

/**
 * A stylesheet of the Site by its file name: the current one, or one a publish replaced in the last
 * 30 days. Null for any other name.
 */
export async function stylesheetFile(scope: Reader, current: SiteStyles, name: string): Promise<string | null> {
	const hash = STYLESHEET_NAME.exec(name)?.[1];
	if (!hash) return null;
	if (hash === current.stylesheet.hash) return current.stylesheet.css;
	return (await scope.first(stylesheets, eq(stylesheets.hash, hash)))?.css ?? null;
}

/**
 * Keeps the stylesheet a publish replaced, so pages loaded before it still find theirs, and forgets
 * those replaced more than 30 days ago. Call with the styles read before the publish, in its
 * transaction, after it changed what it publishes.
 */
export async function keepReplacedStylesheet(scope: SiteScope, before: SiteStyles): Promise<void> {
	const after = await siteStyles(scope);
	const now = scope.now();
	await scope.delete(stylesheets, lt(stylesheets.retiredAt, new Date(now.getTime() - RETIRED_STYLESHEET_LIFETIME_MS)));
	if (after.stylesheet.hash === before.stylesheet.hash) return;
	// Two publishes at once may both replace the same stylesheet: the later one keeps it longer.
	await scope.db
		.insert(stylesheets)
		.values({
			workspaceId: scope.site.workspaceId,
			siteId: scope.site.id,
			hash: before.stylesheet.hash,
			css: before.stylesheet.css,
			retiredAt: now,
		})
		.onConflictDoUpdate({ target: [stylesheets.siteId, stylesheets.hash], set: { retiredAt: now } });
}

export { SCRIPT_PATH } from "@webcraft/renderer";

/**
 * A script WebCraft serves on every Site by its file name (`/_wc/js/<name>`): the theme toggle's,
 * named by its hash. Null for any other name.
 */
export function siteScript(name: string): string | null {
	return name === THEME_TOGGLE_SCRIPT.name ? THEME_TOGGLE_SCRIPT.text : null;
}
