/**
 * Where a Class or a Design token is used, so deleting one in use is refused with the list (spec
 * story 67). Element trees use Classes and token utilities by id, in every Template's Draft and
 * published version; the Design system uses them in its own CSS (Classes' styles and custom CSS,
 * base styles, the Site's custom CSS), its focus style and Classes' breakpoint styles.
 */
import { components, templates } from "@webcraft/db/schema";
import {
	type CssText,
	type DesignSystem,
	type ElementTree,
	elementsOf,
	referencesIn,
	UTILITY_ID_PREFIX,
} from "@webcraft/renderer";

import { storedComponentVersion } from "../content/component-versions.ts";
import { publishedPagesShowing } from "../content/components.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

/** One place a Class or token is used. */
export type DesignUse =
	| {
			kind: "template";
			templateId: string;
			/** `site` or `entry`. */
			templateKind: string;
			postTypeId: string | null;
			version: "draft" | "published";
			/** The ids of the elements that use it. */
			elements: string[];
	  }
	| {
			kind: "component";
			componentId: string;
			name: string;
			version: "draft" | "published";
			/** The ids of the elements that use it. */
			elements: string[];
	  }
	| { kind: "class"; classId: string; name: string }
	| { kind: "baseStyle"; target: string }
	| { kind: "customCss" }
	| { kind: "focus" };

/** An element tree that may use Classes, and where it is: a Template or a Component. Popups add theirs. */
type TreeSource = { tree: ElementTree; use: WithoutElements<Extract<DesignUse, { kind: "template" | "component" }>> };

/** A tree's use before its elements are known: each kind of use without `elements`. */
type WithoutElements<Use> = Use extends unknown ? Omit<Use, "elements"> : never;

async function treeSources(scope: Pick<SiteScope, "select">): Promise<TreeSource[]> {
	const sources: TreeSource[] = [];
	for (const row of await scope.select(templates)) {
		const where = { kind: "template", templateId: row.id, templateKind: row.kind, postTypeId: row.postTypeId } as const;
		sources.push({ tree: row.draft as ElementTree, use: { ...where, version: "draft" } });
		if (row.published) sources.push({ tree: row.published as ElementTree, use: { ...where, version: "published" } });
	}
	// A Component's version is `{ props, tree }`; Modules' Components hold no Classes.
	for (const row of await scope.select(components)) {
		const where = { kind: "component", componentId: row.id, name: row.name } as const;
		sources.push({ tree: treeOf(row.draft), use: { ...where, version: "draft" } });
		if (row.published) sources.push({ tree: treeOf(row.published), use: { ...where, version: "published" } });
	}
	return sources;
}

function treeOf(version: unknown): ElementTree {
	return storedComponentVersion(version).tree;
}

/** Every element tree giving an element a Class or utility that `matches` accepts. */
async function usesInTrees(scope: Pick<SiteScope, "select">, matches: (classId: string) => boolean) {
	const uses: DesignUse[] = [];
	for (const source of await treeSources(scope)) {
		const elements = [...elementsOf(source.tree.nodes)]
			.filter((element) => element.classes.some(matches))
			.map((element) => element.id);
		if (elements.length > 0) uses.push({ ...source.use, elements } as DesignUse);
	}
	return uses;
}

/** Every piece of the Design system's own CSS whose references `matches` accepts. */
function usesInCss(
	designSystem: DesignSystem,
	matches: (references: ReturnType<typeof referencesIn>) => boolean,
	except?: string,
): DesignUse[] {
	const uses: DesignUse[] = [];
	for (const each of designSystem.classes) {
		if (each.id === except) continue;
		const css: CssText = [...each.styles, ...each.css, ...Object.values(each.breakpoints).flat()];
		if (matches(referencesIn(css))) uses.push({ kind: "class", classId: each.id, name: each.name });
	}
	for (const [target, css] of Object.entries(designSystem.baseStyles)) {
		if (matches(referencesIn(css))) uses.push({ kind: "baseStyle", target });
	}
	if (matches(referencesIn(designSystem.customCss))) uses.push({ kind: "customCss" });
	return uses;
}

