import { entries, globals, media } from "@webcraft/db/schema";
import { blockSpec, type ElementTree, printTemplateMarkup, storedBlocks, textFromHtml } from "@webcraft/renderer";
import { inArray } from "drizzle-orm";
import { CONSENT_TEXT_FIELDS } from "../consent/text.ts";
import { type ComponentSources, NO_MODULE_COMPONENTS, siteComponents } from "../content/components.ts";
import type { FieldDefinition, LeafField } from "../content/field-types.ts";
import { storedFields } from "../content/fields.ts";
import { sameJson } from "../content/json.ts";
import { siteLanguages } from "../content/languages.ts";
import { isPagePostType } from "../content/pages.ts";
import { getPostType } from "../content/post-types.ts";
import { readValue, storedVersion } from "../content/values.ts";
import { classCatalogue } from "../design-system/classes.ts";
import { draftDesignSystem } from "../design-system/design-systems.ts";
import { POPUP_FIELDS } from "../popups/index.ts";
import { SEO_GROUP } from "../seo/entry-seo.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type Attribution, attribution, peopleNames } from "./attribution.ts";
import { partChanges } from "./checkpoints.ts";
import { type CopyRef, getCopy, type HistoryCopy } from "./copies.ts";
import { type HistoryItem, type HistoryItemSummary, type ItemState, itemState } from "./items.ts";
import { sectionsOf, VALUE_KINDS } from "./parts.ts";

/**
 * Compare (GLOSSARY.md › Revision): a Revision or Checkpoint next to the item's Draft as it is now,
 * part by part (an Entry's Fields and built-in values, a Structure item's sections), in one language
 * at a time, each part saying whether it differs and who changed it last and when. Values are shown
 * as they read, not as they are stored: text, a choice's label, an Entry's title, a Media file's name;
 * a Body's Blocks one by one; Template markup, CSS and settings as text with the lines that differ.
 */

/** How a value reads, on one side of a comparison. */
export type Shown =
	| { kind: "empty" }
	/** A Translatable value with nothing of its own in this language: it shows the Default language's. */
	| { kind: "fallback" }
	| { kind: "text"; text: string }
	| { kind: "boolean"; value: boolean }
	/** A Group's Fields, each marked when it differs from the other side. */
	| { kind: "fields"; fields: ShownField[] }
	/** A Repeater's rows, each marked against the other side by its id. */
	| { kind: "rows"; rows: { id: string; status: ItemStatus; fields: ShownField[] }[] }
	/** A Body's Blocks, each marked against the other side by its id. */
	| { kind: "blocks"; blocks: { id: string; type: string; text: string; status: ItemStatus }[] }
	/** Template markup, CSS, a script or settings, as text. */
	| { kind: "code"; text: string };

/** One Field inside a Group or a Repeater row. */
export type ShownField = { key: string; label: string; shown: Shown; changed: boolean };

/**
 * How a Block, a row or a line stands against the other side: the same, changed, only on this side
 * of the Revision or Checkpoint (`removed`, since the Draft no longer has it) or only in the Draft
 * (`added`).
 */
export type ItemStatus = "same" | "changed" | "added" | "removed";

/** One part of the item, on both sides. */
export type ComparedPart = {
	/** The stored key: a built-in value (`title`, `slug`, `parent`, `hiddenLanguages`, `seo`), a Field's key, or a section. */
	key: string;
	/** A Field's label; null for built-in values and sections, which the admin names itself. */
	label: string | null;
	/** Kept once for every language (a shared Field, a page's parent, a section of Structure). */
	shared: boolean;
	changed: boolean;
	/** The Revision's or Checkpoint's value. */
	copy: Shown;
	/** The Draft's value. */
	draft: Shown;
	/** For text that spans lines (markup, CSS, settings): every line, marked as the same, removed or added. */
	lines: { status: "same" | "added" | "removed"; text: string }[] | null;
	/** Who last changed the Draft's value and when, when it differs and that is known. */
	changedBy: Attribution | null;
	changedAt: Date | null;
};

