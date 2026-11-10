import type { SourceEntry, SourceFile, SourceFileRef, SourceItem, SourceValue } from "@webcraft/module-sdk";

import { childRaw, childText, exportRecords, type XmlElement, type XmlRecord } from "./xml.ts";

/**
 * A WordPress export file as the Import pipeline's items. The file is read more than once, each time
 * as a stream:
 *
 * 1. a first pass learns what items point at: each Media file (attachment) by its id, with its alt
 *    text and caption, the terms' ids by slug, the authors' names, and which items come before their
 *    parent;
 * 2. the next pass gives the types and terms (WordPress writes them first), then every item in the
 *    file's order, leaving out those that come before their parent;
 * 3. one more pass for each level of such items gives them, once their parent was given.
 *
 * Posts, pages and custom post types are Entries; categories, tags and custom taxonomies' terms are
 * Entries too (the Import makes them related Entries); attachments are Media files. Items WordPress
 * keeps for itself (menus, revisions, templates…), items in the trash and auto-drafts are left out.
 */

/** Post types WordPress keeps for its own workings, never content: left out. */
export const INTERNAL_POST_TYPES: ReadonlySet<string> = new Set([
	"nav_menu_item",
	"revision",
	"custom_css",
	"customize_changeset",
	"oembed_cache",
	"user_request",
	"wp_block",
	"wp_template",
	"wp_template_part",
	"wp_global_styles",
	"wp_navigation",
	"wp_font_family",
	"wp_font_face",
]);

/** Taxonomies WordPress keeps for its own workings: left out. */
export const INTERNAL_TAXONOMIES: ReadonlySet<string> = new Set([
	"nav_menu",
	"link_category",
	"post_format",
	"wp_theme",
	"wp_template_part_area",
	"wp_pattern_category",
]);

/** Statuses of items that aren't content: left out. */
const LEFT_OUT_STATUSES: ReadonlySet<string> = new Set(["trash", "auto-draft"]);

/** The names WordPress gives its own types. */
const TYPE_LABELS: Readonly<Record<string, string>> = {
	post: "Posts",
	page: "Pages",
	attachment: "Media",
	category: "Categories",
	post_tag: "Tags",
};

/** Meta keys WordPress itself reads for a Media file's alt text and a post's featured image. */
const ALT_KEY = "_wp_attachment_image_alt";
const FEATURED_KEY = "_thumbnail_id";

type Attachment = { address: string; title: string; alt: string; caption: string };

/** What the first pass learns. */
type Index = {
	site: { origin: string | null };
	attachments: Map<string, Attachment>;
	/** Attachments by address, to name the full-size file of a resized copy. */
	byAddress: Map<string, Attachment>;
	terms: Map<string, Map<string, string>>;
	authors: Map<string, string>;
	/** For each item given late, the pass it is given in (2, 3, …): its parent comes after it in the file. */
	late: Map<string, number>;
	passes: number;
};

