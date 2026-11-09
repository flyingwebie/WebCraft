import { type ElementTree, filtersPlacedIn, phoneWidthOf, randomElementId, type TreeNode } from "@webcraft/renderer";

import { adminMediaPath, renderPreview } from "../builder/preview.ts";
import { type BuilderSource, type BuilderTarget, readSource } from "../builder/sources.ts";
import { archiveParts } from "../content/archives.ts";
import type { ComponentSources } from "../content/components.ts";
import type { ContentProblem } from "../content/errors.ts";
import { siteLanguages } from "../content/languages.ts";
import { classCatalogue } from "../design-system/classes.ts";
import { draftDesignSystem } from "../design-system/design-systems.ts";
import { draftStyles, draftTrees } from "../design-system/stylesheet.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type FilterVersionInput, readFilterVersion } from "./definition.ts";
import { FilterInvalidError } from "./errors.ts";
import { getFilter, loopContext } from "./filters.ts";
import { type FilterPlacement, filterUsages } from "./usage.ts";

/**
 * The Filter builder's live preview (GLOSSARY.md › Filter): a Filter's Draft as Staff are changing it
 * (not saved), shown where it is placed (the Template or Component holding it, as the visual builder's
 * canvas shows that tree; the first of them: an Archive template, then the Search results template,
 * an Entry template, the Site template, a Component) or, while it is placed nowhere, beside a list of
 * its Loop's items. It is rendered by the Site's own renderer, with the Loop's published Entries and
 * real counts for the choices of `query` (as a page's address has them), in the Design system's
 * Draft, which styles its layout presets. The admin shows it in the canvas's frame, which runs no
 * script.
 */
export type FilterPreviewInput = FilterVersionInput & {
	/** The choices the preview shows, as a page's address has them (`category=bread&sort=price-asc`). */
	query?: string;
	/** The language to show it in, one of the Site's; its Default language when absent. */
	language?: string;
};

export type FilterPreview = {
	html: string;
	/** The Design system's Draft stylesheet, with what the previewed tree uses. */
	css: string;
	/** The address of the page shown, with its choices in their normal form (`/shop?category=bread`). */
	url: string;
	/** What screen readers hear once the Loop updates: its result count ("14 products"). */
	count: string;
	/** Where phones end: below it, a Filter that becomes a drawer on phones shows as one. */
	phoneWidth: number;
	language: { code: string; direction: "ltr" | "rtl" };
	/** Whether the Design system's Draft has Dark mode on. */
	darkMode: boolean;
};

/** The order a Filter's placements are preferred in for its preview. */
const PREFERRED: readonly FilterPlacement["kind"][] = [
	"archiveTemplate",
	"searchTemplate",
	"entryTemplate",
	"siteTemplate",
	"component",
];

/** Previews a Filter's Draft with `input`'s changes (open the Site with `structure.edit`), checked as saving checks them. */
export async function previewFilter(
	scope: SiteScope,
	sources: ComponentSources,
	filterId: string,
	input: FilterPreviewInput,
): Promise<FilterPreview> {
	const filter = await getFilter(scope, filterId);
	const { query = "", language, ...change } = input;
	const problems: ContentProblem[] = [];
	const context = await loopContext(scope, filter.loop, "draft", problems);
	const version = context ? readFilterVersion(change, filter.draft, context, problems) : filter.draft;
	if (problems.length > 0) throw new FilterInvalidError(problems);

	const placements = [...(await filterUsages(scope))(filter.id).usedIn].sort(
		(a, b) => PREFERRED.indexOf(a.kind) - PREFERRED.indexOf(b.kind),
	);
	// `filterUsages` counts a placement from either its Draft or its published tree; only one whose
	// *current* Draft still places the Filter (its form, or a control of its own) previews it there.
	let source: BuilderSource | undefined;
	for (const placement of placements) {
		const target = targetOf(placement);
		if (!target) continue;
		const candidate = await readSource(scope, target, sources);
		if (filtersPlacedIn(candidate.draft).includes(filter.id)) {
			source = candidate;
			break;
		}
	}
	const tree = source ? source.draft : besideItsLoop(filter.id, filter.loop);
	const path =
		source?.kind === "archive" && source.postType
			? `/${(archiveParts(source.postType.urlPattern) ?? []).join("/")}`
			: "/";

	const designSystem = await draftDesignSystem(scope);
	const catalogue = classCatalogue(designSystem);
	const components = source?.components;
	const rendered = await renderPreview(scope, sources, {
		kind: source?.kind ?? "site",
		postType: source?.postType ?? null,
		props: source?.props ?? null,
		tree,
		className: catalogue.nameOf,
		formKey: (formId) => components?.forms.keyOf(formId),
		filterName: (id) => components?.filters.nameOf(id) ?? (id === filter.id ? filter.name : undefined),
		language,
		filter: { id: filter.id, version, params: new URLSearchParams(query), path },
	});
	const styles = await draftStyles(scope, { designSystem, trees: [...(await draftTrees(scope)), tree] });
	const site = await siteLanguages(scope);
	const shown =
		site.languages.find((each) => each.code === language) ??
		site.languages.find((each) => each.code === site.defaultLanguage);
	return {
		html: rendered.html,
		// Files the stylesheet names on the Site's domain are where the admin serves them.
		css: styles.stylesheet.css.replaceAll(/url\((["']?)\/_media\//g, `url($1${adminMediaPath(scope.site.id)}`),
		url: rendered.filter?.url ?? path,
		count: rendered.filter?.count ?? "",
		phoneWidth: phoneWidthOf(designSystem.tokens.breakpoints),
		language: { code: shown?.code ?? site.defaultLanguage, direction: shown?.direction ?? "ltr" },
		darkMode: designSystem.darkMode,
	};
}

/**
 * The visual builder's target for where a Filter is placed. The browser's own mapping of the same
 * five kinds is `builderPath` in `apps/server/src/ui/filters/LayoutTab.tsx` (the builder's URL
 * instead of this `BuilderTarget`); kept apart rather than behind one shared table because browser
 * code may not import `@webcraft/core` itself (only types or its small no-import entry points, see
 * docs/development.md), and the two outputs differ in shape (a path string there, a target object
 * here), so a shared table would need its own translation at each call site anyway.
 */
function targetOf(placement: FilterPlacement): BuilderTarget | undefined {
	switch (placement.kind) {
		case "siteTemplate":
			return { kind: "siteTemplate" };
		case "searchTemplate":
			return { kind: "searchTemplate" };
		case "entryTemplate":
		case "archiveTemplate":
			return placement.postTypeId ? { kind: placement.kind, postTypeId: placement.postTypeId } : undefined;
		case "component":
			return { kind: "component", componentId: placement.id };
	}
}

/** A tree showing a Filter placed nowhere yet: its form, then its Loop's items by title, and their pagination. */
function besideItsLoop(filterId: string, loop: string): ElementTree {
	const element = (tag: string, children: TreeNode[]): TreeNode => ({
		type: "element",
		id: randomElementId(),
		tag,
		attributes: [],
		classes: [],
		children,
	});
	const title: TreeNode = { type: "value", path: "item.title" };
	return {
		version: 1,
		nodes: [
			{ type: "filter", filter: filterId, loop },
			element("ul", [
				{
					type: "loop",
					source: loop,
					alias: "item",
					children: [element("li", [title])],
					empty: null,
				},
			]),
			{ type: "pagination", loop },
		],
	};
}
