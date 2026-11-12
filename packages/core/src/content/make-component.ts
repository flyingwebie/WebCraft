/**
 * New ways in from Code mode and the Builder to make Components (#134, decided in #121):
 *
 * - **Make Component** moves one node of a Template's or Component's Draft into a new Component and
 *   leaves a Placement of it in its place, so the page looks the same. What the markup read from
 *   where it was (the Entry's values, an outer Loop's items, the outer Component's Props) comes in
 *   through Props the new Component declares, with the source's own Field definitions, each bound
 *   on the Placement to what it read before. Fixed text chosen in the dialog becomes a text Prop
 *   whose default is the text.
 * - **New Component** with a place makes an empty Component and places it there.
 *
 * Both are one transaction: the Component is made, its Draft saved and the source's Draft saved
 * through their usual savers (the same rules, Permission and checks), or nothing changes. The node
 * (or the list a Placement goes into) is compared with what the editor saw, so a change someone
 * made meanwhile refuses the action (`DraftChangedError`) instead of losing it.
 */

import {
	childListsOf,
	type ElementTree,
	type Expression,
	fixedTextsOf,
	hasText,
	type PlacementNode,
	randomElementId,
	type TextNode,
	type TreeNode,
} from "@webcraft/renderer";

import { z } from "zod";

import type { SiteScope } from "../tenancy/data-layer.ts";
import {
	type Component,
	type ComponentSources,
	componentSource,
	componentVersion,
	insertComponent,
	NO_MODULE_COMPONENTS,
	namingComponent,
	saveComponentDraft,
} from "./components.ts";
import { ComponentInvalidError, type ContentProblem, DraftChangedError } from "./errors.ts";
import { FIELD_KEY } from "./field-rules.ts";
import { BUILT_IN_FIELDS, type FieldDefinition, type FieldInput } from "./fields.ts";
import { draftVersion, sameJson } from "./json.ts";
import { siteLoops } from "./loops.ts";
import { getPostType, listPostTypes, type PostType } from "./post-types.ts";
import { QUERY_ITEM_BUILT_INS } from "./render-values.ts";
import {
	getArchiveTemplate,
	getEntryTemplate,
	getSearchTemplate,
	getSiteTemplate,
	saveArchiveTemplate,
	saveEntryTemplate,
	saveSearchTemplate,
	saveSiteTemplate,
} from "./templates.ts";

/**
 * Where a Component is made from or placed: a Template's Draft (by kind and Post Type) or one of
 * the Site's own Components'. The one schema the Management API and Code mode's actions read.
 */
export const componentSourceTarget = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("siteTemplate") }),
	z.object({ kind: z.literal("searchTemplate") }),
	z.object({ kind: z.literal("entryTemplate"), postTypeId: z.uuid() }),
	z.object({ kind: z.literal("archiveTemplate"), postTypeId: z.uuid() }),
	z.object({ kind: z.literal("component"), componentId: z.uuid() }),
]);
export type ComponentSourceTarget = z.infer<typeof componentSourceTarget>;

/**
 * Where a node is in a tree, as the editors write it: its index among the tree's nodes, then for
 * each level down which of its container's lists (an element has one; a Condition one per branch,
 * then Else; a Loop its items, then Empty) and its index there: `[2, 0, 1]` is the second child of
 * the third node.
 */
export const treePath = z
	.array(z.number().int().min(0).max(100_000))
	.min(1)
	.max(201)
	.refine(
		(path) => path.length % 2 === 1,
		"A path has an odd number of steps: an index, then a list and an index for each level down.",
	);
export type TreePath = Readonly<z.infer<typeof treePath>>;

/** Make Component's pieces of fixed text to turn into Props: their `fixedTextsOf` order and each Prop's key. */
export const madeTexts = z
	.array(z.object({ index: z.number().int().min(0).max(100_000), key: z.string().max(64) }))
	.max(200);

/** New Component's place: where its Placement goes (its path once there) and the list as the editor read it. */
export const newComponentPlace = z.object({
	source: componentSourceTarget,
	path: treePath,
	list: z.array(z.unknown()).max(100_000),
});

/** Make Component: the node to move, as the editor saw it, and the fixed text to turn into Props. */
export type MakeComponentInput = {
	name: string;
	source: ComponentSourceTarget;
	path: TreePath;
	/** The node as the editor saw it; refused with `DraftChangedError` when the Draft holds another. */
	node: unknown;
	/** Pieces of fixed text (`fixedTextsOf` order) to turn into text Props, each with the Prop's key. */
	texts?: readonly { index: number; key: string }[];
};

