/**
 * One item of a Module's source as an Entry item for the pipeline: each mapped key's value read for
 * where it goes, the way the CSV source reads a cell (through each Field type's reading of text), with
 * what HTML adds:
 *
 * - into a **Body field**, HTML becomes core Blocks (`blocksFromHtml`); what no Block type matches
 *   stays where it stood as a plain paragraph and is an **Import leftover**; each image becomes an
 *   image Block whose file is fetched into the Media library (through the guarded fetcher, once per
 *   address per Import) and which then points at it;
 * - into **rich text**, HTML is cleaned as rich text always is (the Field type does it); a shortcode
 *   in it is an Import leftover;
 * - into **text** and every other Field, HTML is its plain text.
 *
 * A source's slug is kept when it is one (`-2`, `-3`… when another Entry has it), else made from its
 * title. Values a Field can't take are problems at their key, left out.
 */
import type { SourceEntry, SourceFileRef, SourceValue } from "@webcraft/module-sdk";
import { blocksFromHtml, shortcodeIn, textFromHtml } from "@webcraft/renderer/body";
import { ENTRY_TITLE_MAX_LENGTH } from "../content/field-rules.ts";
import type { Json, LeafField } from "../content/field-types.ts";
import { slugify } from "../content/slugs.ts";
import { ENTRY_SLUG, ENTRY_SLUG_MAX_LENGTH } from "../content/url-patterns.ts";
import { readFieldText, setAt } from "./csv-source.ts";
import type { EntryItem, ItemProblem } from "./items.ts";
import type { EntryTypeTarget, KeyTarget } from "./source-settings.ts";

/** An Import leftover found while reading an item: the key it was in and its Block (null in rich text). */
export type FoundLeftover = { key: string; blockId: string | null; text: string; markup: string };

/** A source's item read for the pipeline. */
export type ConvertedEntry = {
	item: EntryItem;
	target: EntryTypeTarget;
	leftovers: FoundLeftover[];
	/** The files it would fetch, by address. */
	files: string[];
	/** Image Blocks waiting for their files: the Block, the key it is in and the address. */
	images: { key: string; blockId: string; address: string }[];
	/** Its keys that go nowhere. */
	skippedKeys: string[];
	/** The Source id of its parent, for a Page. */
	parent: string | null;
	/** Where it was on the old site, for a Redirect rule. */
	path: string | null;
};

/** Reads one of a source's items for where its type goes. */
export function convertEntry(source: SourceEntry, position: number, target: EntryTypeTarget): ConvertedEntry {
	const problems: ItemProblem[] = [];
	const item: EntryItem = {
		position,
		sourceId: source.sourceId,
		match: null,
		values: { fields: {} },
		finds: [],
		problems,
		destination: target.destination,
	};
	const converted: ConvertedEntry = {
		item,
		target,
		leftovers: [],
		files: [],
		images: [],
		skippedKeys: [],
		parent: source.parent,
		path: source.path,
	};
	const values: [string, SourceValue | { kind: "title" | "slug"; text: string }][] = [
		["title", { kind: "title", text: source.title }],
		...(source.slug
			? [["slug", { kind: "slug" as const, text: source.slug }] as [string, { kind: "slug"; text: string }]]
			: []),
		...Object.entries(source.values),
	];
	for (const [key, value] of values) {
		const target = converted.target.keys.get(key);
		if (!target) {
			converted.skippedKeys.push(key);
			continue;
		}
		readValue(converted, source, key, value, target);
	}
	return converted;
}