/** Reads an export file into the Import pipeline's items (see the module's comment). */
export async function* exportItems(file: SourceFile): AsyncGenerator<SourceItem> {
	const index = await firstPass(file);
	const typesGiven = new Set<string>();
	const typeOf = function* (key: string, holds: "entries" | "media"): Generator<SourceItem> {
		if (typesGiven.has(key)) return;
		typesGiven.add(key);
		yield { kind: "type", key, label: TYPE_LABELS[key] ?? labelOf(key), holds };
	};
	for (let pass = 1; pass <= index.passes; pass++) {
		for await (const record of exportRecords(file.text())) {
			if (record.kind === "site") continue;
			if (record.kind === "author") continue;
			if (record.kind !== "item") {
				if (pass > 1) continue;
				const term = termOf(record);
				if (!term || INTERNAL_TAXONOMIES.has(term.taxonomy)) continue;
				yield* typeOf(term.taxonomy, "entries");
				yield termEntry(term);
				continue;
			}
			const item = record.element;
			const id = childText(item, "wp:post_id");
			const type = childText(item, "wp:post_type") || "post";
			const status = childText(item, "wp:status");
			if (INTERNAL_POST_TYPES.has(type) || LEFT_OUT_STATUSES.has(status) || id === "") continue;
			if ((index.late.get(id) ?? 1) !== pass) continue;
			if (type === "attachment") {
				const attachment = index.attachments.get(id);
				if (!attachment) continue;
				yield* typeOf(type, "media");
				yield {
					kind: "media",
					type,
					sourceId: `wp:attachment:${id}`,
					file: fileRef(attachment, index.site.origin),
					path: pathIn(attachment.address, index.site.origin),
				};
				continue;
			}
			// Terms an item names that the file's header didn't list come in at their first use.
			for (const category of item.children.filter((child) => child.name === "category")) {
				const taxonomy = category.attributes.domain ?? "";
				const slug = category.attributes.nicename ?? "";
				if (!taxonomy || !slug || INTERNAL_TAXONOMIES.has(taxonomy) || termId(index, taxonomy, slug)) continue;
				const sourceId = `wp:${taxonomy}:slug:${slug}`;
				termsOf(index, taxonomy).set(slug, sourceId);
				yield* typeOf(taxonomy, "entries");
				yield termEntry({ taxonomy, sourceId, name: category.text.trim() || slug, slug, description: "" });
			}
			yield* typeOf(type, "entries");
			yield entryOf(item, id, type, index);
		}
	}
}

/** The first pass: Media files, terms, authors, and which items come before their parent. */
async function firstPass(file: SourceFile): Promise<Index> {
	const index: Index = {
		site: { origin: null },
		attachments: new Map(),
		byAddress: new Map(),
		terms: new Map(),
		authors: new Map(),
		late: new Map(),
		passes: 1,
	};
	/** Items that can have a parent, in the file's order. */
	const order: { id: string; parent: string }[] = [];
	const items = new Set<string>();
	for await (const record of exportRecords(file.text())) {
		if (record.kind === "site") {
			index.site.origin = originOf(record.baseSite) ?? originOf(record.link);
			continue;
		}
		if (record.kind === "author") {
			const login = childText(record.element, "wp:author_login");
			const name = childText(record.element, "wp:author_display_name");
			if (login) index.authors.set(login, name || login);
			continue;
		}
		if (record.kind !== "item") {
			const term = termOf(record);
			if (term) termsOf(index, term.taxonomy).set(term.slug, term.sourceId);
			continue;
		}
		const item = record.element;
		const id = childText(item, "wp:post_id");
		const type = childText(item, "wp:post_type") || "post";
		if (id === "" || INTERNAL_POST_TYPES.has(type) || LEFT_OUT_STATUSES.has(childText(item, "wp:status"))) continue;
		if (type === "attachment") {
			const address = childText(item, "wp:attachment_url");
			if (!isWebAddress(address)) continue;
			const attachment: Attachment = {
				address,
				title: childText(item, "title"),
				alt: metaOf(item).get(ALT_KEY) ?? "",
				caption: plainText(childRaw(item, "excerpt:encoded")),
			};
			index.attachments.set(id, attachment);
			index.byAddress.set(address, attachment);
			continue;
		}
		items.add(id);
		order.push({ id, parent: childText(item, "wp:post_parent") });
	}
	// Items whose parent comes later are given in later passes, one more for each level.
	const given = new Set<string>();
	let waiting = order.filter(({ id, parent }) => {
		if (parent === "" || parent === "0" || !items.has(parent) || given.has(parent)) {
			given.add(id);
			return false;
		}
		return true;
	});
	let pass = 1;
	while (waiting.length > 0) {
		pass++;
		const now = waiting.filter(({ parent }) => given.has(parent));
		// A circle of parents: the rest come in this pass, their parents found when the run gets to them.
		const round = now.length > 0 ? now : waiting;
		for (const { id } of round) {
			given.add(id);
			index.late.set(id, pass);
		}
		const done = new Set(round.map(({ id }) => id));
		waiting = waiting.filter(({ id }) => !done.has(id));
	}
	index.passes = pass;
	return index;
}

