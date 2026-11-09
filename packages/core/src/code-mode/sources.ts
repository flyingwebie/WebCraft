/**
 * What Code mode opens for an element on the page (ADR 0016, ADR 0017): the whole Template or
 * Component it comes from, as Template markup. Pages tag every element with where it comes from
 * (`RenderOptions.codeSource`): `content` (the page's Entry template) or `site` (the Site template),
 * then the ids of the Placements that show it, then its own id: `content/<placement id>#<id>`.
 */
import {
	BUILT_IN_SITE_TEMPLATE,
	childListsOf,
	designSystemNames,
	type ElementTree,
	isComponentInfo,
	printTemplateMarkup,
	refuseSiteTemplateCommands,
	TEMPLATE_COMMANDS,
	type TreeNode,
} from "@webcraft/renderer";

import {
	type ComponentSources,
	getComponent,
	listComponents,
	type SiteComponents,
	siteComponents,
} from "../content/components.ts";
import type { FieldDefinition, Json } from "../content/field-types.ts";
import { BUILT_IN_FIELDS } from "../content/fields.ts";
import { getGlobals } from "../content/globals.ts";
import { draftVersion } from "../content/json.ts";
import { getPostType } from "../content/post-types.ts";
import { RELATED_BUILT_INS } from "../content/render-values.ts";
import { getEntryTemplate, getSiteTemplate } from "../content/templates.ts";
import { classCatalogue } from "../design-system/classes.ts";
import { draftDesignSystem } from "../design-system/design-systems.ts";
import { EditPathInvalidError } from "../edit-mode/errors.ts";
import { isEditPath } from "../edit-mode/paths.ts";
import { isUuid } from "../ids.ts";
import type { PageContent, SiteHost } from "../site-pages/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { CodeSourceNotFoundError } from "./errors.ts";

/** Where a Code mode reference points: the Template at the root, the Placements through it, maybe an element. */
export type CodeRef = { root: "content" | "site"; placements: string[]; element: string | null };