/** A comparison, as `history.compare` answers it. */
export type Comparison = {
	item: HistoryItemSummary;
	copy: HistoryCopy;
	/** The Draft: when it was last changed and by whom. */
	draft: { changedAt: Date; by: Attribution | null };
	/**
	 * The language shown, and every language of the Site with how many parts differ in it; null and
	 * empty for items kept once for every language (Structure, a Form's emails).
	 */
	language: string | null;
	languages: { code: string; name: string; changes: number }[];
	parts: ComparedPart[];
	/** How many parts differ in the language shown. */
	changes: number;
};

/** One part to compare: its key, label, definition (for values) and whether it is kept once. */
type PartDefinition = { key: string; label: string | null; field: FieldDefinition | null; shared: boolean };

/** Names of what values point at: Media files and Entries, by id. */
type Lookups = { media: Map<string, string>; entries: Map<string, string> };

/** Reads a value of a Field kept by key and language, or a section, the way a person reads it. */
type Reader = { language: string; defaultLanguage: string; lookups: Lookups };

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function leafDefinition(
	key: string,
	type: string,
	translatable: boolean,
	more: Record<string, unknown> = {},
): FieldDefinition {
	return { key, label: "", type, help: "", required: false, translatable, default: null, ...more } as FieldDefinition;
}

/** The parts of an item kept by key and language, in the order the admin shows them. */
async function valueParts(scope: SiteScope, state: ItemState, versions: unknown[]): Promise<PartDefinition[]> {
	const kind = state.summary.kind;
	let fields: FieldDefinition[] = [];
	const builtIns: PartDefinition[] = [];
	if (kind === "entry" && state.postTypeId) {
		const postType = await getPostType(scope, state.postTypeId);
		fields = postType.fields;
		const site = await siteLanguages(scope);
		builtIns.push(
			{ key: "title", label: null, field: leafDefinition("title", "text", true), shared: false },
			{ key: "slug", label: null, field: leafDefinition("slug", "text", true), shared: false },
		);
		if (isPagePostType(postType)) {
			builtIns.push({
				key: "parent",
				label: null,
				field: leafDefinition("parent", "relationship", false, { multiple: false }),
				shared: true,
			});
		}
		builtIns.push(
			{
				key: "hiddenLanguages",
				label: null,
				field: leafDefinition("hiddenLanguages", "select", false, {
					multiple: true,
					options: site.languages.map((language) => ({ value: language.code, label: language.name })),
				}),
				shared: true,
			},
			{ key: SEO_GROUP.key, label: null, field: SEO_GROUP, shared: false },
		);
	} else if (kind === "globals") {
		fields = storedFields((await scope.first(globals))?.fields);
	} else if (kind === "popupContent") {
		fields = POPUP_FIELDS;
	} else if (kind === "consentBanner") {
		fields = [...CONSENT_TEXT_FIELDS];
	}
	const known = [
		...builtIns,
		...fields.map((field) => ({
			key: field.key,
			label: field.label,
			field,
			shared: field.type !== "group" && field.type !== "repeater" && !field.translatable,
		})),
	];
	// Values stored under keys no Field has now (a Field removed since) are shown as they are.
	const others = [...new Set(versions.flatMap((version) => Object.keys(storedVersion(version).values)))]
		.filter((key) => !known.some((part) => part.key === key))
		.map((key) => ({ key, label: key, field: null, shared: false }));
	return [...known, ...others];
}

/** A leaf Field's own value in the language read (a shared Field's under the Default language). */
function ownValue(node: unknown, field: FieldDefinition, reader: Reader): { value: unknown } | undefined {
	const byLanguage = record(node);
	const own = record(byLanguage[field.translatable ? reader.language : reader.defaultLanguage]);
	return "value" in own ? { value: own.value } : undefined;
}