type Term = { taxonomy: string; sourceId: string; name: string; slug: string; description: string };

function termOf(record: Extract<XmlRecord, { element: XmlElement }>): Term | null {
	const element = record.element;
	const id = childText(element, "wp:term_id");
	let term: Omit<Term, "sourceId"> | null = null;
	if (record.kind === "category") {
		term = {
			taxonomy: "category",
			slug: childText(element, "wp:category_nicename"),
			name: childText(element, "wp:cat_name"),
			description: childText(element, "wp:category_description"),
		};
	} else if (record.kind === "tag") {
		term = {
			taxonomy: "post_tag",
			slug: childText(element, "wp:tag_slug"),
			name: childText(element, "wp:tag_name"),
			description: childText(element, "wp:tag_description"),
		};
	} else if (record.kind === "term") {
		term = {
			taxonomy: childText(element, "wp:term_taxonomy"),
			slug: childText(element, "wp:term_slug"),
			name: childText(element, "wp:term_name"),
			description: childText(element, "wp:term_description"),
		};
	}
	if (!term?.taxonomy || !term.slug) return null;
	return {
		...term,
		name: term.name || term.slug,
		sourceId: id ? `wp:${term.taxonomy}:${id}` : `wp:${term.taxonomy}:slug:${term.slug}`,
	};
}

function termEntry(term: Term): SourceEntry {
	return {
		kind: "entry",
		type: term.taxonomy,
		sourceId: term.sourceId,
		title: term.name,
		slug: term.slug,
		parent: null,
		path: null,
		values: term.description ? { description: { kind: "text", text: term.description } } : {},
	};
}

function termsOf(index: Index, taxonomy: string): Map<string, string> {
	let terms = index.terms.get(taxonomy);
	if (!terms) {
		terms = new Map();
		index.terms.set(taxonomy, terms);
	}
	return terms;
}

function termId(index: Index, taxonomy: string, slug: string): string | undefined {
	return index.terms.get(taxonomy)?.get(slug);
}

/** A post, a page or an item of a custom post type, with its values by key. */
function entryOf(item: XmlElement, id: string, type: string, index: Index): SourceEntry {
	const values: Record<string, SourceValue> = {};
	const content = childRaw(item, "content:encoded");
	if (content.trim() !== "") values.content = { kind: "html", html: content };
	const excerpt = childRaw(item, "excerpt:encoded");
	if (excerpt.trim() !== "") values.excerpt = { kind: "html", html: excerpt };
	const date = momentOf(childText(item, "wp:post_date_gmt")) ?? momentOf(childText(item, "wp:post_date"));
	if (date) values.date = { kind: "date", date };
	const modified = momentOf(childText(item, "wp:post_modified_gmt")) ?? momentOf(childText(item, "wp:post_modified"));
	if (modified) values.modified = { kind: "date", date: modified };
	const login = childText(item, "dc:creator");
	if (login) values.author = { kind: "text", text: index.authors.get(login) ?? login };

	const terms = new Map<string, string[]>();
	for (const category of item.children.filter((child) => child.name === "category")) {
		const taxonomy = category.attributes.domain ?? "";
		const sourceId = termId(index, taxonomy, category.attributes.nicename ?? "");
		if (!sourceId || INTERNAL_TAXONOMIES.has(taxonomy)) continue;
		const list = terms.get(taxonomy) ?? [];
		if (!list.includes(sourceId)) list.push(sourceId);
		terms.set(taxonomy, list);
	}
	for (const [taxonomy, sourceIds] of terms) values[`terms:${taxonomy}`] = { kind: "items", sourceIds };

	for (const [key, value] of metaOf(item)) {
		if (key in values) continue;
		if (key === FEATURED_KEY) {
			const attachment = index.attachments.get(value.trim());
			values[key] = attachment
				? { kind: "file", file: fileRef(attachment, index.site.origin) }
				: { kind: "text", text: value };
			continue;
		}
		values[key] = { kind: "text", text: value };
	}

	const parent = childText(item, "wp:post_parent");
	const parentType = parent && parent !== "0" ? type : null;
	const files = filesNamed([content, excerpt], index);
	return {
		kind: "entry",
		type,
		sourceId: `wp:${type}:${id}`,
		title: childText(item, "title"),
		slug: childText(item, "wp:post_name") || null,
		parent: parentType ? `wp:${parentType}:${parent}` : null,
		path: pathIn(childText(item, "link"), index.site.origin),
		values,
		...(Object.keys(files).length > 0 ? { files } : {}),
	};
}