const REF = /^(content|site)((?:\/[A-Za-z0-9_-]{1,64}){0,10})(?:#([A-Za-z0-9_-]{1,64}))?$/;

/** Reads a reference as pages tag elements with it; `CodeSourceNotFoundError` for anything else. */
export function readCodeRef(text: string): CodeRef {
	const match = REF.exec(text);
	if (!match) throw new CodeSourceNotFoundError();
	return {
		root: match[1] as CodeRef["root"],
		placements: (match[2] ?? "").split("/").filter(Boolean),
		element: match[3] ?? null,
	};
}

/** A reference written out: `content/<placement id>`, with `#<element id>` when it names one. */
export function writeCodeRef(ref: Pick<CodeRef, "root" | "placements">, element?: string | null): string {
	const source = [ref.root, ...ref.placements].join("/");
	return element ? `${source}#${element}` : source;
}

/** The kinds of Structure Code mode opens as Template markup. */
export type CodeSourceKind = "entryTemplate" | "siteTemplate" | "component";

/** One Template or Component on the way to an element: as the breadcrumb shows it. */
export type CodeStep = {
	kind: CodeSourceKind;
	/** The Template's or Component's id; null for a Site template the Site hasn't made yet. */
	id: string | null;
	/** The Post Type's name for an Entry template, the Component's name; null for the Site template. */
	name: string | null;
	/** Whether Code mode may save it: a Module's Component changes with its Module. */
	editable: boolean;
	/** Its Draft's tree. */
	tree: ElementTree;
	/** Its Draft as stored, for its version; null while it doesn't exist. */
	draft: unknown;
	/** For an Entry template, its Post Type. */
	postTypeId: string | null;
};

/** A reference followed through the page's Templates and Components. */
export type ResolvedSource = {
	ref: CodeRef;
	/** From the Template at the root to the Template or Component the element is in. */
	steps: CodeStep[];
	/** The Template or Component opened: the last step. */
	source: CodeStep;
	/** The Components' Drafts, as Drafts of Templates and Components place them. */
	catalogue: SiteComponents;
};

/** What Code mode needs from the rest of the Install. */
export type SourceDeps = {
	sources: ComponentSources;
	pageContent(host: SiteHost, pathname: string): Promise<PageContent>;
};

/**
 * Follows a reference from the page at `path`: the Template at its root (the page's Entry template,
 * or the Site template, the built-in one while the Site has none), then each Placement in the
 * Drafts to the Component it places. `CodeSourceNotFoundError` when the page shows no such thing.
 */
export async function resolveSource(
	scope: SiteScope,
	deps: SourceDeps,
	host: SiteHost,
	path: string,
	ref: CodeRef,
): Promise<ResolvedSource> {
	if (!isEditPath(path)) throw new EditPathInvalidError();
	const steps: CodeStep[] = [await rootOf(scope, deps, host, path, ref.root)];
	const catalogue = await siteComponents(scope, "draft", deps.sources);
	for (const placementId of ref.placements) {
		const current = steps.at(-1) as CodeStep;
		const placement = findNode(current.tree.nodes, placementId)?.node;
		if (placement?.type !== "component") throw new CodeSourceNotFoundError();
		const version = catalogue.version(placement.component);
		if (!version) throw new CodeSourceNotFoundError();
		// The Site's own Components have a Draft; a Module's changes with its Module.
		const own = isUuid(placement.component);
		steps.push({
			kind: "component",
			id: placement.component,
			name: catalogue.nameOf(placement.component) ?? null,
			editable: own,
			tree: version.tree,
			draft: own ? version : null,
			postTypeId: null,
		});
	}
	return { ref, steps, source: steps.at(-1) as CodeStep, catalogue };
}

/** The Template at a reference's root, for the page at `path`. */
async function rootOf(
	scope: SiteScope,
	deps: SourceDeps,
	host: SiteHost,
	path: string,
	root: CodeRef["root"],
): Promise<CodeStep> {
	if (root === "site") {
		const template = await getSiteTemplate(scope);
		return {
			kind: "siteTemplate",
			id: template?.id ?? null,
			name: null,
			editable: true,
			tree: template?.draft ?? BUILT_IN_SITE_TEMPLATE,
			draft: template?.draft ?? null,
			postTypeId: null,
		};
	}
	const content = await deps.pageContent(host, path);
	if (content.notFound || !content.templatePostTypeId) throw new CodeSourceNotFoundError();
	const template = await getEntryTemplate(scope, content.templatePostTypeId);
	if (!template) throw new CodeSourceNotFoundError();
	const postType = await getPostType(scope, content.templatePostTypeId);
	return {
		kind: "entryTemplate",
		id: template.id,
		name: postType.name,
		editable: true,
		tree: template.draft,
		draft: template.draft,
		postTypeId: postType.id,
	};
}

/** A node of a tree by its id, with the elements and Placements around it, outermost first. */
export function findNode(
	nodes: readonly TreeNode[],
	id: string,
	around: TreeNode[] = [],
): { node: TreeNode; around: TreeNode[] } | undefined {
	for (const node of nodes) {
		if ((node.type === "element" || node.type === "component") && node.id === id) return { node, around };
		const inside = node.type === "element" ? [...around, node] : around;
		for (const children of childListsOf(node)) {
			const found = findNode(children, id, inside);
			if (found) return found;
		}
	}
	return undefined;
}

/** What Code mode's HTML panel shows for a reference. */
export type OpenedSource = {
	source: { kind: CodeSourceKind; id: string | null; name: string | null; editable: boolean };
	/** The source's own reference, without the element: `content/<placement id>`. */
	ref: string;
	/** Its Draft as Template markup. */
	markup: string;
	/** Its Draft's version, which a save names so it never overwrites a newer one; null while it doesn't exist. */
	version: string | null;
	/** The element selected, if the reference names one the Draft has: its id and tag (a Component's name for a Placement). */
	element: { id: string; tag: string } | null;
	/** The Templates and Components on the way, each with the reference that opens it at the next Placement. */
	breadcrumb: { label: string | null; kind: CodeSourceKind; ref: string }[];
	/** The element and the elements around it in the source, outermost first, as `tag.class` or `<Component>`. */
	path: { id: string; label: string }[];
	/** For a Component, on how many published pages it shows: a change applies to all of them. */
	usage: { pages: number } | null;
	suggestions: Suggestions;
};

/** What the HTML panel suggests while Staff type: see `suggestionsFor`. */
export type Suggestions = {
	/** What `{{` may read here: Fields and their parts, the Globals (`site.x`), Props (`props.x`). */
	values: { path: string; label: string | null; type: string; group: "entry" | "globals" | "props"; sample?: string }[];
	/** The Components that may be placed here, with their Props. */
	components: { name: string; props: { key: string; label: string; required: boolean }[] }[];
	/** The Template commands `{{@` offers, from the registry, as this kind of Template may hold them. */
	commands: { name: string; block: boolean; snippet: string }[];
	/** Ready-made markup `{{@` offers: WebCraft's own, then Modules' Structure presets. */
	presets: { id: string; snippet: string }[];
	/** The Site's Loops, by name: none until Loops come (#62). */
	loops: { name: string }[];
	/** The Classes and token utilities `class=""` may name. */
	classes: { name: string; utility: boolean }[];
};

/**
 * WebCraft's own presets in the `{{@` menu: plain markup Staff edit like any other (ADR 0017). The
 * ones reading Loops, languages and dates join with their tickets; Modules' Structure presets (#110)
 * join after these.
 */
export const BUILT_IN_PRESETS: readonly { id: string; snippet: string }[] = [
	{ id: "hasValue", snippet: "{{@if $0}}\n{{/if}}" },
	{ id: "isEmpty", snippet: "{{@if not $0}}\n{{/if}}" },
	{ id: "ifElse", snippet: "{{@if $0}}\n{{@else}}\n{{/if}}" },
];

/** Opens a reference for the HTML panel. */
export async function openSource(
	scope: SiteScope,
	deps: SourceDeps,
	host: SiteHost,
	path: string,
	ref: CodeRef,
): Promise<OpenedSource> {
	const resolved = await resolveSource(scope, deps, host, path, ref);
	const { source, steps, catalogue } = resolved;
	const classes = classCatalogue(await draftDesignSystem(scope));
	const found = ref.element ? findNode(source.tree.nodes, ref.element) : undefined;
	const label = (node: TreeNode): string => {
		if (node.type === "component") return `<${catalogue.nameOf(node.component) ?? "Component"}>`;
		if (node.type !== "element") return node.type;
		const [first] = node.classes;
		const name = first === undefined ? undefined : classes.nameOf(first);
		return name ? `${node.tag}.${name}` : node.tag;
	};
	const idOf = (node: TreeNode) => (node.type === "element" || node.type === "component" ? node.id : "");
	const tagOf = (node: TreeNode) =>
		node.type === "component" ? (catalogue.nameOf(node.component) ?? "") : node.type === "element" ? node.tag : "";
	return {
		source: { kind: source.kind, id: source.id, name: source.name, editable: source.editable },
		ref: writeCodeRef(ref),
		markup: printTemplateMarkup(source.tree, {
			className: classes.nameOf,
			componentName: catalogue.nameOf,
			formKey: catalogue.forms.keyOf,
		}),
		version: source.draft === null ? null : draftVersion(source.draft),
		element: found ? { id: idOf(found.node), tag: tagOf(found.node) } : null,
		breadcrumb: steps.map((step, index) => ({
			label: step.name,
			kind: step.kind,
			ref: writeCodeRef(
				{ root: ref.root, placements: ref.placements.slice(0, index) },
				index < steps.length - 1 ? ref.placements[index] : null,
			),
		})),
		path: found ? [...found.around, found.node].map((node) => ({ id: idOf(node), label: label(node) })) : [],
		usage:
			source.kind === "component" && source.id !== null
				? { pages: (await getComponent(scope, source.id, deps.sources)).usage.pages }
				: null,
		suggestions: await suggestionsFor(scope, deps, resolved),
	};
}

/** What the HTML panel suggests for a source: what it may read, place and name. */
async function suggestionsFor(scope: SiteScope, deps: SourceDeps, resolved: ResolvedSource): Promise<Suggestions> {
	const { source } = resolved;
	const values: Suggestions["values"] = [];
	if (source.kind === "entryTemplate" && source.postTypeId) {
		for (const key of BUILT_IN_FIELDS) values.push({ path: key, label: null, type: "builtIn", group: "entry" });
		const postType = await getPostType(scope, source.postTypeId);
		for (const field of postType.fields) values.push(...valuesOf(field, "", null, "entry"));
	}
	if (source.kind === "component" && source.id !== null) {
		const version = resolved.catalogue.version(source.id);
		for (const prop of version?.props ?? []) values.push(...valuesOf(prop, "props.", null, "props"));
	}
	const globals = await getGlobals(scope);
	for (const field of globals.fields) {
		values.push(...valuesOf(field, "site.", null, "globals", { [field.key]: globals.draft[field.key] ?? null }));
	}

	// Components: every one this source may place, never one placing it.
	const self = source.kind === "component" && source.id !== null ? source.id : undefined;
	const placeable = await siteComponents(scope, "draft", deps.sources, { self });
	const components = (await listComponents(scope, deps.sources))
		.filter((component) => isComponentInfo(placeable.byId(component.id)))
		.map((component) => ({
			name: component.name,
			props: component.draft.props.map((prop) => ({
				key: prop.key,
				label: prop.label,
				required: prop.required && (prop.default === null || prop.default === undefined),
			})),
		}));

	const refuse = source.kind === "siteTemplate" ? () => undefined : refuseSiteTemplateCommands;
	const commands = TEMPLATE_COMMANDS.filter((command) => refuse(command.name) === undefined).map((command) => ({
		name: command.name,
		block: command.block,
		snippet: command.snippet,
	}));

	const designSystem = await draftDesignSystem(scope);
	const classes = [
		...designSystem.classes.map((each) => ({ name: each.name, utility: false })),
		...designSystemNames(designSystem).utilities.map((utility) => ({ name: utility.name, utility: true })),
	];
	return { values, components, commands, presets: [...BUILT_IN_PRESETS], loops: [], classes };
}

/**
 * A Field (or Prop, or Global) and its parts as bindings name them: a Group's or Repeater's Fields,
 * a link's `url` and `text`, a select's `value` and `label`, what a Relationship points at.
 */
function valuesOf(
	field: FieldDefinition,
	prefix: string,
	parent: string | null,
	group: Suggestions["values"][number]["group"],
	sampleFrom?: Record<string, Json | null>,
): Suggestions["values"] {
	const path = `${prefix}${field.key}`;
	const label = parent ? `${parent} › ${field.label}` : field.label;
	const value = sampleFrom?.[field.key];
	const sample = typeof value === "string" ? value.slice(0, 60) : typeof value === "number" ? String(value) : undefined;
	const own = { path, label, type: field.type, group, ...(sample === undefined ? {} : { sample }) };
	switch (field.type) {
		case "group":
		case "repeater": {
			const nested = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {};
			return [own, ...field.fields.flatMap((inner) => valuesOf(inner, `${path}.`, label, group, nested))];
		}
		case "link":
			return [own, ...parts(path, label, group, ["url", "text"])];
		case "select":
			return [own, ...parts(path, label, group, ["value", "label"])];
		case "relationship":
			return [own, ...parts(path, label, group, RELATED_BUILT_INS)];
		default:
			return [own];
	}
}

function parts(
	path: string,
	label: string,
	group: Suggestions["values"][number]["group"],
	names: readonly string[],
): Suggestions["values"] {
	return names.map((name) => ({ path: `${path}.${name}`, label: `${label} › ${name}`, type: "part", group }));
}