/** What a value says in the language read, for telling whether two sides differ. */
function projected(node: unknown, field: FieldDefinition | null, reader: Reader): unknown {
	if (!field) return node ?? null;
	if (field.type === "group") {
		const values = record(record(node).values);
		return Object.fromEntries(field.fields.map((child) => [child.key, projected(values[child.key], child, reader)]));
	}
	if (field.type === "repeater") {
		const rows = Array.isArray(record(node).rows) ? (record(node).rows as unknown[]) : [];
		return rows.map((row) => {
			const values = record(record(row).values);
			return {
				id: record(row).id,
				values: Object.fromEntries(
					field.fields.map((child) => [child.key, projected(values[child.key], child, reader)]),
				),
			};
		});
	}
	const own = ownValue(node, field, reader)?.value;
	// An unset true/false reads false, as everywhere else.
	if (field.type === "boolean") return own === true;
	if (field.type === "body" && Array.isArray(own)) {
		return own.map((block) => {
			const { source: _, ...rest } = record(block);
			return rest;
		});
	}
	return own ?? null;
}

/** How a leaf value reads. */
function leafShown(value: unknown, field: LeafField, lookups: Lookups): Shown {
	if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
		return { kind: "empty" };
	}
	switch (field.type) {
		case "boolean":
			return { kind: "boolean", value: value === true };
		case "richText":
			return { kind: "text", text: typeof value === "string" ? textFromHtml(value) : "" };
		case "select": {
			const labels = (Array.isArray(value) ? value : [value]).map(
				(choice) => field.options.find((option) => option.value === choice)?.label ?? String(choice),
			);
			return { kind: "text", text: labels.join(", ") };
		}
		case "media":
			return { kind: "text", text: lookups.media.get(String(value)) ?? String(value) };
		case "relationship": {
			const titles = (Array.isArray(value) ? value : [value]).map(
				(id) => lookups.entries.get(String(id)) ?? String(id),
			);
			return { kind: "text", text: titles.join(", ") };
		}
		case "link": {
			const link = record(value);
			const text = typeof link.text === "string" ? link.text : "";
			const url = typeof link.url === "string" ? link.url : "";
			return { kind: "text", text: text && url ? `${text} (${url})` : text || url };
		}
		case "body":
			return { kind: "blocks", blocks: blocksOf(value).map((block) => ({ ...block, status: "same" })) };
		default:
			return { kind: "text", text: typeof value === "string" ? value : JSON.stringify(value) };
	}
}

/** A Body's Blocks as they read: their type and plain text. */
function blocksOf(value: unknown): { id: string; type: string; text: string }[] {
	return storedBlocks(value).map((block) => {
		let text = "";
		try {
			text = blockSpec(block).texts(block).join(" ").trim();
		} catch {
			// A Block of a type this build doesn't know reads as nothing.
		}
		return { id: block.id, type: block.type, text };
	});
}

/** How a value reads in the language read. */
function shownOf(node: unknown, field: FieldDefinition | null, reader: Reader): Shown {
	if (!field) return node === undefined || node === null ? { kind: "empty" } : { kind: "code", text: pretty(node) };
	if (field.type === "group") {
		const values = record(record(node).values);
		return {
			kind: "fields",
			fields: field.fields.map((child) => ({
				key: child.key,
				label: child.label,
				shown: shownOf(values[child.key], child, reader),
				changed: false,
			})),
		};
	}
	if (field.type === "repeater") {
		const rows = Array.isArray(record(node).rows) ? (record(node).rows as unknown[]) : [];
		return {
			kind: "rows",
			rows: rows.map((row) => {
				const values = record(record(row).values);
				return {
					id: String(record(row).id ?? ""),
					status: "same" as ItemStatus,
					fields: field.fields.map((child) => ({
						key: child.key,
						label: child.label,
						shown: shownOf(values[child.key], child, reader),
						changed: false,
					})),
				};
			}),
		};
	}
	const own = ownValue(node, field, reader);
	if (!own && field.type === "boolean") return { kind: "boolean", value: false };
	if (!own) {
		const inDefault = ownValue(node, field, { ...reader, language: reader.defaultLanguage });
		return field.translatable && reader.language !== reader.defaultLanguage && inDefault
			? { kind: "fallback" }
			: { kind: "empty" };
	}
	return leafShown(own.value, field, reader.lookups);
}

