import type { FieldDefinition, FieldInput } from "@webcraft/core";
import { FIELD_KEY } from "@webcraft/core/field-rules";
import type { ElementNode, TreeNode } from "@webcraft/renderer/builder";

import { type FixedTextLocation, rememberFixedText, resolveFixedText } from "../../builder/fixed-text.ts";
import { isFixedText, type NodePath, replaceAt } from "../../builder/tree.ts";
import { draftsOf, inputsOf, keyFromLabel, newField } from "../../content/field-drafts.ts";
import { type EditRequests, fill, type Words } from "../api.ts";
import type { Structure, StructureSource } from "./selection.ts";

/**
 * Fixed text (BA-33; the visual builder's "Fixed text", ADR 0017): text written into a Template or a
 * Component that clients can't edit. Staff make it a value clients do edit, and the text becomes the
 * binding that reads it:
 *
 * - in a Component, a **Prop** (its default is the text, so every Placement shows the same words until
 *   someone gives another): the Props and the tree change together through the Component's shared
 *   Draft, one Undo step;
 * - in an Entry template, a **Field** of its Post Type (the text its default for new Entries), added at
 *   once, since Post Types have no Draft;
 * - in any other Template (the Site template, an Archive or Search results template), a **Global** (the
 *   text its Draft value), added at once.
 *
 * Or one of those already there, of text or rich text, whose value then shows instead. The text is
 * followed by its element while the question is asked, so a peer's change elsewhere is kept, and text
 * someone changed meanwhile is never replaced (`resolveFixedText`).
 */

export type FixedTextTarget = "prop" | "field" | "global";

/** What a source's fixed text becomes; null when it can't be changed (a Module's Component, a Template not made). */
export function fixedTextTarget(source: StructureSource): FixedTextTarget | null {
	if (!source.editable || !source.id) return null;
	if (source.kind === "component") return "prop";
	return source.target.kind === "entryTemplate" ? "field" : "global";
}

/** The fixed text an element holds itself (not its children's): each piece's path and text. */
export function fixedTextsIn(node: ElementNode, path: NodePath): { path: NodePath; text: string }[] {
	return node.children.flatMap((child, index) =>
		isFixedText(child) ? [{ path: [...path, 0, index], text: child.text }] : [],
	);
}

/** Whether a node holds fixed text itself (Layers flags its row). */
export function holdsFixedText(node: TreeNode): boolean {
	return node.type === "element" && node.children.some(isFixedText);
}

/** A short excerpt of text, on one line. */
export function excerpt(text: string, length = 60): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

/** What the text becomes: a new one, labelled and keyed, or one already there. */
export type FixedTextChoice = { mode: "new"; label: string; key: string } | { mode: "existing"; key: string };

/** A piece of fixed text being made editable: its source and where it is, followed by its element. */
export type FixedTextAsk = { source: string; target: FixedTextTarget; location: FixedTextLocation };

/** Remembers a piece of fixed text to ask about (its element is followed meanwhile). */
export function askAbout(source: StructureSource, path: NodePath): FixedTextAsk | null {
	const target = fixedTextTarget(source);
	const location = rememberFixedText(source.tree, path);
	return target && location ? { source: source.ref, target, location } : null;
}

type Shown = { key: string; label: string; type: string };

/** The binding a key is read by from a target: `props.x`, `x` (a Field), `site.x` (a Global). */
export function bindingOf(target: FixedTextTarget, key: string): string {
	return target === "prop" ? `props.${key}` : target === "global" ? `site.${key}` : key;
}

