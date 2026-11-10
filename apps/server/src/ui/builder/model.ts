import type { ApiClient } from "@webcraft/api";
import type { FieldInput } from "@webcraft/core";
import {
	type AttributePart,
	type ElementTree,
	parseAttributeText,
	printAttributeText,
	type TreeNode,
	writeExpression,
	writeFormat,
} from "@webcraft/renderer/builder";

import type { useT } from "../i18n.tsx";
import type { ListRef, NodePath } from "./tree.ts";

/** What the builder opens: a Template by kind (and Post Type), or one of the Site's Components. */
export type BuilderTarget =
	| { kind: "siteTemplate" }
	| { kind: "searchTemplate" }
	| { kind: "entryTemplate"; postTypeId: string }
	| { kind: "archiveTemplate"; postTypeId: string }
	| { kind: "component"; componentId: string };

/** What `builder.open` answers. */
export type Opened = Awaited<ReturnType<ApiClient["builder"]["open"]>>;

/** What the builder offers on its Template or Component. */
export type Catalogue = Opened["catalogue"];

/**
 * What the builder edits, all of it saved together to the Draft: the tree, one-off styles not saved
 * yet (canonical CSS declarations by element id), and a Component's Props.
 */
export type BuilderDoc = { tree: ElementTree; styles: Record<string, string>; props: FieldInput[] | null };

/** What is selected: a node, or one of a Condition's or Loop's later lists (its Else, its Empty). */
export type Selection = { kind: "node"; path: NodePath } | { kind: "list"; list: ListRef };

type T = ReturnType<typeof useT>;