/** Marks what differs inside two sides of a Group, Repeater or Body, each against the other. */
function markInside(copy: Shown, draft: Shown): void {
	if (copy.kind === "fields" && draft.kind === "fields") {
		for (const field of draft.fields) {
			const other = copy.fields.find((candidate) => candidate.key === field.key);
			field.changed = !sameJson(field.shown, other?.shown ?? null);
			if (other) other.changed = field.changed;
		}
	} else if (copy.kind === "rows" && draft.kind === "rows") {
		for (const row of draft.rows) {
			const other = copy.rows.find((candidate) => candidate.id === row.id);
			if (!other) {
				row.status = "added";
				continue;
			}
			for (const field of row.fields) {
				const twin = other.fields.find((candidate) => candidate.key === field.key);
				field.changed = !sameJson(field.shown, twin?.shown ?? null);
				if (twin) twin.changed = field.changed;
			}
			row.status = row.fields.some((field) => field.changed) ? "changed" : "same";
			other.status = row.status;
		}
		for (const row of copy.rows) if (!draft.rows.some((candidate) => candidate.id === row.id)) row.status = "removed";
	} else if (copy.kind === "blocks" && draft.kind === "blocks") {
		for (const block of draft.blocks) {
			const other = copy.blocks.find((candidate) => candidate.id === block.id);
			block.status = !other ? "added" : other.type === block.type && other.text === block.text ? "same" : "changed";
			if (other) other.status = block.status;
		}
		for (const block of copy.blocks) {
			if (!draft.blocks.some((candidate) => candidate.id === block.id)) block.status = "removed";
		}
	}
}

/** The ids of Media files and Entries a version's values point at, through Groups and Repeaters. */
function pointedAt(node: unknown, field: FieldDefinition | null, found: { media: Set<string>; entries: Set<string> }) {
	if (!field) return;
	if (field.type === "group") {
		const values = record(record(node).values);
		for (const child of field.fields) pointedAt(values[child.key], child, found);
		return;
	}
	if (field.type === "repeater") {
		const rows = Array.isArray(record(node).rows) ? (record(node).rows as unknown[]) : [];
		for (const row of rows) {
			const values = record(record(row).values);
			for (const child of field.fields) pointedAt(values[child.key], child, found);
		}
		return;
	}
	if (field.type !== "media" && field.type !== "relationship") return;
	for (const stored of Object.values(record(node))) {
		const value = record(stored).value;
		for (const id of Array.isArray(value) ? value : [value]) {
			if (typeof id === "string") (field.type === "media" ? found.media : found.entries).add(id);
		}
	}
}

async function lookupsFor(
	scope: SiteScope,
	parts: readonly PartDefinition[],
	versions: readonly unknown[],
	defaultLanguage: string,
): Promise<Lookups> {
	const found = { media: new Set<string>(), entries: new Set<string>() };
	for (const version of versions) {
		const values = storedVersion(version).values;
		for (const part of parts) pointedAt(values[part.key], part.field, found);
	}
	const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
	const mediaIds = [...found.media].filter(isId);
	const entryIds = [...found.entries].filter(isId);
	const mediaRows = mediaIds.length > 0 ? await scope.select(media, inArray(media.id, mediaIds)) : [];
	const entryRows = entryIds.length > 0 ? await scope.select(entries, inArray(entries.id, entryIds)) : [];
	return {
		media: new Map(mediaRows.map((row) => [row.id, row.fileName])),
		entries: new Map(
			entryRows.map((row) => [
				row.id,
				readValue(storedVersion(row.draft), { key: "title", language: defaultLanguage, defaultLanguage }) ?? "",
			]),
		),
	};
}

/** A value as indented JSON, for settings shown as text. */
function pretty(value: unknown): string {
	return JSON.stringify(value ?? null, null, 2);
}

/** How a Structure item's section reads: Template markup for element trees, CSS and code as they are, the rest as JSON. */
function sectionText(
	kind: HistoryItem["kind"],
	key: string,
	value: unknown,
	names: Parameters<typeof printTemplateMarkup>[1],
): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	if ((kind === "template" && key === "tree") || (kind === "component" && key === "tree")) {
		try {
			// Element ids keep the builder's place in a tree; people reading markup don't need them.
			return printTemplateMarkup(value as ElementTree, names).replace(/ data-wc-id="[^"]*"/g, "");
		} catch {
			return pretty(value);
		}
	}
	return pretty(value);
}