/** Where a Class is used: in element trees, and in the Design system's CSS (other than its own). */
export async function classUses(
	scope: Pick<SiteScope, "select">,
	designSystem: DesignSystem,
	classId: string,
): Promise<DesignUse[]> {
	return [
		...(await usesInTrees(scope, (id) => id === classId)),
		...usesInCss(designSystem, ({ classes }) => classes.includes(classId), classId),
	];
}

/**
 * Where a token is used: by its utilities in element trees, in the Design system's CSS, as the focus
 * colour, and (a breakpoint) by Classes' styles for that breakpoint.
 */
export async function tokenUses(
	scope: Pick<SiteScope, "select">,
	designSystem: DesignSystem,
	tokenId: string,
): Promise<DesignUse[]> {
	const uses = [
		...(await usesInTrees(scope, (id) => id.startsWith(UTILITY_ID_PREFIX) && id.split(":")[2] === tokenId)),
		...usesInCss(designSystem, ({ tokens }) => tokens.some((ref) => ref.token === tokenId)),
	];
	for (const each of designSystem.classes) {
		if (
			Object.hasOwn(each.breakpoints, tokenId) &&
			!uses.some((use) => use.kind === "class" && use.classId === each.id)
		) {
			uses.push({ kind: "class", classId: each.id, name: each.name });
		}
	}
	if (designSystem.tokens.focus.colour.colour === tokenId) uses.push({ kind: "focus" });
	return uses;
}

/** How many places use each Class and each token: elements in the Drafts' trees, and pieces of the Design system's own CSS. */
export type UseCounts = { classes: Record<string, number>; tokens: Record<string, number> };

/**
 * How many places use each Class and token now, as the Design system screen shows them: every
 * element of a Template's or Component's Draft giving it (or its utility) to an element, and every
 * piece of the Design system's CSS naming it (a Class's CSS, a base style, the custom CSS), the
 * focus style and Classes' breakpoint styles. Published versions aren't counted again.
 */
export async function useCounts(scope: Pick<SiteScope, "select">, designSystem: DesignSystem): Promise<UseCounts> {
	const classes: Record<string, number> = {};
	const tokens: Record<string, number> = {};
	const count = (into: Record<string, number>, id: string) => {
		into[id] = (into[id] ?? 0) + 1;
	};
	for (const source of await treeSources(scope)) {
		if (source.use.version !== "draft") continue;
		for (const element of elementsOf(source.tree.nodes)) {
			for (const id of new Set(element.classes)) {
				if (id.startsWith(UTILITY_ID_PREFIX)) count(tokens, id.split(":")[2] ?? "");
				else count(classes, id);
			}
		}
	}
	const pieces: CssText[] = [
		...designSystem.classes.flatMap((each) => [each.styles, each.css, ...Object.values(each.breakpoints)]),
		...Object.values(designSystem.baseStyles),
		designSystem.customCss,
	];
	for (const css of pieces) {
		const references = referencesIn(css);
		for (const id of new Set(references.classes)) count(classes, id);
		for (const id of new Set(references.tokens.map((ref) => ref.token))) count(tokens, id);
	}
	for (const each of designSystem.classes) for (const id of Object.keys(each.breakpoints)) count(tokens, id);
	count(tokens, designSystem.tokens.focus.colour.colour);
	return { classes, tokens };
}

/** How many elements use a Class, and on how many published pages. */
export type ClassUsage = { elements: number; pages: number };

/**
 * How widely each of some Classes is used by its own uses, as the CSS panel warns before an edit:
 * the elements of Templates' and Components' Drafts given it, and the published pages that show an
 * element given it, counted as a Component's pages are (through what places its tree).
 */
export async function classUsage(scope: SiteScope, classIds: readonly string[]): Promise<Map<string, ClassUsage>> {
	const usage = new Map<string, ClassUsage>(classIds.map((id) => [id, { elements: 0, pages: 0 }]));
	if (usage.size === 0) return usage;
	for (const source of await treeSources(scope)) {
		if (source.use.version !== "draft") continue;
		for (const element of elementsOf(source.tree.nodes)) {
			for (const id of new Set(element.classes)) {
				const each = usage.get(id);
				if (each) each.elements++;
			}
		}
	}
	const pagesShowing = await publishedPagesShowing(scope);
	for (const [id, each] of usage) {
		each.pages = pagesShowing((tree) => [...elementsOf(tree.nodes)].some((element) => element.classes.includes(id)));
	}
	return usage;
}
