import type { TreeNode } from "@webcraft/renderer/builder";

import {
	canUnwrap,
	insertAt,
	newElement,
	nodeAt,
	placeBy,
	removeAt,
	unwrapAt,
	withNewIds,
	wrapAt,
} from "../../builder/tree.ts";
import { fill, type Words } from "../api.ts";
import { managementApi } from "../management.ts";
import { anchorName, keyAt } from "./insert.ts";
import type { PageLayoutEditor } from "./page-layout.ts";
import { type Structure, type StructureSelection, sourceOf } from "./selection.ts";

/**
 * What the tree row's menu and the Command menu's Actions do to what is selected (BA-10, `docking/07`'s
 * row menu): Copy, Paste, Duplicate, Wrap in, Unwrap, Select parent, Make Component and Delete. An
 * element of a Template or Component changes through its shared Draft (`structure.change`, one Undo
 * step each); a Page's Placement through the Page's (`PageLayoutEditor`). Copy keeps the node for the
 * tab; Paste puts a copy after the selection.
 */

/** Make Component's fixed text turned into Props: each piece's `fixedTextsOf` index and its Prop's key. */
export type MadeTexts = { index: number; key: string }[];

/** What can wrap an element without a question: a Div, a Section, a Link. */
export type PlainWrap = "div" | "section" | "a";

export type LayerOps = {
	/** Whether something with a tree is selected (an element, a Loop, a Condition, a Placement in a Template). */
	inTree(): boolean;
	/** Whether a Page's Placement is selected. */
	onPage(): boolean;
	/** Whether something was copied in this tab. */
	copied(): boolean;
	copy(): string | null;
	paste(): string | null;
	duplicate(): string | null;
	remove(): string | null;
	/** Wraps the selection in a Div, a Section or a Link, or in a node a question made (a Loop, a Condition). */
	wrap(wrapper: PlainWrap | TreeNode, what: string): string | null;
	/** Whether the selection holds anything to unwrap without losing a branch or an empty state. */
	canUnwrap(): boolean;
	unwrap(): string | null;
	parent(): string | null;
	/**
	 * Make Component: moves the selected element or Placement into a new Component named `name`, placed
	 * where it was (`components.make`; the page looks the same), its fixed text chosen made Props (each
	 * the Prop's default). Answers why not, or null.
	 */
	makeComponent(name: string, texts?: MadeTexts): Promise<string | null>;
};