/** A post's meta values by key, the first of each key. */
function metaOf(item: XmlElement): Map<string, string> {
	const meta = new Map<string, string>();
	for (const entry of item.children.filter((child) => child.name === "wp:postmeta")) {
		const key = childText(entry, "wp:meta_key");
		if (key && !meta.has(key)) meta.set(key, childRaw(entry, "wp:meta_value"));
	}
	return meta;
}

/** A resized copy's address (`photo-1024x683.jpg`) without its size: the full-size file's. */
const RESIZED = /-\d{1,5}x\d{1,5}(\.[A-Za-z0-9]{1,8})$/;

/** Addresses written in HTML that look like a file's. */
const ADDRESS = /https?:\/\/[^\s"'<>()\\]+/g;

/**
 * The Media files an item's HTML names, by the address written there: the file to fetch (the
 * full-size original of a resized copy) with its alt text and caption.
 */
function filesNamed(html: readonly string[], index: Index): Record<string, SourceFileRef> {
	const files: Record<string, SourceFileRef> = {};
	for (const text of html) {
		for (const match of text.matchAll(ADDRESS)) {
			const address = match[0].replaceAll("&amp;", "&");
			if (address in files) continue;
			const attachment = index.byAddress.get(address) ?? index.byAddress.get(address.replace(RESIZED, "$1"));
			if (attachment) files[address] = fileRef(attachment, index.site.origin);
		}
	}
	return files;
}

function fileRef(attachment: Attachment, origin: string | null): SourceFileRef {
	const path = pathIn(attachment.address, origin);
	return {
		address: attachment.address,
		...(path ? { path } : {}),
		...(attachment.title ? { title: attachment.title } : {}),
		...(attachment.alt ? { alt: attachment.alt } : {}),
		...(attachment.caption ? { caption: attachment.caption } : {}),
	};
}

/** `2024-03-12 09:30:00` (as WordPress writes it, here in UTC) as `2024-03-12T09:30:00Z`; null for none. */
function momentOf(text: string): string | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
	if (!match || match[1] === "0000") return null;
	const [, year, month, day, hour, minute, second] = match;
	const moment = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
	return Number.isNaN(moment.getTime()) ? null : moment.toISOString().replace(".000Z", "Z");
}

/** Where an address was on the old site, as a path; null on another site, or for a query (`?p=12`). */
function pathIn(address: string, origin: string | null): string | null {
	if (!origin || !isWebAddress(address)) return null;
	const url = new URL(address);
	if (url.origin !== origin || url.search !== "") return null;
	return url.pathname;
}

function originOf(address: string): string | null {
	return isWebAddress(address) ? new URL(address).origin : null;
}

function isWebAddress(address: string): boolean {
	if (!/^https?:\/\//i.test(address)) return false;
	try {
		new URL(address);
		return true;
	} catch {
		return false;
	}
}

/** A caption written as HTML, as plain text. */
function plainText(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/** A type's key as a name: `recipe_book` is "Recipe book". */
function labelOf(key: string): string {
	const words = key.replace(/[_-]+/g, " ").trim();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}