/**
 * The lines of two texts, each marked as the same on both sides, only in the first (`removed`) or
 * only in the second (`added`), in order. Long texts are compared line by line after their common
 * start and end; past `LINE_DIFF_CELLS`, the middle is shown as removed then added.
 */
export function lineDiff(before: string, after: string): { status: "same" | "added" | "removed"; text: string }[] {
	const a = before.split("\n");
	const b = after.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let end = 0;
	while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	const head = a.slice(0, start).map((text) => ({ status: "same" as const, text }));
	const tail = a.slice(a.length - end).map((text) => ({ status: "same" as const, text }));
	const x = a.slice(start, a.length - end);
	const y = b.slice(start, b.length - end);
	const middle: { status: "same" | "added" | "removed"; text: string }[] = [];
	if (x.length * y.length > LINE_DIFF_CELLS) {
		middle.push(...x.map((text) => ({ status: "removed" as const, text })));
		middle.push(...y.map((text) => ({ status: "added" as const, text })));
	} else {
		// The longest common subsequence, walked from the start: `length(i, j)` is how many lines of
		// x[i…] and y[j…] it keeps.
		const width = y.length + 1;
		const table = new Uint32Array((x.length + 1) * width);
		const length = (i: number, j: number) => table[i * width + j] ?? 0;
		for (let i = x.length - 1; i >= 0; i--) {
			for (let j = y.length - 1; j >= 0; j--) {
				table[i * width + j] = x[i] === y[j] ? length(i + 1, j + 1) + 1 : Math.max(length(i + 1, j), length(i, j + 1));
			}
		}
		let i = 0;
		let j = 0;
		while (i < x.length && j < y.length) {
			if (x[i] === y[j]) {
				middle.push({ status: "same", text: x[i] as string });
				i++;
				j++;
			} else if (length(i + 1, j) >= length(i, j + 1)) {
				middle.push({ status: "removed", text: x[i] as string });
				i++;
			} else {
				middle.push({ status: "added", text: y[j] as string });
				j++;
			}
		}
		while (i < x.length) middle.push({ status: "removed", text: x[i++] as string });
		while (j < y.length) middle.push({ status: "added", text: y[j++] as string });
	}
	return [...head, ...middle, ...tail];
}

/** The most cells the line comparison works through (lines before × lines after) before it gives up on detail. */
const LINE_DIFF_CELLS = 4_000_000;

/**
 * Compares a Revision or Checkpoint of an item with its Draft (open the Site with
 * `historyReadPermission(item)`), in `language` (the Site's Default language unless given) for items
 * kept by language.
 */