export function layerOps(options: {
	token: string;
	siteId: string;
	words: Words;
	structure: Structure;
	layout: PageLayoutEditor;
	announce(text: string, urgent?: boolean): void;
}): LayerOps {
	const { words, structure, layout, announce } = options;
	const said = words.rowMenu;
	let clipboard: TreeNode | null = null;

	const refuse = (reason: string) => {
		announce(reason, true);
		return reason;
	};

	/** The selection with its tree, when it is in one. */
	const inTree = ():
		| (StructureSelection & { path: NonNullable<StructureSelection["path"]>; node: TreeNode })
		| null => {
		const selection = structure.snapshot().selection;
		return selection?.path && selection.node ? (selection as never) : null;
	};
	const placementId = (): string | null => {
		const selection = structure.snapshot().selection;
		if (!selection || selection.key) return null;
		const id = /^content\/([^/#]+)$/.exec(selection.ref)?.[1];
		return id && structure.snapshot().layout?.some((each) => each.id === id) ? id : null;
	};
	const nameNow = () => {
		const selection = structure.snapshot().selection;
		return selection ? anchorName(structure.snapshot(), selection.ref) : "";
	};
	const sourceOfSelection = () => {
		const selected = inTree();
		return selected ? structure.snapshot().sources.get(selected.source) : undefined;
	};
	const change = (next: Parameters<Structure["change"]>[1], label: string, select?: string | null) => {
		const selected = inTree();
		if (!selected) return refuse(words.insert.refusals.connecting);
		const refused = structure.change(selected.source, next, label, select);
		return refused ? refuse(refused) : null;
	};

	return {
		inTree: () => inTree() !== null,
		onPage: () => placementId() !== null,
		copied: () => clipboard !== null,
		copy() {
			const selected = inTree();
			if (!selected) return refuse(said.nothingToPaste);
			clipboard = structuredClone(selected.node);
			announce(fill(said.copied, { name: nameNow() }));
			return null;
		},
		paste() {
			const selected = inTree();
			const source = sourceOfSelection();
			if (!clipboard) return refuse(said.nothingToPaste);
			if (!selected || !source) return refuse(fill(said.notHere, { name: "" }));
			const copies = withNewIds(source.tree, [clipboard]);
			const made = insertAt(source.tree, placeBy(source.tree, selected.path, "after"), copies);
			const name = anchorName(structure.snapshot(), selected.ref);
			const key = keyAt(made.tree, made.path);
			return change(made.tree, fill(said.steps.paste, { name }), key);
		},
		duplicate() {
			const id = placementId();
			if (id) {
				const made = layout.duplicate(structure.snapshot().layout ?? [], id);
				if ("refused" in made) return refuse(made.refused);
				structure.select(`content/${made.id}`);
				return null;
			}
			const selected = inTree();
			const source = sourceOfSelection();
			if (!selected || !source) return refuse(words.insert.refusals.connecting);
			const copies = withNewIds(source.tree, [selected.node]);
			const made = insertAt(source.tree, placeBy(source.tree, selected.path, "after"), copies);
			return change(made.tree, fill(words.structure.steps.duplicate, { name: nameNow() }), keyAt(made.tree, made.path));
		},
		remove() {
			const id = placementId();
			if (id) {
				const refused = layout.remove(structure.snapshot().layout ?? [], id);
				if (refused) return refuse(refused);
				structure.select(null);
				return null;
			}
			const selected = inTree();
			const source = sourceOfSelection();
			if (!selected || !source) return refuse(words.insert.refusals.connecting);
			return change(
				removeAt(source.tree, selected.path),
				fill(words.structure.steps.delete, { name: nameNow() }),
				null,
			);
		},
		wrap(wrapper, what) {
			const selected = inTree();
			const source = sourceOfSelection();
			if (!selected || !source) return refuse(words.insert.refusals.connecting);
			const node = typeof wrapper === "string" ? newElement(source.tree, wrapper) : wrapper;
			const made = wrapAt(source.tree, selected.path, withNewIds(source.tree, [node])[0] ?? node);
			if ("refused" in made) return refuse(made.refused);
			return change(made.tree, fill(said.steps.wrap, { name: nameNow(), what }), keyAt(made.tree, made.path));
		},
		canUnwrap() {
			const selected = inTree();
			return selected ? canUnwrap(selected.node) : false;
		},
		unwrap() {
			const selected = inTree();
			const source = sourceOfSelection();
			if (!selected || !source) return refuse(words.insert.refusals.connecting);
			const name = nameNow();
			const made = unwrapAt(source.tree, selected.path);
			if ("refused" in made) return refuse(fill(said.unwrapRefused, { name }));
			return change(made.tree, fill(said.steps.unwrap, { name }), keyAt(made.tree, made.path));
		},
		parent() {
			const selection = structure.snapshot().selection;
			const selected = inTree();
			if (!selection) return refuse(fill(said.parentNone, { name: "" }));
			// The top of a Component's tree: its Placement is the parent (on a Page, its Page layout's).
			if (!selected || selected.path.length === 1) {
				const source = sourceOf(selection.ref);
				const at = source.lastIndexOf("/");
				if (selected && at >= 0) {
					const placed = source.slice(0, at);
					const id = source.slice(at + 1);
					const snapshot = structure.snapshot();
					// A Page's Placement (`content/<id>`), or the Placement node in the Template around it.
					if (snapshot.layout?.some((each) => `content/${each.id}` === source) && !snapshot.inPlace)
						structure.select(source);
					else if (!snapshot.inPlace) structure.select(`${placed}#${id}`);
					else return refuse(fill(said.parentNone, { name: nameNow() }));
					return null;
				}
				return refuse(fill(said.parentNone, { name: nameNow() }));
			}
			const source = structure.snapshot().sources.get(selected.source);
			const owner = selected.path.slice(0, -2);
			const key = source ? keyAt(source.tree, owner) : null;
			if (!key || !source || !nodeAt(source.tree, owner)) return refuse(fill(said.parentNone, { name: nameNow() }));
			structure.select(`${selected.source}#${key}`);
			return null;
		},
		async makeComponent(name, texts = []) {
			const said = words.componentDialog;
			const selected = inTree();
			const source = sourceOfSelection();
			if (!selected || !source?.editable) return refuse(fill(said.refused, { reason: words.insert.refusals.nothing }));
			try {
				const made = await managementApi(options.token).components.make({
					siteId: options.siteId,
					name,
					source: source.target as never,
					path: [...selected.path],
					node: selected.node,
					...(texts.length ? { texts } : {}),
				});
				announce(fill(said.made, { name }));
				structure.select(`${selected.source}#${made.placement.id}`);
				return null;
			} catch (error) {
				return refuse(fill(said.refused, { reason: error instanceof Error ? error.message : String(error) }));
			}
		},
	};
}

/** Whether a Component name can be used: a capital first, then letters and digits, with a small letter. */
export function componentNameProblem(name: string, taken: readonly string[], words: Words): string | null {
	const said = words.componentDialog;
	if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(name) || !/[a-z]/.test(name)) return said.badName;
	if (taken.includes(name)) return fill(said.taken, { name });
	return null;
}