/** New Component, placed: where its Placement goes (its path once there) and the list as the editor saw it. */
export type NewComponentPlace = z.infer<typeof newComponentPlace>;

/** What making or placing a Component did: the Component and its Placement in the source. */
export type MadeComponent = {
	component: Component;
	placement: { id: string; path: number[] };
	/** The source's Draft version after the change. */
	version: string;
	/** The accepted source change, without unrelated writes arriving before the caller receives it. */
	sourceChange: { kind: "component" | "template"; id: string; before: ElementTree; after: ElementTree };
};

/** Moves the node at `input.path` into a new Component and places it there instead. */
export async function makeComponent(
	scope: SiteScope,
	input: MakeComponentInput,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<MadeComponent> {
	// The name is checked under the Site's Component lock inside; a clash only words itself once the
	// whole step has rolled back (`namingComponent`), since a nested transaction has no savepoint.
	return namingComponent(scope, input.name, () =>
		scope.transaction(async (tx) => {
			const source = await readTarget(tx, input.source, sources);
			const found = at(source.tree, input.path);
			if (!found || !sameJson(found.node, input.node)) throw new DraftChangedError(source.version);
			if (found.node.type !== "element" && found.node.type !== "component") {
				throw new ComponentInvalidError([
					{ at: "path", message: "Only an element or a Placement can become a Component." },
				]);
			}
			const context = await readingContext(tx, source, found.loops);
			const extracted = withBindingProps(structuredClone(found.node), context);
			const texts = withTextProps(extracted.node, input.texts ?? [], extracted.props);
			const props = [...extracted.props, ...texts.props];
			const component = await insertComponent(tx, { name: input.name }, sources);
			const saved = await saveComponentDraft(
				tx,
				component.id,
				{ props, tree: { version: 1, nodes: [texts.node] } },
				sources,
			);
			const placement: PlacementNode = {
				type: "component",
				id: freshId(source.tree),
				component: component.id,
				props: [...extracted.values, ...texts.values],
			};
			const written = await writeTarget(tx, input.source, replaced(source.tree, input.path, placement), sources);
			return {
				component: saved,
				placement: { id: placement.id, path: [...input.path] },
				version: written.version,
				sourceChange: {
					kind: input.source.kind === "component" ? "component" : "template",
					id: written.id,
					before: source.tree,
					after: written.tree,
				},
			};
		}),
	);
}

/** Makes an empty Component with its name and places it where `place` says, in one transaction. */
export async function createPlacedComponent(
	scope: SiteScope,
	input: { name: string; props?: FieldInput[] },
	place: NewComponentPlace,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<MadeComponent> {
	return namingComponent(scope, input.name, () =>
		scope.transaction(async (tx) => {
			const source = await readTarget(tx, place.source, sources);
			const index = place.path.at(-1);
			const list = index === undefined ? undefined : listAt(source.tree, place.path.slice(0, -1));
			if (index === undefined || !list || index > list.length || !sameJson(list, place.list))
				throw new DraftChangedError(source.version);
			const component = await insertComponent(tx, input, sources);
			const placement: PlacementNode = {
				type: "component",
				id: freshId(source.tree),
				component: component.id,
				props: [],
			};
			const written = await writeTarget(tx, place.source, inserted(source.tree, place.path, placement), sources);
			return {
				component,
				placement: { id: placement.id, path: [...place.path] },
				version: written.version,
				sourceChange: {
					kind: place.source.kind === "component" ? "component" : "template",
					id: written.id,
					before: source.tree,
					after: written.tree,
				},
			};
		}),
	);
}

// ---------------------------------------------------------------------------------------------------
// The source

type ReadTarget = {
	tree: ElementTree;
	version: string | null;
	/** A Component source's Props; null for a Template. */
	props: FieldDefinition[] | null;
	/** An Entry template's Post Type. */
	postType: PostType | null;
	kind: ComponentSourceTarget["kind"];
};

async function readTarget(
	scope: SiteScope,
	target: ComponentSourceTarget,
	sources: ComponentSources,
): Promise<ReadTarget> {
	if (target.kind === "component") {
		const found = await componentSource(scope, target.componentId, undefined, sources);
		const draft = found.component.draft;
		return {
			tree: draft.tree,
			version: componentVersion(draft),
			props: found.props,
			postType: null,
			kind: target.kind,
		};
	}
	const template =
		target.kind === "siteTemplate"
			? await getSiteTemplate(scope)
			: target.kind === "searchTemplate"
				? await getSearchTemplate(scope)
				: target.kind === "entryTemplate"
					? await getEntryTemplate(scope, target.postTypeId)
					: await getArchiveTemplate(scope, target.postTypeId);
	const tree = template?.draft ?? { version: 1, nodes: [] };
	return {
		tree,
		version: template ? draftVersion(template.draft) : null,
		props: null,
		postType: target.kind === "entryTemplate" ? await getPostType(scope, target.postTypeId) : null,
		kind: target.kind,
	};
}

/** Saves through the source's usual saver and returns its canonical tree and identity. */
async function writeTarget(
	scope: SiteScope,
	target: ComponentSourceTarget,
	tree: ElementTree,
	sources: ComponentSources,
): Promise<{ id: string; version: string; tree: ElementTree }> {
	if (target.kind === "component") {
		const saved = await saveComponentDraft(scope, target.componentId, { tree }, sources);
		return { id: saved.id, version: componentVersion(saved.draft), tree: saved.draft.tree };
	}
	const saved =
		target.kind === "siteTemplate"
			? await saveSiteTemplate(scope, tree, sources)
			: target.kind === "searchTemplate"
				? await saveSearchTemplate(scope, tree, sources)
				: target.kind === "entryTemplate"
					? await saveEntryTemplate(scope, target.postTypeId, tree, sources)
					: await saveArchiveTemplate(scope, target.postTypeId, tree, sources);
	return { id: saved.id, version: draftVersion(saved.draft), tree: saved.draft };
}

// ---------------------------------------------------------------------------------------------------
// Paths in a tree

/** An outer Loop around the node: what its items are called and what it lists. */
type OuterLoop = { alias: string; source: string };

/** The node at a path, with the Loops around it whose items it reads; undefined when there is none. */
function at(tree: ElementTree, path: TreePath): { node: TreeNode; loops: OuterLoop[] } | undefined {
	let list: readonly TreeNode[] = tree.nodes;
	const loops: OuterLoop[] = [];
	for (let step = 0; step < path.length; step += 2) {
		const node = list[path[step] ?? -1];
		if (!node) return undefined;
		if (step === path.length - 1) return { node, loops };
		const which = path[step + 1] ?? -1;
		if (node.type === "loop" && which === 0) loops.push({ alias: node.alias, source: node.source });
		const next = childListsOf(node)[which];
		if (!next) return undefined;
		list = next;
	}
	return undefined;
}

/** The list of children a path names (the tree's own nodes for an empty one); undefined when none. */
function listAt(tree: ElementTree, owner: TreePath): readonly TreeNode[] | undefined {
	if (owner.length === 0) return tree.nodes;
	const found = at(tree, owner.slice(0, -1));
	return found ? childListsOf(found.node)[owner.at(-1) ?? -1] : undefined;
}

/** The tree with the list a path's node is in changed by `change`. */
function withList(tree: ElementTree, owner: TreePath, change: (list: TreeNode[]) => TreeNode[]): ElementTree {
	const result = structuredClone(tree);
	if (owner.length === 0) {
		result.nodes = change(result.nodes);
		return result;
	}
	const found = at(result, owner.slice(0, -1));
	const list = found ? childListsOf(found.node)[owner.at(-1) ?? -1] : undefined;
	if (!list) throw new DraftChangedError(null);
	const next = change([...list]);
	(list as TreeNode[]).splice(0, list.length, ...next);
	return result;
}

function replaced(tree: ElementTree, path: TreePath, node: TreeNode): ElementTree {
	const index = path.at(-1) ?? 0;
	return withList(tree, path.slice(0, -1), (list) => list.map((each, at) => (at === index ? node : each)));
}

function inserted(tree: ElementTree, path: TreePath, node: TreeNode): ElementTree {
	const index = path.at(-1) ?? 0;
	return withList(tree, path.slice(0, -1), (list) => [...list.slice(0, index), node, ...list.slice(index)]);
}

/** An element id no node of the tree has. */
function freshId(tree: ElementTree): string {
	const ids = new Set<string>();
	const visit = (nodes: readonly TreeNode[]) => {
		for (const node of nodes) {
			if ("id" in node && typeof node.id === "string") ids.add(node.id);
			for (const list of childListsOf(node)) visit(list);
		}
	};
	visit(tree.nodes);
	let id = randomElementId();
	while (ids.has(id)) id = randomElementId();
	return id;
}

// ---------------------------------------------------------------------------------------------------
// Bindings that read where the node was

/** What an outer Loop's items are: Entries of some Post Types, rows with Fields, or unknown. */
type Items =
	| { kind: "entries"; postTypes: readonly PostType[] }
	| { kind: "fields"; fields: readonly FieldDefinition[] };

type ReadingContext = {
	source: ReadTarget;
	/** Every Post Type of the Site. */
	postTypes: readonly PostType[];
	/** The outer Loops' items, by alias (the innermost one last wins). */
	aliases: Map<string, Items | null>;
	/** Whether a Loop is around the node (`loop.index` reads it). */
	inLoop: boolean;
	/** The Site's Loops' names, which a Component reads as they are. */
	siteLoops: ReadonlySet<string>;
};

async function readingContext(scope: SiteScope, source: ReadTarget, loops: OuterLoop[]): Promise<ReadingContext> {
	const postTypes = await listPostTypes(scope);
	const found = await siteLoops(scope, "draft");
	const context: ReadingContext = {
		source,
		postTypes,
		aliases: new Map(),
		inLoop: loops.length > 0,
		siteLoops: new Set(found.keys()),
	};
	for (const loop of loops) {
		let items: Items | null = null;
		if (!loop.source.includes(".") && found.has(loop.source)) {
			const version = found.get(loop.source);
			if (version?.source === "items") items = { kind: "fields", fields: version.fields };
			else if (version)
				items = {
					kind: "entries",
					postTypes: postTypes.filter((postType) => version.query.postTypes.includes(postType.key)),
				};
		} else {
			const field = fieldAt(loop.source, context);
			if (field?.type === "repeater") items = { kind: "fields", fields: field.fields };
			else if (field?.type === "relationship")
				items = { kind: "entries", postTypes: postTypes.filter((postType) => field.postTypes.includes(postType.key)) };
		}
		context.aliases.set(loop.alias, items);
	}
	return context;
}

/** The Field a path names where the node was, when it names one. */
function fieldAt(path: string, context: ReadingContext): FieldDefinition | undefined {
	const [head = "", name = "", ...rest] = path.split(".");
	let field: FieldDefinition | undefined;
	if (context.aliases.has(head)) field = itemField(context.aliases.get(head) ?? null, name);
	else if (head === "props") field = context.source.props?.find((prop) => prop.key === name);
	else {
		field = context.source.postType?.fields.find((each) => each.key === head);
		if (field) rest.unshift(name);
	}
	for (const part of rest) {
		if (!field || !("fields" in field)) return undefined;
		field = field.fields.find((each) => each.key === part);
	}
	return field;
}

function itemField(items: Items | null, name: string): FieldDefinition | undefined {
	if (!items) return undefined;
	if (items.kind === "fields") return items.fields.find((field) => field.key === name);
	for (const postType of items.postTypes) {
		const found = postType.fields.find((field) => field.key === name);
		if (found) return found;
	}
	return undefined;
}

/** A Prop made for a binding: the value it is bound to where it is placed, and its declaration. */
type BindingProp = { root: string; key: string; field: FieldInput };

/** Which Prop a binding's path needs (and what it reads from), or null when the Component reads it as it is. */
function propFor(path: string, context: ReadingContext, local: ReadonlySet<string>): BindingProp | null {
	const segments = path.split(".");
	const [head = "", name = ""] = segments;
	if (local.has(head) || head === "site" || context.siteLoops.has(head)) return null;
	if (head === "loop" && context.inLoop && name) {
		const flag = ["first", "last", "odd", "even"].includes(name);
		return { root: `loop.${name}`, key: `loop${capital(name)}`, field: plain(flag ? "boolean" : "number", name) };
	}
	if (context.aliases.has(head)) {
		if (!name) return { root: head, key: head, field: plain("text", head) };
		const field = itemField(context.aliases.get(head) ?? null, name);
		return {
			root: `${head}.${name}`,
			key: name,
			field: field ? copied(field) : plain(builtInType(name, QUERY_ITEM_BUILT_INS), name),
		};
	}
	if (head === "props" && context.source.props) {
		const field = context.source.props.find((prop) => prop.key === name);
		if (field) return { root: `props.${name}`, key: name, field: copied(field) };
	}
	const field = context.source.postType?.fields.find((each) => each.key === head);
	if (field) return { root: head, key: head, field: copied(field) };
	if ((BUILT_IN_FIELDS as readonly string[]).includes(head))
		return { root: head, key: head, field: plain(builtInType(head, BUILT_IN_FIELDS), head) };
	const last = segments.at(-1) ?? "value";
	return { root: path, key: last, field: plain("text", last) };
}

const DATES = new Set(["createdAt", "updatedAt", "publishedAt", "lastPublishedAt"]);

function builtInType(name: string, known: readonly string[]): FieldInput["type"] {
	return known.includes(name) && DATES.has(name) ? "date" : "text";
}

function capital(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A plain Prop of a type, labelled after its key. */
function plain(type: FieldInput["type"], key: string): FieldInput {
	return { key, label: labelOf(key), type, ...(type === "date" ? { mode: "dateTime" } : {}) };
}

/** A Field's definition as a new Prop's: its settings, without the identities it has where it is. */
function copied(field: FieldDefinition): FieldInput {
	if (field.type === "body") {
		throw new ComponentInvalidError([
			{ at: "path", message: `${field.label} is a Body field, which a Component can't take as a Prop.` },
		]);
	}
	const strip = (each: FieldDefinition): FieldInput => {
		const { id: _, exposed: __, ...rest } = each as FieldDefinition & { id?: string; exposed?: boolean };
		return ("fields" in rest
			? { ...rest, fields: (rest.fields as FieldDefinition[]).map(strip) }
			: rest) as unknown as FieldInput;
	};
	const input = strip(field);
	// A Relationship Prop isn't kept from the other side.
	if (input.type === "relationship") return { ...input, twoWay: false } as FieldInput;
	return input;
}

function labelOf(key: string): string {
	const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ");
	return capital(words.toLowerCase());
}

/** A key for a Prop that no other Prop has, made valid. */
function freeKey(wanted: string, taken: Set<string>): string {
	let stem = wanted.replace(/[^A-Za-z0-9_]/g, "");
	stem = stem.charAt(0).toLowerCase() + stem.slice(1);
	if (!FIELD_KEY.test(stem)) stem = `value${capital(stem)}`.slice(0, 64);
	if (!FIELD_KEY.test(stem)) stem = "value";
	let key = stem;
	for (let count = 2; taken.has(key.toLowerCase()) || RESERVED.has(key.toLowerCase()); count++)
		// `title`, `title_2`, …: as the Field builder numbers a key already taken.
		key = `${stem.slice(0, 60)}_${count}`;
	taken.add(key.toLowerCase());
	return key;
}

const RESERVED = new Set(["and", "or", "not", "true", "false", "now", "contains"]);

/**
 * The node with every binding that read where it was rewritten to read a Prop (`title` becomes
 * `props.title`, parts and all: `category.title` becomes `props.category.title`), the Props made
 * for them, and the Placement's values binding each to what it read before.
 */
function withBindingProps(
	node: TreeNode,
	context: ReadingContext,
): { node: TreeNode; props: FieldInput[]; values: PlacementNode["props"] } {
	const made = new Map<string, BindingProp>();
	const taken = new Set<string>();
	const rename = (path: string, local: ReadonlySet<string>): string => {
		const prop = propFor(path, context, local);
		if (!prop) return path;
		let found = made.get(prop.root);
		if (!found) {
			const key = freeKey(prop.key, taken);
			found = { ...prop, key, field: { ...prop.field, key } };
			made.set(prop.root, found);
		}
		return `props.${found.key}${path.slice(prop.root.length)}`;
	};
	const expression = (each: Expression, local: ReadonlySet<string>): Expression => {
		switch (each.type) {
			case "value":
				return { ...each, path: rename(each.path, local) };
			case "not":
				return { ...each, operand: expression(each.operand, local) };
			case "and":
			case "or":
			case "compare":
				return { ...each, left: expression(each.left, local), right: expression(each.right, local) };
			default:
				return each;
		}
	};
	const visit = (each: TreeNode, local: ReadonlySet<string>): TreeNode => {
		switch (each.type) {
			case "value":
				return { ...each, path: rename(each.path, local) };
			case "element":
				return {
					...each,
					attributes: each.attributes.map((attribute) => ({
						...attribute,
						value: attribute.value.map((part) =>
							part.type === "value" ? { ...part, path: rename(part.path, local) } : part,
						),
					})),
					children: each.children.map((child) => visit(child, local)),
				};
			case "component":
				return {
					...each,
					props: each.props.map((prop) => ({
						...prop,
						value: prop.value.map((part) =>
							part.type === "value" ? { ...part, path: rename(part.path, local) } : part,
						),
						...(prop.binding ? { binding: { ...prop.binding, root: rename(prop.binding.root, local) } } : {}),
					})),
				};
			case "condition":
				return {
					...each,
					branches: each.branches.map((branch) => ({
						test: expression(branch.test, local),
						children: branch.children.map((child) => visit(child, local)),
					})),
					otherwise: each.otherwise ? each.otherwise.map((child) => visit(child, local)) : null,
				};
			case "loop": {
				const source =
					each.source.includes(".") || !context.siteLoops.has(each.source) ? rename(each.source, local) : each.source;
				const inside = new Set([...local, each.alias, "loop"]);
				return {
					...each,
					source,
					children: each.children.map((child) => visit(child, inside)),
					empty: each.empty ? each.empty.map((child) => visit(child, local)) : null,
				};
			}
			default:
				return each;
		}
	};
	const result = visit(node, new Set());
	const props = [...made.values()];
	return {
		node: result,
		props: props.map((prop) => prop.field),
		values: props.map((prop) => ({ name: prop.key, value: [{ type: "value", path: prop.root }] })),
	};
}

/**
 * The node with the chosen pieces of fixed text read from text Props instead, each Prop's default
 * its text; a piece with translations keeps them as the Placement's value.
 */
function withTextProps(
	node: TreeNode,
	chosen: readonly { index: number; key: string }[],
	others: readonly FieldInput[],
): { node: TreeNode; props: FieldInput[]; values: PlacementNode["props"] } {
	if (chosen.length === 0) return { node, props: [], values: [] };
	const problems: ContentProblem[] = [];
	const keys = new Map<number, string>();
	const used = new Set(others.map((prop) => prop.key.toLowerCase()));
	chosen.forEach((choice, at) => {
		if (!FIELD_KEY.test(choice.key) || RESERVED.has(choice.key.toLowerCase())) {
			problems.push({ at: `texts[${at}].key`, message: `${choice.key} can't name a Prop.` });
		} else if (used.has(choice.key.toLowerCase())) {
			problems.push({ at: `texts[${at}].key`, message: `Two Props can't both be called ${choice.key}.` });
		}
		used.add(choice.key.toLowerCase());
		keys.set(choice.index, choice.key);
	});
	const texts = fixedTextsOf(node);
	for (const [index] of keys)
		if (!texts[index]) problems.push({ at: "texts", message: "That piece of text isn't in the selection any more." });
	if (problems.length > 0) throw new ComponentInvalidError(problems);
	const props: FieldInput[] = [];
	const values: PlacementNode["props"] = [];
	let counter = -1;
	const visit = (each: TreeNode): TreeNode[] => {
		if (each.type === "text") {
			if (!hasText(each)) return [each];
			counter++;
			const key = keys.get(counter);
			if (!key) return [each];
			const text = each.text.trim();
			const start = each.text.slice(0, each.text.length - each.text.trimStart().length);
			const end = each.text.slice(each.text.trimEnd().length);
			props.push({ key, label: labelOf(key), type: "text", default: text });
			if (each.translations && Object.keys(each.translations).length > 0) {
				const translations = Object.fromEntries(
					Object.entries(each.translations).map(([language, value]) => [language, value.trim()]),
				);
				values.push({ name: key, value: [{ type: "text", text, translations }] });
			}
			return [
				...(start ? [{ type: "text", text: start } as TextNode] : []),
				{ type: "value", path: `props.${key}` },
				...(end ? [{ type: "text", text: end } as TextNode] : []),
			];
		}
		switch (each.type) {
			case "element":
				return [{ ...each, children: each.children.flatMap(visit) }];
			case "condition":
				return [
					{
						...each,
						branches: each.branches.map((branch) => ({ ...branch, children: branch.children.flatMap(visit) })),
						otherwise: each.otherwise ? each.otherwise.flatMap(visit) : null,
					},
				];
			case "loop":
				return [
					{ ...each, children: each.children.flatMap(visit), empty: each.empty ? each.empty.flatMap(visit) : null },
				];
			default:
				return [each];
		}
	};
	const [result = node] = visit(node);
	return { node: result, props, values };
}
