import type { FieldDefinition } from "@webcraft/core";
import { FIELD_KEY } from "@webcraft/core/field-rules";
import type { ElementNode, TreeNode } from "@webcraft/renderer/builder";

import { nodeAt, pathOfId, replaceAt } from "../../builder/tree.ts";
import { keyFromLabel, newField } from "../../content/field-drafts.ts";
import { fill, type Words } from "../api.ts";
import type { Structure, StructureSource } from "./selection.ts";

/**
 * Bind to Prop for a link's address or an image's file in a Component (UI-21; the old editors' #134,
 * after BA-33's for fixed text): the element's `href` or `src` then reads a Prop, so each Placement
 * gives its own. A new Prop of the matching type (a Link Prop, read as `props.x.url`; a Media Prop,
 * read as `props.x`) starts with what the attribute holds now as its default, so nothing changes until
 * a Placement gives another; or a Prop the Component has of that type is chosen. The Prop and the
 * binding change together through the Component's shared Draft: one Undo step takes back both.
 */

/** What an element's setting binds to: a link's address or an image's file. */
export type BindKind = "link" | "media";

/** The setting of an element that can read a Prop: an `a`'s address, an `img`'s file; null for any other. */
export function bindKindOf(node: TreeNode | null): BindKind | null {
	if (node?.type !== "element") return null;
	return node.tag === "a" ? "link" : node.tag === "img" ? "media" : null;
}

/** The attribute a kind of setting is written to. */
export function attributeOf(kind: BindKind): "href" | "src" {
	return kind === "link" ? "href" : "src";
}

/** The binding a Prop of the kind is read with. */
export function bindingPath(kind: BindKind, key: string): string {
	return kind === "link" ? `props.${key}.url` : `props.${key}`;
}

/** What the setting holds now as plain text (empty when it reads a value, or has none). */
export function fixedValueOf(node: ElementNode, kind: BindKind): string {
	const value = node.attributes.find((attribute) => attribute.name === attributeOf(kind))?.value ?? [];
	return value.every((part) => part.type === "text") ? value.map((part) => part.text).join("") : "";
}

/** The Prop's binding the setting reads now, if it reads one alone (`{{ props.x.url }}`). */
export function boundPathOf(node: ElementNode, kind: BindKind): string | null {
	const value = node.attributes.find((attribute) => attribute.name === attributeOf(kind))?.value ?? [];
	const [only] = value;
	return value.length === 1 && only?.type === "value" && only.path.startsWith("props.") ? only.path : null;
}

/** The question asked about one element: its Component, the element (by its id) and the setting. */
export type BindAsk = { source: string; element: string; kind: BindKind; tag: string };

/** What the setting reads: a new Prop, labelled and keyed, or one the Component has. */
export type BindChoice = { mode: "new"; label: string; key: string } | { mode: "existing"; key: string };

/** Asks about an element's setting, when it is a Component's link or image with an id to follow it by. */
export function askToBind(source: StructureSource, node: TreeNode | null): BindAsk | null {
	const kind = bindKindOf(node);
	if (!kind || node?.type !== "element" || !node.id || source.kind !== "component" || !source.editable) return null;
	return { source: source.ref, element: node.id, kind, tag: node.tag };
}

export function propBindings(options: { structure: Structure; words: Words }) {
	const { structure, words } = options;
	const said = words.bindProp;
	const sourceOf = (ask: BindAsk) => structure.snapshot().sources.get(ask.source);

	return {
		/** The Props the Component has of the setting's type, to read instead. */
		existing(ask: BindAsk): { key: string; label: string }[] {
			return (sourceOf(ask)?.props ?? [])
				.filter((prop) => prop.type === ask.kind)
				.map(({ key, label }) => ({ key, label }));
		},

		/**
		 * Makes the setting read the Prop (a new one declared in the same change): one Undo step. Answers
		 * why not (the dialog stays open with it), or null once made.
		 */
		bind(ask: BindAsk, choice: BindChoice): string | null {
			const source = sourceOf(ask);
			// The element as the Draft has it now: a peer may have changed the tree meanwhile.
			const path = source ? pathOfId(source.tree, ask.element) : undefined;
			const element = source && path ? nodeAt(source.tree, path) : undefined;
			if (!source || !path || element?.type !== "element" || bindKindOf(element) !== ask.kind) return said.changed;
			const props = source.props ?? [];
			let key: string;
			let made: FieldDefinition | null = null;
			if (choice.mode === "existing") {
				if (!choice.key) return said.choose;
				key = choice.key;
			} else {
				const label = choice.label.trim();
				key = (choice.key || keyFromLabel(label)).trim();
				if (!label) return words.fixedText.labelRequired;
				if (!FIELD_KEY.test(key)) return words.fixedText.keyInvalid;
				if (props.some((prop) => prop.key.toLowerCase() === key.toLowerCase())) return words.fixedText.keyTaken;
				const fixed = fixedValueOf(element, ask.kind).trim();
				const media = /^media:(.+)$/i.exec(fixed)?.[1];
				const fallback = ask.kind === "link" ? (fixed ? { url: fixed, text: "" } : null) : (media ?? null);
				made = { ...newField(ask.kind, key, label), default: fallback } as FieldDefinition;
			}
			const name = attributeOf(ask.kind);
			const binding = bindingPath(ask.kind, key);
			const value = [{ type: "value" as const, path: binding }];
			const attributes = element.attributes.some((each) => each.name === name)
				? element.attributes.map((each) => (each.name === name ? { name, value } : each))
				: [...element.attributes, { name, value }];
			const next = replaceAt(source.tree, path, { ...element, attributes });
			return structure.change(
				source.ref,
				next,
				fill(said.done, { binding: `{{ ${binding} }}` }),
				undefined,
				made ? [...props, made] : undefined,
			);
		},
	};
}

export type PropBindings = ReturnType<typeof propBindings>;