export function fixedTexts(options: { structure: Structure; request: EditRequests; words: Words }) {
	const { structure, request, words } = options;
	const said = words.fixedText;

	const service = async <T>(method: string, input: unknown): Promise<T> => {
		const answer = await request<T>("code/editorService", { method, input });
		if (answer.ok) return answer.data;
		const problems = (answer.data as { problems?: { message: string }[] } | undefined)?.problems;
		throw new Error(problems?.length ? problems.map((each) => each.message).join(" ") : answer.code);
	};

	const sourceOfAsk = (ask: FixedTextAsk) => structure.snapshot().sources.get(ask.source);

	/** The Post Type's Fields (an Entry template's). */
	const postTypeFields = async (source: StructureSource): Promise<FieldDefinition[]> => {
		if (source.target.kind !== "entryTemplate") return [];
		const { postType } = await service<{ postType: { fields: FieldDefinition[] } }>("postTypes.get", {
			postTypeId: source.target.postTypeId,
		});
		return postType.fields;
	};

	const globalFields = async (): Promise<FieldDefinition[]> =>
		(await service<{ globals: { fields: FieldDefinition[] } }>("globals.get", {})).globals.fields;

	return {
		/** What is there already of text or rich text, to show instead: the Props, the Fields, the Globals. */
		async existing(ask: FixedTextAsk): Promise<{ key: string; label: string }[]> {
			const source = sourceOfAsk(ask);
			if (!source) return [];
			const all: readonly Shown[] =
				ask.target === "prop"
					? ((source.props ?? []) as Shown[])
					: ask.target === "field"
						? ((await postTypeFields(source)) as Shown[])
						: ((await globalFields()) as Shown[]);
			return all
				.filter((field) => field.type === "text" || field.type === "richText")
				.map(({ key, label }) => ({ key, label }));
		},

		/**
		 * Makes the text editable: adds the Prop, Field or Global (a new one) and changes the text into its
		 * binding, one Undo step. Answers why not (the dialog stays open with it), or null once made.
		 */
		async make(ask: FixedTextAsk, choice: FixedTextChoice): Promise<string | null> {
			const source = sourceOfAsk(ask);
			// Text someone changed meanwhile is never replaced, and nothing is added for it.
			if (!source || !resolveFixedText(source.tree, ask.location)) return said.changed;
			let key: string;
			let madeProp: FieldDefinition | null = null;
			if (choice.mode === "existing") {
				if (!choice.key) return said.chooseExisting;
				key = choice.key;
			} else {
				const label = choice.label.trim();
				key = (choice.key || keyFromLabel(label)).trim();
				if (!label) return said.labelRequired;
				if (!FIELD_KEY.test(key)) return said.keyInvalid;
				const made = { ...newField("text", key, label), default: ask.location.text.trim() } as FieldDefinition;
				try {
					if (ask.target === "prop") {
						const current = source.props ?? [];
						if (current.some((prop) => prop.key === key)) return said.keyTaken;
						madeProp = made;
					} else if (ask.target === "global") {
						const fields = await globalFields();
						if (fields.some((field) => field.key === key)) return said.keyTaken;
						// One call: a Global added with a default starts the Globals' Draft with it, and a refusal
						// (text longer than a text Field holds) leaves nothing half made.
						await service("globals.setFields", {
							fields: [...inputsOf(draftsOf(fields)), made as FieldInput],
						});
					} else if (source.target.kind === "entryTemplate") {
						const fields = await postTypeFields(source);
						if (fields.some((field) => field.key === key)) return said.keyTaken;
						await service("postTypes.update", {
							postTypeId: source.target.postTypeId,
							fields: [...inputsOf(draftsOf(fields)), made as FieldInput],
						});
					}
				} catch (error) {
					return fill(said.refused, { reason: error instanceof Error ? error.message : String(error) });
				}
			}
			// The text as the Draft has it now (a peer may have changed the tree while the question was asked).
			const now = sourceOfAsk(ask);
			const path = now ? resolveFixedText(now.tree, ask.location) : undefined;
			if (!now || !path) return said.changed;
			const binding = bindingOf(ask.target, key);
			const next = replaceAt(now.tree, path, { type: "value", path: binding });
			const props = madeProp ? [...(now.props ?? []), madeProp] : undefined;
			if (madeProp && now.props?.some((prop) => prop.key === key)) return said.keyTaken;
			return structure.change(now.ref, next, fill(said.made, { binding: `{{ ${binding} }}` }), undefined, props);
		},
	};
}

export type FixedTexts = ReturnType<typeof fixedTexts>;
