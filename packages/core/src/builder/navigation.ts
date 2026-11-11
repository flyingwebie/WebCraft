import { entries, templates } from "@webcraft/db/schema";
import { childListsOf, type ElementTree, type TreeNode } from "@webcraft/renderer";
import { desc } from "drizzle-orm";
import { archiveAddressOf } from "../content/archives.ts";
import { type ComponentSources, siteComponents } from "../content/components.ts";
import { draftAddresses } from "../content/draft-paths.ts";
import { entryValues } from "../content/entries.ts";
import { publishedAddresses } from "../content/entry-paths.ts";
import { EntryNotFoundError } from "../content/errors.ts";
import { siteLanguages } from "../content/languages.ts";
import { isPagePostType, pathText } from "../content/pages.ts";
import { listPostTypes } from "../content/post-types.ts";
import { getSpecialPages } from "../content/special-pages.ts";
import { storedVersion } from "../content/values.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type BuilderTarget, readSource } from "./sources.ts";

/** Paths are on this Site; refs keep every nested/repeated Placement separately from the selected key. */
export type BuilderDestinations = {
	pages: { path: string; title: string; refs: string[] }[];
	entryId: string | null;
	reason: "noHomePage" | "noSearchPage" | "noEntries" | "noAddress" | "notPlaced" | "saveFirst" | null;
};

export async function builderDestinations(scope: SiteScope, sources: ComponentSources, target: BuilderTarget, entryId?: string): Promise<BuilderDestinations> {
	const source = await readSource(scope, target, sources);
	const site = await siteLanguages(scope);
	const languages = { language: site.defaultLanguage, defaultLanguage: site.defaultLanguage };
	const special = await getSpecialPages(scope);
	const types = await listPostTypes(scope);
	const rows = await scope.select(entries, undefined, { orderBy: [desc(entries.updatedAt), entries.id] });
	const paths = new Map<string, string>();
	for (const type of types) {
		const ids = rows.filter((row) => row.postTypeId === type.id).map((row) => row.id);
		const published = await publishedAddresses(scope, type, ids, languages);
		const drafts = await draftAddresses(scope, type, ids, languages);
		for (const id of ids) {
			const path = (published.get(id) ?? drafts.get(id))?.path;
			if (path) paths.set(id, path);
		}
	}
	const pages: BuilderDestinations["pages"] = [];
	const add = (path: string | undefined, title: string, refs: string[]) => {
		if (!path || !refs.length) return;
		const before = pages.find((page) => page.path === path);
		if (before) before.refs = [...new Set([...before.refs, ...refs])];
		else pages.push({ path, title, refs });
	};
	const addEntry = (id: string, refs: string[]) => {
		const row = rows.find((row) => row.id === id);
		if (row) add(paths.get(id), entryValues(storedVersion(row.draft), [], languages).title, refs);
	};
	let picked: string | null = null;
	let reason: BuilderDestinations["reason"] = null;
	if (target.kind === "siteTemplate" || target.kind === "searchTemplate") {
		const page = target.kind === "siteTemplate" ? special.homePage : special.searchPage;
		if (page) addEntry(page.id, [target.kind === "siteTemplate" ? "site" : "content"]);
		reason = target.kind === "siteTemplate" ? "noHomePage" : "noSearchPage";
	} else if (target.kind === "entryTemplate") {
		const entry = rows.find((row) => row.postTypeId === target.postTypeId && (!entryId || row.id === entryId));
		if (entryId && !entry) throw new EntryNotFoundError();
		picked = entry?.id ?? null;
		if (entry) addEntry(entry.id, ["content"]);
		reason = entry ? "noAddress" : "noEntries";
	} else if (target.kind === "archiveTemplate") {
		if (source.template && source.postType) add(pathText(archiveAddressOf(source.postType)), source.postType.name, ["content"]);
		reason = "saveFirst";
	} else {
		const catalogue = await siteComponents(scope, "draft", sources);
		const refsIn = (tree: ElementTree, root: string): string[] => {
			const found: string[] = [];
			const visit = (nodes: readonly TreeNode[], ref: string, depth: number) => {
				if (depth > 10) return;
				for (const node of nodes) {
					if (node.type === "component") {
						const next = `${ref}/${node.id}`;
						if (node.component === target.componentId) found.push(next);
						const version = catalogue.version(node.component);
						if (version) visit(version.tree.nodes, next, depth + 1);
					}
					for (const children of childListsOf(node)) visit(children, ref, depth);
				}
			};
			visit(tree.nodes, root, 0);
			return found;
		};
		for (const template of await scope.select(templates)) {
			const refs = refsIn(template.draft as ElementTree, template.kind === "site" ? "site" : "content");
			if (!refs.length) continue;
			if (template.kind === "search") {
				if (special.searchPage) addEntry(special.searchPage.id, refs);
			} else if (template.kind === "archive") {
				const type = types.find((type) => type.id === template.postTypeId);
				if (type && !isPagePostType(type)) add(pathText(archiveAddressOf(type)), type.name, refs);
			} else {
				for (const row of rows) if (template.kind === "site" || (row.postTypeId === template.postTypeId && row.id !== special.searchPage?.id)) addEntry(row.id, refs);
			}
		}
		reason = "notPlaced";
	}
	return { pages, entryId: picked, reason: pages.length ? null : reason };
}