export async function compareWithDraft(
	scope: SiteScope,
	item: HistoryItem,
	ref: CopyRef,
	options: { language?: string; sources?: ComponentSources } = {},
): Promise<Comparison> {
	const state = await itemState(scope, item);
	const copy = await getCopy(scope, item, ref);
	const changes = await partChanges(scope, item);
	const names = await peopleNames(scope.db, [
		state.changedBy,
		...[...changes.values()].map((change) => change.personId),
	]);
	const who = (part: string, language: string | null) => {
		const change = changes.get(`${part}\u0000${language ?? ""}`);
		return change ? { by: attribution(change.personId, change.via, names), at: change.changedAt } : null;
	};
	const { content: _, ...copySummary } = copy;
	const draftBy = state.changedBy ? attribution(state.changedBy, { kind: "admin" }, names) : null;
	const base = {
		item: state.summary,
		copy: copySummary,
		draft: { changedAt: state.changedAt, by: newestChangeBy(changes, names) ?? draftBy },
	};

	if (!VALUE_KINDS.includes(item.kind)) {
		const before = sectionsOf(item.kind, copy.content);
		const after = sectionsOf(item.kind, state.draft);
		const catalogue =
			item.kind === "template" || item.kind === "component"
				? await markupNames(scope, options.sources ?? NO_MODULE_COMPONENTS)
				: {};
		const parts = [...new Set([...before.keys(), ...after.keys()])].map((key): ComparedPart => {
			const was = sectionText(item.kind, key, before.get(key), catalogue);
			const now = sectionText(item.kind, key, after.get(key), catalogue);
			const changed = !sameJson(before.get(key) ?? null, after.get(key) ?? null);
			const last = changed ? who(key, null) : null;
			return {
				key,
				label: null,
				shared: true,
				changed,
				copy: was === null ? { kind: "empty" } : { kind: "code", text: was },
				draft: now === null ? { kind: "empty" } : { kind: "code", text: now },
				lines: changed && was !== null && now !== null ? lineDiff(was, now) : null,
				changedBy: last?.by ?? null,
				changedAt: last?.at ?? null,
			};
		});
		return { ...base, language: null, languages: [], parts, changes: parts.filter((part) => part.changed).length };
	}

	const site = await siteLanguages(scope);
	const { defaultLanguage } = site;
	const language = site.languages.find((candidate) => candidate.code === options.language)?.code ?? defaultLanguage;
	const definitions = await valueParts(scope, state, [copy.content, state.draft]);
	const lookups = await lookupsFor(scope, definitions, [copy.content, state.draft], defaultLanguage);
	const before = storedVersion(copy.content).values;
	const after = storedVersion(state.draft).values;
	const differs = (part: PartDefinition, reader: Reader) =>
		!sameJson(projected(before[part.key], part.field, reader), projected(after[part.key], part.field, reader));
	const languages = site.languages.map((candidate) => {
		const reader = { language: candidate.code, defaultLanguage, lookups };
		return {
			code: candidate.code,
			name: candidate.name,
			changes: definitions.filter((part) => differs(part, reader)).length,
		};
	});
	const reader: Reader = { language, defaultLanguage, lookups };
	const parts = definitions.map((part): ComparedPart => {
		const changed = differs(part, reader);
		const was = shownOf(before[part.key], part.field, reader);
		const now = shownOf(after[part.key], part.field, reader);
		if (changed) markInside(was, now);
		const leaf = part.field && part.field.type !== "group" && part.field.type !== "repeater";
		const last = !changed
			? null
			: part.shared
				? who(part.key, defaultLanguage)
				: leaf
					? who(part.key, language)
					: newest(who(part.key, language), who(part.key, defaultLanguage));
		return {
			key: part.key,
			label: part.label,
			shared: part.shared,
			changed,
			copy: was,
			draft: now,
			lines: null,
			changedBy: last?.by ?? null,
			changedAt: last?.at ?? null,
		};
	});
	return {
		...base,
		language,
		languages,
		parts,
		changes: parts.filter((part) => part.changed).length,
	};
}

function newest<T extends { at: Date }>(a: T | null, b: T | null): T | null {
	if (!a) return b;
	if (!b) return a;
	return a.at.getTime() >= b.at.getTime() ? a : b;
}

/** Who made the newest recorded change to the Draft. */
function newestChangeBy(
	changes: Map<string, { personId: string | null; via: Attribution["via"]; changedAt: Date }>,
	names: ReadonlyMap<string, string>,
): Attribution | null {
	let found: { personId: string | null; via: Attribution["via"]; changedAt: Date } | null = null;
	for (const change of changes.values()) {
		if (!found || change.changedAt.getTime() > found.changedAt.getTime()) found = change;
	}
	return found ? attribution(found.personId, found.via, names) : null;
}

/** How Template markup names what trees point at by id: the Draft's Classes, the Site's Components, Forms and Filters. */
async function markupNames(scope: SiteScope, sources: ComponentSources) {
	const catalogue = classCatalogue(await draftDesignSystem(scope));
	const components = await siteComponents(scope, "draft", sources);
	return {
		className: catalogue.nameOf,
		componentName: components.nameOf,
		formKey: components.forms.keyOf,
		popupKey: components.popups.keyOf,
		filterName: components.filters.nameOf,
	};
}