/** The address of a target in the builder: `/builder/<site>/entry-template/<post type>`. */
export function targetPath(target: BuilderTarget): string {
	switch (target.kind) {
		case "siteTemplate":
			return "site-template";
		case "searchTemplate":
			return "search-template";
		case "entryTemplate":
			return `entry-template/${target.postTypeId}`;
		case "archiveTemplate":
			return `archive-template/${target.postTypeId}`;
		case "component":
			return `component/${target.componentId}`;
	}
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A target from its address in the builder, or undefined for an address that names none. */
export function targetFromPath(path: string): BuilderTarget | undefined {
	const [kind = "", id = "", ...rest] = path.split("/");
	if (rest.length > 0) return undefined;
	if (kind === "site-template" && !id) return { kind: "siteTemplate" };
	if (kind === "search-template" && !id) return { kind: "searchTemplate" };
	if (!ID.test(id)) return undefined;
	if (kind === "entry-template") return { kind: "entryTemplate", postTypeId: id };
	if (kind === "archive-template") return { kind: "archiveTemplate", postTypeId: id };
	if (kind === "component") return { kind: "component", componentId: id };
	return undefined;
}

/** What the builder calls a Template or Component: "Blog posts · Entry template", "Card". */
export function targetTitle(t: T, opened: Opened, target: BuilderTarget): string {
	switch (target.kind) {
		case "siteTemplate":
			return t("builder.kinds.siteTemplate");
		case "searchTemplate":
			return t("builder.kinds.searchTemplate");
		case "entryTemplate":
			return t("builder.titles.entryTemplate", { postType: opened.postType?.name ?? "" });
		case "archiveTemplate":
			return t("builder.titles.archiveTemplate", { postType: opened.postType?.name ?? "" });
		case "component":
			return opened.component?.name ?? "";
	}
}

/**
 * Text with values in it as an attribute or Prop holds it, as Template markup writes it between an
 * attribute's quotes (`/blog/{{ slug }}`; `\{{` for a literal `{{`, `&amp;` for `&`): the renderer's
 * own printer, so a field shows exactly what reads back (ADR 0017).
 */
export function writeParts(parts: readonly AttributePart[]): string {
	return printAttributeText(parts);
}

/**
 * Text as Staff type it for an attribute or Prop, read into parts by the renderer's own parser:
 * `{{ path }}` and `{{ path | formatter }}` are values, `\{{` a literal `{{`, everything else text.
 * Answers why, in the parser's words, when it can't be read.
 */
export function readParts(text: string): { parts: AttributePart[] } | { problem: string } {
	return parseAttributeText(text);
}

/** A short excerpt of text, on one line. */
export function excerpt(text: string, length = 32): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

/** What the Layers panel calls a node, and a quieter detail beside it. */
export function layerName(
	t: T,
	node: TreeNode,
	catalogue: Catalogue,
): { name: string; detail: string | null; kind: string } {
	switch (node.type) {
		case "element":
			return {
				name: node.label ?? node.tag,
				detail: node.label ? node.tag : classDetail(node.classes, catalogue),
				kind: "element",
			};
		case "text":
			return { name: `“${excerpt(node.text)}”`, detail: t("builder.layers.text"), kind: "text" };
		case "value":
			return {
				name: `{{ ${node.path}${node.format ? ` | ${writeFormat(node.format)}` : ""} }}`,
				detail: t("builder.layers.value"),
				kind: "value",
			};
		case "comment":
			return {
				name: excerpt(node.text) || t("builder.layers.comment"),
				detail: t("builder.layers.comment"),
				kind: "comment",
			};
		case "component":
			return {
				name:
					catalogue.components.find((component) => component.id === node.component)?.name ??
					t("builder.layers.component"),
				detail: t("builder.layers.component"),
				kind: "component",
			};
		case "condition":
			return {
				name: `${t("builder.layers.if")} ${node.branches[0] ? writeExpression(node.branches[0].test) : ""}`,
				detail: t("builder.layers.condition"),
				kind: "command",
			};
		case "loop":
			return {
				name: `${t("builder.layers.loop")} ${node.source}${node.alias === "item" ? "" : ` · ${node.alias}`}`,
				detail: t("builder.layers.command"),
				kind: "command",
			};
		case "form":
			return {
				name: `${t("builder.layers.form")} ${catalogue.forms.find((form) => form.id === node.form)?.key ?? ""}`,
				detail: t("builder.layers.command"),
				kind: "command",
			};
		case "popup":
			return {
				name: `${t("builder.layers.popup")} ${catalogue.popups.find((popup) => popup.id === node.popup)?.key ?? ""}`,
				detail: t("builder.layers.command"),
				kind: "command",
			};
		case "filter": {
			const filter = catalogue.filters.find((each) => each.id === node.filter);
			return {
				name: `${t("builder.layers.filter")} ${filter?.name ?? ""}${node.control ? ` · ${node.control}` : ""}`,
				detail: t("builder.layers.command"),
				kind: "command",
			};
		}
		case "pagination":
			return {
				name: `${t("builder.layers.pagination")} ${node.loop}`,
				detail: t("builder.layers.command"),
				kind: "command",
			};
		default:
			return { name: t(`builder.commands.${node.type}`), detail: t("builder.layers.command"), kind: "command" };
	}
}

/** The first Class names of an element, as a quiet detail beside its tag. */
function classDetail(classIds: readonly string[], catalogue: Catalogue): string | null {
	const names = classIds
		.map(
			(id) =>
				catalogue.classes.find((each) => each.id === id && !each.generated)?.name ??
				catalogue.utilities.find((each) => each.id === id)?.name,
		)
		.filter((name): name is string => Boolean(name));
	return names.length > 0 ? `.${names.slice(0, 2).join(" .")}` : null;
}

/** What a later list of a Condition or Loop is called in the Layers panel: Else if …, Else, Empty. */
export function listName(t: T, owner: TreeNode, list: number): string {
	if (owner.type === "condition") {
		const branch = owner.branches[list];
		return branch ? `${t("builder.layers.elseIf")} ${writeExpression(branch.test)}` : t("builder.layers.else");
	}
	return t("builder.layers.empty");
}
