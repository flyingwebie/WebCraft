import type { ApiClient } from "@webcraft/api";

import type { MessageKey, useT } from "../i18n.tsx";

/** The admin's translator. */
type Translate = ReturnType<typeof useT>;

/**
 * An item's history in the admin (GLOSSARY.md › Revision, Checkpoint): the shapes the history
 * procedures answer, and how the admin names an item, a copy and who made it.
 */

/** One publishable item, as the history procedures take it. */
export type HistoryItem = Parameters<ApiClient["history"]["list"]>[0]["item"];

/** One page of an item's history. */
export type HistoryPage = Awaited<ReturnType<ApiClient["history"]["list"]>>;

/** One Revision or Checkpoint, as history lists it. */
export type HistoryCopy = HistoryPage["copies"][number];

/** A comparison of a copy with the Draft. */
export type Comparison = Awaited<ReturnType<ApiClient["history"]["compare"]>>;

export type ComparedPart = Comparison["parts"][number];

export type Shown = ComparedPart["copy"];

/** Who made a change: a person, how they came in, and the client they came in through. */
export type Attribution = NonNullable<HistoryCopy["by"]>;

/** Names one copy in the History screen's address: `revision:<id>` or `checkpoint:<id>`. */
export function copyParam(copy: Pick<HistoryCopy, "type" | "id">): string {
	return `${copy.type}:${copy.id}`;
}

/** The copy an address names, or null. */
export function readCopyParam(value: string | undefined): { type: "revision" | "checkpoint"; id: string } | null {
	const [type, id] = (value ?? "").split(":");
	return (type === "revision" || type === "checkpoint") && id ? { type, id } : null;
}

/** An item as the History screen's address carries it: its kind, and its id when a Site has many of its kind. */
export function itemSearch(item: HistoryItem): { item: HistoryItem["kind"]; itemId?: string } {
	return "id" in item ? { item: item.kind, itemId: item.id } : { item: item.kind };
}

/** The item an address names, or null when it names none. */
export function readItem(search: { item?: string; itemId?: string }): HistoryItem | null {
	const { item: kind, itemId: id } = search;
	switch (kind) {
		case "globals":
		case "consentBanner":
		case "designSystem":
			return { kind };
		case "entry":
		case "template":
		case "component":
		case "loop":
		case "filter":
		case "script":
		case "form":
		case "formEmails":
			return id ? { kind, id } : null;
		default:
			return null;
	}
}

/** "<person>", "<person> via <client>", AI translation for a person, a Module, or nobody known. */
export function attributionText(t: Translate, by: Attribution | null): string {
	if (!by) return t("history.by.unknown");
	const person = by.person?.name ?? t("history.by.gone");
	if (by.via.kind === "module") return t("history.by.module", { module: by.via.name });
	if (by.via.kind === "translation") return t("history.by.translation", { person });
	if (by.client) return t("history.by.via", { person, client: by.client });
	return person;
}

/** What a copy is, in words: a Revision, or a Checkpoint and why it was saved. */
export function copyKind(t: Translate, copy: Pick<HistoryCopy, "type" | "reason">): string {
	if (copy.type === "revision") return t("history.copy.revision");
	if (copy.reason === "left") return t("history.copy.checkpointLeft");
	if (copy.reason === "restore") return t("history.copy.checkpointRestore");
	return t("history.copy.checkpointActivity");
}

/** How the admin names Templates by kind. */
const TEMPLATE_NAMES: Record<string, MessageKey> = {
	site: "history.item.siteTemplate",
	entry: "history.item.entryTemplate",
	archive: "history.item.archiveTemplate",
	search: "history.item.searchTemplate",
};

/** How the admin names an item that has no name of its own (the Globals, a Template, …). */
export function itemName(t: Translate, item: HistoryPage["item"]): string {
	if (item.name) return item.name;
	switch (item.kind) {
		case "template":
			return t(TEMPLATE_NAMES[item.templateKind ?? "site"] ?? "history.item.siteTemplate", {
				postType: item.postType?.name ?? "",
			});
		case "script":
			return t("history.item.siteScript");
		case "globals":
			return t("history.item.globals");
		case "consentBanner":
			return t("history.item.consentBanner");
		case "designSystem":
			return t("history.item.designSystem");
		default:
			return t("history.item.untitled");
	}
}

/** Names of built-in values and sections, by the item's kind and the part's key (`*` for any kind). */
const PART_LABELS: Record<string, MessageKey> = {
	"entry.title": "history.part.title",
	"entry.slug": "history.part.slug",
	"entry.parent": "history.part.parent",
	"entry.hiddenLanguages": "history.part.hiddenLanguages",
	"entry.seo": "history.part.seo",
	"designSystem.tokens": "history.part.tokens",
	"designSystem.classes": "history.part.classes",
	"designSystem.baseStyles": "history.part.baseStyles",
	"designSystem.customCss": "history.part.customCss",
	"designSystem.darkMode": "history.part.darkMode",
	"component.props": "history.part.props",
	"component.tree": "history.part.markup",
	"template.tree": "history.part.markup",
	"script.code": "history.part.code",
	"loop.source": "history.part.source",
	"loop.query": "history.part.query",
	"loop.fields": "history.part.itemFields",
	"loop.values": "history.part.items",
	"filter.mode": "history.part.mode",
	"filter.label": "history.part.label",
	"filter.applyLabel": "history.part.applyLabel",
	"filter.controls": "history.part.controls",
	"form.fields": "history.part.formFields",
	"form.submitLabel": "history.part.submitLabel",
	"form.success": "history.part.success",
	"form.spam": "history.part.spam",
	"formEmails.notifications": "history.part.notifications",
	"formEmails.autoReply": "history.part.autoReply",
};

/** A part's name: a Field's label, or the admin's name for a built-in value or section (its key otherwise). */
export function partLabel(t: Translate, kind: HistoryItem["kind"], part: Pick<ComparedPart, "key" | "label">): string {
	if (part.label) return part.label;
	const key = PART_LABELS[`${kind}.${part.key}`];
	return key ? t(key) : part.key;
}
