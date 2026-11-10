/**
 * The visual builder (ADRs 0002, 0009, 0017): Staff build Templates and Components on a canvas, as
 * the element trees they are stored as. The builder and Template markup are two views of one Draft:
 * the builder edits the tree in the browser, prints it as Template markup and saves that through
 * the same saves as Code mode, the CLI and AI clients (`templates.save…Markup`,
 * `components.saveMarkup`, each based on the version it opened), so a save from either view is the
 * same Draft and nothing is reformatted. Co-editing (ADR 0025) replaces that save with changes to
 * the Draft's shared document.
 *
 * A one-off style the builder gives an element stays pending until the save: the markup carries it
 * as an inline `style`, which the save turns into a generated Class in the same transaction, exactly
 * as markup written by hand does. Previews read it the same way, for the preview only.
 */
import {
	designSystemNames,
	type ElementNode,
	type ElementTree,
	ElementTreeInvalidError,
	elementsOf,
	isComponentInfo,
	type MarkupNotice,
	parseElementTree,
	parseTemplateMarkup,
	printCss,
	printTemplateMarkup,
	readInlineStyle,
	TEMPLATE_COMMANDS,
	TEMPLATE_ELEMENTS,
	type TreeProblem,
} from "@webcraft/renderer";

import { valuesOf } from "../code-mode/sources.ts";
import { type Component, type ComponentSources, getComponent, listComponents } from "../content/components.ts";
import type { FieldDefinition, FieldInput } from "../content/field-types.ts";
import { BUILT_IN_FIELDS } from "../content/fields.ts";
import { getGlobals } from "../content/globals.ts";
import { siteLanguages } from "../content/languages.ts";
import { listLoops } from "../content/loops.ts";
import type { PostType } from "../content/post-types.ts";
import type { Template } from "../content/templates.ts";
import { type ClassCatalogue, classCatalogue } from "../design-system/classes.ts";
import { draftDesignSystem } from "../design-system/design-systems.ts";
import { draftStyles, draftTrees } from "../design-system/stylesheet.ts";
import { listFilters } from "../filters/filters.ts";
import { siteFormList } from "../forms/forms.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { adminMediaPath, renderPreview } from "./preview.ts";
import { type BuilderSource, type BuilderTarget, readSource } from "./sources.ts";

export { CANVAS_SOURCE, type CanvasPlaceholder } from "./preview.ts";
export type { BuilderTarget } from "./sources.ts";

/** One-off styles of elements the builder hasn't saved yet: canonical declarations by element id. */
export type PendingStyles = Readonly<Record<string, string>>;

/** A tree as the builder has it: its elements, their pending one-off styles, and a Component's Props. */
export type BuilderDraft = { tree: unknown; styles?: PendingStyles; props?: FieldInput[] };

/** What the builder offers on one Template or Component: see `BuilderOpened.catalogue`. */
export type BuilderCatalogue = {
	/** The elements this kind of tree may hold, by tag. */
	elements: string[];
	/** The Template commands it may hold, by name (`if`, `loop`, `form`, …). */
	commands: string[];
	/** The Design system's Draft's Classes, in order, with their styles for every width as CSS. */
	classes: { id: string; name: string; generated: boolean; styles: string }[];
	/** Its token utilities. */
	utilities: { id: string; name: string }[];
	/** The custom properties its tokens make (`--space-m`), which styles read with `var()`. */
	tokens: string[];
	/** The Components the tree may place (never one placing it), with their Props. */
	components: { id: string; name: string; props: { key: string; label: string; type: string; required: boolean }[] }[];
	/** The Site's Loops, by name. */
	loops: { name: string }[];
	/** The Site's Forms. */
	forms: { id: string; key: string; name: string }[];
	/**
	 * The Site's Filters, each with the Loop it narrows and its controls in its Draft (each one can be
	 * shown on its own with `control="<id>"`).
	 */
	filters: { id: string; name: string; loop: string; controls: { id: string; type: string; label: string | null }[] }[];
	/** What bindings may read here: Fields and their parts, the Globals (`site.x`), Props (`props.x`). */
	values: { path: string; label: string | null; type: string; group: "entry" | "globals" | "props" }[];
};

/** What opening a Template or Component in the builder answers. */
export type BuilderOpened = {
	/** The Template; null while the Site hasn't made it (the first save makes it), and for a Component. */
	template: Template | null;
	/** The Component; null for a Template. */
	component: Component | null;
	/** The Post Type of an Entry or Archive template. */
	postType: PostType | null;
	/** A Component's Props, as its Draft has them. */
	props: FieldDefinition[] | null;
	/** The Draft's tree; empty while there is none. */
	tree: ElementTree;
	/** The Draft's version, which the next save names as `basedOn`. */
	version: string | null;
	catalogue: BuilderCatalogue;
	/** Whether the Design system's Draft has Dark mode on: the canvas's dark preview needs it. */
	darkMode: boolean;
	/** The Site's Default language: the canvas shows the tree in it. */
	language: { code: string; direction: "ltr" | "rtl" };
	/** For a Component, on how many published pages visitors see it. */
	usage: { pages: number } | null;
};