function readValue(
	converted: ConvertedEntry,
	source: SourceEntry,
	key: string,
	value: SourceValue | { kind: "title" | "slug"; text: string },
	target: KeyTarget,
): void {
	const { item } = converted;
	const problem = (rule: string, params?: Record<string, string | number>): void => {
		item.problems.push({ column: key, rule, ...(params ? { params } : {}) });
	};
	const text = textOf(value);
	if (target.kind === "title") {
		const title = (text ?? "").replace(/\s+/g, " ").trim();
		if (title.length > ENTRY_TITLE_MAX_LENGTH) problem("tooLong", { max: ENTRY_TITLE_MAX_LENGTH });
		else if (title !== "") item.values.title = title;
		return;
	}
	if (target.kind === "slug") {
		const slug = slugOf(text ?? "");
		if (slug) {
			item.values.slug = slug;
			item.freeSlug = { from: slug };
		}
		return;
	}
	if (target.kind === "seo") {
		item.values.seo = item.values.seo ?? {};
		const seo = item.values.seo;
		if (target.part === "image") {
			const file = fileOf(value, source);
			if (!file) {
				problem("mediaAddress");
				return;
			}
			want(converted, file);
			item.finds.push({
				column: key,
				path: [],
				field: IMAGE_FIELD,
				reading: { file: file.address, ref: file },
				apply: (found) => {
					seo.image = found as string;
				},
			});
			return;
		}
		const plain = (text ?? "").replace(/\s+/g, " ").trim();
		if (plain === "") return;
		if (target.part === "noindex") {
			const read = readFieldText(plain, NOINDEX_FIELD);
			if ("value" in read) seo.noindex = read.value === true;
			else if (/noindex/i.test(plain)) seo.noindex = true;
			return;
		}
		seo[target.part] = plain;
		return;
	}
	const field = target.field;
	switch (field.type) {
		case "body": {
			const html = value.kind === "html" ? value.html : escapeHtml(text ?? "");
			const body = blocksFromHtml(html);
			for (const leftover of body.leftovers) {
				converted.leftovers.push({ key, blockId: leftover.blockId, text: leftover.text, markup: leftover.markup });
			}
			const blocks = body.blocks as unknown as Record<string, unknown>[];
			for (const image of body.images) {
				const file = source.files?.[image.address] ?? { address: image.address };
				const ref: SourceFileRef = {
					...file,
					...(image.alt && !file.alt ? { alt: image.alt } : {}),
					...(image.caption && !file.caption ? { caption: image.caption } : {}),
				};
				want(converted, ref);
				converted.images.push({ key, blockId: image.blockId, address: ref.address });
				item.finds.push({
					column: key,
					path: [field.key],
					field,
					reading: { file: ref.address, ref },
					apply: (found) => {
						const block = blocks.find((each) => each.id === image.blockId);
						if (block) block.media = found;
					},
				});
			}
			if (blocks.length > 0) item.values.fields[field.key] = blocks;
			return;
		}
		case "richText": {
			const html = value.kind === "html" ? value.html : escapeHtml(text ?? "");
			const shortcode = shortcodeIn(textFromHtml(html));
			if (shortcode) converted.leftovers.push({ key, blockId: null, text: shortcode, markup: shortcode });
			if (html.trim() !== "") put(converted, key, field, html);
			return;
		}
		case "relationship": {
			if (value.kind !== "items") {
				problem("entryNotFound");
				return;
			}
			if (value.sourceIds.length === 0) return;
			item.finds.push({ column: key, path: [field.key], field, reading: { sources: value.sourceIds } });
			return;
		}
		case "media": {
			const file = fileOf(value, source);
			if (file) {
				want(converted, file);
				item.finds.push({ column: key, path: [field.key], field, reading: { file: file.address, ref: file } });
				return;
			}
			put(converted, key, field, text ?? "");
			return;
		}
		default:
			put(converted, key, field, value.kind === "date" ? value.date : (text ?? ""));
	}
}

/** Puts a value written as text into a Field, through its type's reading of text. */
function put(converted: ConvertedEntry, key: string, field: LeafField, text: string): void {
	const { item } = converted;
	if (text.trim() === "") return;
	const read = readFieldText(text, field);
	if ("problem" in read) {
		item.problems.push({ column: key, rule: read.problem, ...(read.params ? { params: read.params } : {}) });
		return;
	}
	if ("reading" in read) {
		if ("file" in read.reading) want(converted, { address: read.reading.file });
		item.finds.push({ column: key, path: [field.key], field, reading: read.reading });
		return;
	}
	if (field.type === "media") {
		item.finds.push({ column: key, path: [field.key], field, reading: { media: String(read.value) } });
		return;
	}
	setAt(item.values.fields, [field.key], read.input as Json);
}

/** Notes a file the item would fetch. */
function want(converted: ConvertedEntry, file: SourceFileRef): void {
	if (!converted.files.includes(file.address)) converted.files.push(file.address);
}

/** A value's file: a file value, or an `https` address written as text. */
function fileOf(
	value: SourceValue | { kind: "title" | "slug"; text: string },
	source: SourceEntry,
): SourceFileRef | null {
	if (value.kind === "file") return value.file;
	const text = textOf(value)?.trim() ?? "";
	if (!/^https:\/\/\S+$/i.test(text)) return null;
	return source.files?.[text] ?? { address: text };
}

/** A value as plain text: HTML as its text; null for values that aren't text (files, items). */
function textOf(value: SourceValue | { kind: "title" | "slug"; text: string }): string | null {
	switch (value.kind) {
		case "title":
		case "slug":
		case "text":
			return value.text;
		case "html":
			return textFromHtml(value.html);
		case "date":
			return value.date;
		default:
			return null;
	}
}

/** A source's slug as an Entry's: kept when it is one, else made from it (`Crème%20brûlée` is `creme-brulee`). */
function slugOf(text: string): string | null {
	let decoded = text.trim();
	try {
		decoded = decodeURIComponent(decoded);
	} catch {
		// Kept as written.
	}
	const slug = ENTRY_SLUG.test(decoded) ? decoded : slugify(decoded);
	return slug && ENTRY_SLUG.test(slug) ? slug.slice(0, ENTRY_SLUG_MAX_LENGTH).replace(/-+$/, "") : null;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Stand-ins for reading SEO values with the Field types. */
const IMAGE_FIELD = {
	key: "image",
	label: "Image",
	type: "media",
	help: null,
	required: false,
	translatable: false,
	default: null,
} as unknown as LeafField;
const NOINDEX_FIELD = {
	key: "noindex",
	label: "noindex",
	type: "boolean",
	help: null,
	required: false,
	translatable: false,
	default: null,
} as unknown as LeafField;