/** The canvas for a tree: its HTML and the stylesheet it shows with (the Design system's Draft). */
export type BuilderPreview = { html: string; css: string; checks: import("@webcraft/renderer").QualityCheck[] };

export type Builder = {
	/** Opens a Template or Component (open the Site with `structure.edit`). */
	open(scope: SiteScope, target: BuilderTarget): Promise<BuilderOpened>;
	/**
	 * Renders a tree for the canvas, checked as saving checks it (`ElementTreeInvalidError` with each
	 * problem and where; a one-off style that can't be one at `styles.<element id>`), with the
	 * Design system's Draft's stylesheet, its one-off styles as generated Classes for the preview only.
	 */
	preview(scope: SiteScope, target: BuilderTarget, draft: BuilderDraft): Promise<BuilderPreview>;
	/**
	 * A tree as Template markup, its pending one-off styles as inline styles: what the Template
	 * markup view shows and what a save sends. Checked as `preview` checks it.
	 */
	markup(scope: SiteScope, target: BuilderTarget, draft: BuilderDraft): Promise<{ markup: string }>;
	/**
	 * Reads Template markup back into a tree, as saving it would (`TemplateMarkupInvalidError` with
	 * each problem's line and column), keeping its inline styles as pending one-off styles rather than
	 * making Classes of them: switching views makes nothing.
	 */
	read(
		scope: SiteScope,
		target: BuilderTarget,
		input: { markup: string; props?: FieldInput[] },
	): Promise<{ tree: ElementTree; styles: Record<string, string>; notices: MarkupNotice[] }>;
};

export function createBuilder(options: { sources: ComponentSources }): Builder {
	const { sources } = options;
	return {
		async open(scope, target) {
			const source = await readSource(scope, target, sources);
			const designSystem = await draftDesignSystem(scope);
			const site = await siteLanguages(scope);
			const language = site.languages.find((each) => each.code === site.defaultLanguage);
			return {
				template: source.template,
				component: source.component,
				postType: source.postType,
				props: source.props,
				tree: source.draft,
				version: source.version,
				catalogue: await catalogueOf(scope, source, sources, designSystem),
				darkMode: designSystem.darkMode,
				language: { code: site.defaultLanguage, direction: language?.direction ?? "ltr" },
				usage: source.component
					? { pages: (await getComponent(scope, source.component.id, sources)).usage.pages }
					: null,
			};
		},

		async preview(scope, target, draft) {
			const source = await readSource(scope, target, sources, draft.props);
			const designSystem = await draftDesignSystem(scope);
			const catalogue = classCatalogue(designSystem);
			const tree = withStyleClasses(checked(draft.tree, source, catalogue), draft.styles ?? {}, catalogue);
			const { html, checks } = await renderPreview(scope, sources, {
				kind: source.kind,
				postType: source.postType,
				props: source.props,
				tree,
				className: catalogue.nameOf,
				formKey: source.components.forms.keyOf,
				filterName: source.components.filters.nameOf,
			});
			const styles = await draftStyles(scope, {
				designSystem: { ...designSystem, classes: [...designSystem.classes, ...catalogue.created] },
				trees: [...(await draftTrees(scope)), tree],
			});
			// Files the stylesheet names on the Site's domain are where the admin serves them.
			const css = styles.stylesheet.css.replaceAll(/url\((["']?)\/_media\//g, `url($1${adminMediaPath(scope.site.id)}`);
			return { html, css, checks };
		},

		async markup(scope, target, draft) {
			const source = await readSource(scope, target, sources, draft.props);
			const catalogue = classCatalogue(await draftDesignSystem(scope));
			const tree = checked(draft.tree, source, catalogue);
			const styles = canonicalStyles(tree, draft.styles ?? {});
			return {
				markup: printTemplateMarkup(tree, {
					className: catalogue.nameOf,
					componentName: source.components.nameOf,
					formKey: source.components.forms.keyOf,
					filterName: source.components.filters.nameOf,
					inlineStyle: (elementId) => styles.get(elementId),
				}),
			};
		},

		async read(scope, target, input) {
			const source = await readSource(scope, target, sources, input.props);
			const catalogue = classCatalogue(await draftDesignSystem(scope));
			// Classes an inline style would make: kept as the element's pending one-off style instead.
			const pending = new Map<string, { name: string; declarations: string }>();
			const parsed = parseTemplateMarkup(input.markup, {
				...source.rules,
				classNamed: catalogue.named,
				classForStyle(declarations) {
					const before = catalogue.created.length;
					const found = catalogue.forStyle(declarations);
					if (!("problem" in found) && catalogue.created.length > before) {
						pending.set(found.id, { name: found.name, declarations });
					}
					return found;
				},
			});
			const tree = structuredClone(parsed.tree);
			const styles: Record<string, string> = {};
			for (const element of elementsOf(tree.nodes)) {
				const own = element.classes.filter((classId) => pending.has(classId));
				if (own.length === 0) continue;
				element.classes = element.classes.filter((classId) => !pending.has(classId));
				styles[element.id] = own.map((classId) => pending.get(classId)?.declarations ?? "").join(" ");
			}
			const made = [...pending.values()].map((each) => each.name);
			const notices = parsed.notices.filter((notice) => !made.some((name) => notice.message.includes(name)));
			return { tree, styles, notices };
		},
	};
}

/** A tree from the builder, checked as saving its Draft would check it. */
function checked(tree: unknown, source: BuilderSource, catalogue: ClassCatalogue): ElementTree {
	return parseElementTree(tree, { ...source.rules, classIds: catalogue.ids });
}

/**
 * Pending one-off styles in canonical form, by the id of an element the tree has. Throws
 * `ElementTreeInvalidError` for one that can't be an inline style (`styles.<element id>`).
 */
function canonicalStyles(tree: ElementTree, styles: PendingStyles): Map<string, string> {
	const ids = new Set([...elementsOf(tree.nodes)].map((element) => element.id));
	const problems: TreeProblem[] = [];
	const canonical = new Map<string, string>();
	for (const [elementId, written] of Object.entries(styles)) {
		if (!ids.has(elementId)) continue;
		const read = readInlineStyle(written);
		if ("problem" in read) problems.push({ at: `styles.${elementId}`, message: read.problem });
		else if (read.declarations) canonical.set(elementId, read.declarations);
	}
	if (problems.length > 0) throw new ElementTreeInvalidError(problems);
	return canonical;
}

/**
 * The tree with each pending one-off style as the generated Class it will become (one the Site has
 * for the same declarations, else one made for the preview only, in `catalogue.created`).
 */
function withStyleClasses(tree: ElementTree, styles: PendingStyles, catalogue: ClassCatalogue): ElementTree {
	const canonical = canonicalStyles(tree, styles);
	if (canonical.size === 0) return tree;
	const problems: TreeProblem[] = [];
	const shown = structuredClone(tree);
	for (const element of elementsOf(shown.nodes) as Iterable<ElementNode>) {
		const declarations = canonical.get(element.id);
		if (!declarations) continue;
		const generated = catalogue.forStyle(declarations);
		if ("problem" in generated) problems.push({ at: `styles.${element.id}`, message: generated.problem });
		else if (!element.classes.includes(generated.id)) element.classes.push(generated.id);
	}
	if (problems.length > 0) throw new ElementTreeInvalidError(problems);
	return shown;
}

/** What the builder offers on the source: see `BuilderCatalogue`. */
async function catalogueOf(
	scope: SiteScope,
	source: BuilderSource,
	sources: ComponentSources,
	designSystem: Awaited<ReturnType<typeof draftDesignSystem>>,
): Promise<BuilderCatalogue> {
	const names = designSystemNames(designSystem);
	const { rules } = source;
	const values: BuilderCatalogue["values"] = [];
	if (source.kind === "entry" && source.postType) {
		for (const key of BUILT_IN_FIELDS) values.push({ path: key, label: null, type: "builtIn", group: "entry" });
		for (const field of source.postType.fields) values.push(...valuesOf(field, "", null, "entry").map(withoutSample));
	}
	for (const prop of source.props ?? []) values.push(...valuesOf(prop, "props.", null, "props").map(withoutSample));
	for (const field of (await getGlobals(scope)).fields) {
		values.push(...valuesOf(field, "site.", null, "globals").map(withoutSample));
	}
	const components = (await listComponents(scope, sources))
		.filter((component) => isComponentInfo(source.components.byId(component.id)))
		.map((component) => ({
			id: component.id,
			name: component.name,
			props: component.draft.props.map((prop) => ({
				key: prop.key,
				label: prop.label,
				type: prop.type,
				required: prop.required && (prop.default === null || prop.default === undefined),
			})),
		}));
	return {
		elements: [...TEMPLATE_ELEMENTS].filter((tag) => rules.refuseElement?.(tag) === undefined).sort(),
		commands: TEMPLATE_COMMANDS.filter((command) => rules.refuseCommand?.(command.name) === undefined).map(
			(command) => command.name,
		),
		classes: designSystem.classes.map((each) => ({
			id: each.id,
			name: each.name,
			generated: each.generated,
			styles: printCss(each.styles, names.print),
		})),
		utilities: names.utilities.map((utility) => ({ id: utility.id, name: utility.name })),
		tokens: names.tokens.properties.map((token) => token.property),
		components,
		loops: (await listLoops(scope)).map((loop) => ({ name: loop.name })),
		forms: await siteFormList(scope),
		filters: (await listFilters(scope)).map((filter) => ({
			id: filter.id,
			name: filter.name,
			loop: filter.loop,
			controls: filter.draft.controls.map((control) => ({
				id: control.id,
				type: control.type,
				label: "label" in control ? (control.label?.text ?? null) : null,
			})),
		})),
		values,
	};
}

function withoutSample<Value extends { sample?: string }>(value: Value): Omit<Value, "sample"> {
	const { sample: _, ...rest } = value;
	return rest;
}
