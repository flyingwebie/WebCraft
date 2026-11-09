import {
	bodyExcerpt,
	bodyImage,
	bodyReadingTime,
	bodyToc,
	bodyValue,
	type PropArgument,
	richText,
	storedBlocks,
	type TemplateValue,
	tocValue,
	type ValueReader,
} from "@webcraft/renderer";

import type { FieldDefinition, Json, LinkValue } from "./field-types.ts";
import { BUILT_IN_FIELDS } from "./fields.ts";

/**
 * What the names in a Template resolve to (the value side of rendering; Template markup and the
 * renderer decide how a value is written and escaped). A binding's path is names joined by dots:
 *
 * - a built-in Field (`title`, `publishedAt`) or a Field of the Entry's Post Type (`summary`);
 * - a part of a Field: a Group's Field (`address.city`), a Repeater's Field across its rows
 *   (`team.name`: every row's name), a link's `url` or `text`, a select's `value` or `label`, what
 *   a body says of itself (`body.excerpt`, `body.image`, `body.reading_time`, `body.toc`);
 * - what a Relationship points at, one level deep: its published Entries' built-in Fields, `url`
 *   and Fields (`category.title`, `category.url`, `authors.name`), unpublished Entries left out;
 * - `site.x`: the Site's published Globals (`site.phone`, `site.address.city`);
 * - inside a Component, `props.x`: the Placement's Prop values, read through each Prop's Field type
 *   (`props.link.url`), or the value a Prop passes on from where it is placed.
 *
 * On its own, a select shows its label, a link its text (or address), a Relationship its Entries'
 * titles, rich text its cleaned HTML, a body its Blocks as HTML; Groups and Repeater rows show nothing. A path through a list
 * gives a list, which a text position shows joined with commas until Loops show items one by one.
 */

/** A value with named parts, and what it shows on its own. */
export type Parts = { readonly text: TemplateValue; part(name: string): Resolved | undefined };

/** A value on its way to the renderer, before a path picks a part of it. */
export type Resolved = TemplateValue | Parts | readonly Resolved[];

function isParts(value: Resolved | undefined): value is Parts {
	return typeof value === "object" && value !== null && !Array.isArray(value) && "part" in value;
}

/** The value a path names from `root`, or undefined when it names nothing. */
export function resolvePath(root: Parts, path: string): TemplateValue {
	return resolveNames(root, path.split("."));
}

/** The value `names` pick from `start`, one part after another; undefined when they name nothing. */
function resolveNames(start: Resolved, names: readonly string[]): TemplateValue {
	let current: Resolved | undefined = start;
	for (const name of names) {
		current = step(current, name);
		if (current === undefined) return undefined;
	}
	return finish(current);
}

function step(value: Resolved | undefined, name: string): Resolved | undefined {
	// A list keeps one value per item, null where an item has no such part (an Entry of another Post
	// Type), so a Loop over the list finds each item's value at its own place.
	if (Array.isArray(value)) return (value as readonly Resolved[]).map((item) => step(item, name) ?? null);
	return isParts(value) ? value.part(name) : undefined;
}

function finish(value: Resolved): TemplateValue {
	if (Array.isArray(value)) return (value as readonly Resolved[]).map(finish);
	return isParts(value) ? value.text : (value as TemplateValue);
}

/** A published Entry a Relationship points at, ready to be read one level deep. */
export type RelatedEntry = {
	/** Its built-in values: `title`, `slug`, `url`, dates. */
	builtIns: Readonly<Record<string, TemplateValue>>;
	fields: readonly FieldDefinition[];
	/** Its published Field values in the page's language, as `readFields` gives them. */
	values: Readonly<Record<string, Json>>;
};

/** What resolving values on a page needs besides the Entry itself. */
export type ValueSources = {
	/** The published Entries Relationships point at, by id; others are left out. */
	related: ReadonlyMap<string, RelatedEntry>;
	/** The Site's published Globals, for `site.x`. */
	site: Parts;
};

/** The names an Entry's own values are read from: its built-in Fields, its Fields and `site`. */
export function entryParts(
	builtIns: Readonly<Record<string, TemplateValue>>,
	fields: readonly FieldDefinition[],
	values: Readonly<Record<string, Json>>,
	sources: ValueSources,
): Parts {
	const own = fieldParts(fields, values, sources, null);
	return {
		text: null,
		part: (name) => {
			if (Object.hasOwn(builtIns, name)) return builtIns[name];
			if (name === "site") return sources.site;
			return own.part(name);
		},
	};
}

/**
 * The Globals as `site.x` reads them, with the Site's own values beside them: `site.language`, the
 * page's language (a Condition's `site.language == "fr"`), and `site.name`.
 */
export function globalsParts(
	fields: readonly FieldDefinition[],
	values: Readonly<Record<string, Json>>,
	own: { language?: string; name?: string } = {},
): Parts {
	const globals = fieldParts(fields, values, null, null);
	return {
		text: null,
		part: (name) =>
			name === "language" ? (own.language ?? null) : name === "name" ? (own.name ?? null) : globals.part(name),
	};
}

/** The Site's own values `site.x` reads beside the Globals (Globals can't take these keys). */
export const SITE_VALUES = ["language", "name"] as const;

/** Fields' values by key. `sources` is null where Relationships aren't followed (a related Entry's own, the Globals). */
function fieldParts(
	fields: readonly FieldDefinition[],
	values: Readonly<Record<string, Json>>,
	sources: ValueSources | null,
	text: TemplateValue,
): Parts {
	return {
		text,
		part: (name) => {
			const field = fields.find((candidate) => candidate.key === name);
			return field ? fieldValue(field, values[name] ?? null, sources) : undefined;
		},
	};
}

function fieldValue(field: FieldDefinition, value: Json, sources: ValueSources | null): Resolved {
	switch (field.type) {
		case "group":
			return fieldParts(field.fields, record(value), sources, null);
		case "repeater":
			return (Array.isArray(value) ? value : []).map((row) => fieldParts(field.fields, record(row), sources, null));
		case "richText":
			return typeof value === "string" ? richText(value) : null;
		case "body":
			return bodyParts(value);
		case "select": {
			const option = (choice: Json): Parts | null => {
				const found = field.options.find((candidate) => candidate.value === choice);
				if (!found) return null;
				return {
					text: found.label,
					part: (name) => (name === "label" ? found.label : name === "value" ? found.value : undefined),
				};
			};
			if (Array.isArray(value)) return value.map(option).filter((choice) => choice !== null);
			return value === null ? null : option(value);
		}
		case "link": {
			if (value === null) return null;
			const link = value as LinkValue;
			return {
				text: link.text || link.url,
				part: (name) => (name === "url" ? link.url : name === "text" ? link.text : undefined),
			};
		}
		case "relationship": {
			if (!sources) return null;
			const ids = Array.isArray(value) ? value : value === null ? [] : [value];
			const related = ids.flatMap((id) => {
				const entry = typeof id === "string" ? sources.related.get(id) : undefined;
				return entry ? [relatedParts(entry)] : [];
			});
			return field.multiple ? related : (related[0] ?? null);
		}
		case "media":
			// The id of a file in the Media library, read as `media:<id>`: an `<img>` bound to it renders
			// as a Media image, a link as the file's address.
			return typeof value === "string" ? `media:${value}` : null;
		default:
			return value as TemplateValue;
	}
}

/** The parts a body's value has, besides its Blocks: what Templates and Loops read of it (ADR 0018). */
export const BODY_PARTS = ["excerpt", "image", "reading_time", "toc"] as const;

/**
 * A body: its Blocks on their own (rendered as HTML), and the values worked out from them: the first
 * paragraph as plain text, the first image (read as `media:<id>`, so an `<img>` bound to it renders
 * as a Media image), the minutes reading it takes and its headings with their anchors.
 */
function bodyParts(value: Json): Parts {
	const blocks = storedBlocks(value);
	return {
		text: bodyValue(blocks),
		part(name) {
			switch (name) {
				case "excerpt":
					return bodyExcerpt(blocks);
				case "image": {
					const id = bodyImage(blocks);
					return id === null ? null : `media:${id}`;
				}
				case "reading_time":
					return bodyReadingTime(blocks);
				case "toc":
					return tocValue(bodyToc(blocks));
				default:
					return undefined;
			}
		},
	};
}

function relatedParts(entry: RelatedEntry): Parts {
	const fields = fieldParts(entry.fields, entry.values, null, null);
	return {
		text: entry.builtIns.title ?? null,
		part: (name) => (Object.hasOwn(entry.builtIns, name) ? entry.builtIns[name] : fields.part(name)),
	};
}

function record(value: Json): Record<string, Json> {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// ---------------------------------------------------------------------------------------------------
// Which names a Template may read

/** The names a value has parts under; a leaf has none. */
type Shape = { part(name: string): Shape | undefined };

const LEAF: Shape = { part: () => undefined };

/** The built-in values of an Entry a Relationship points at. */
export const RELATED_BUILT_INS = [
	"title",
	"slug",
	"url",
	"createdAt",
	"updatedAt",
	"publishedAt",
	"lastPublishedAt",
] as const;

/** What an Entry template may read: names it may bind to, checked when it is saved and published. */
export function knownValues(options: {
	fields: readonly FieldDefinition[];
	/** Every Post Type of the Site, for what Relationships point at. */
	postTypes: readonly { key: string; fields: readonly FieldDefinition[] }[];
	/** The Globals' Fields, for `site.x`. */
	globalFields: readonly FieldDefinition[];
}): (path: string) => boolean {
	const builtIns = new Set<string>(BUILT_IN_FIELDS);
	const own = fieldsShape(options.fields, options.postTypes);
	const site = siteShape(options.globalFields);
	return pathsUnder({
		part: (name) => (builtIns.has(name) ? LEAF : name === "site" ? site : own.part(name)),
	});
}

/**
 * What a Component's tree may read: its Props as `props.x` (and their parts, as for Fields:
 * `props.link.url`, `props.category.title`) and the Globals as `site.x`. Nothing of the Entry it
 * may be placed on: what it shows of one comes in through its Props.
 */
export function componentKnownValues(options: {
	props: readonly FieldDefinition[];
	postTypes: readonly { key: string; fields: readonly FieldDefinition[] }[];
	globalFields: readonly FieldDefinition[];
}): (path: string) => boolean {
	const props = fieldsShape(options.props, options.postTypes);
	const site = siteShape(options.globalFields);
	return pathsUnder({ part: (name) => (name === "props" ? props : name === "site" ? site : undefined) });
}

/** `site.x`: the Globals, and the Site's own values (`site.language`, `site.name`). */
function siteShape(globalFields: readonly FieldDefinition[]): Shape {
	const globals = fieldsShape(globalFields, null);
	return { part: (name) => ((SITE_VALUES as readonly string[]).includes(name) ? LEAF : globals.part(name)) };
}

/**
 * The values of a query Loop's items, as each Entry has them: its built-in values (`title`, `url`,
 * dates), its author's name, and its Post Type's Fields and their parts, Relationships followed one
 * level (`category.title`).
 */
export const QUERY_ITEM_BUILT_INS = [...RELATED_BUILT_INS, "author"] as const;

/**
 * What a Loop's items may be read as (`post.title`, `post.category.url`, `hour.day`): for a query
 * Loop, its Post Types' Entries (`QUERY_ITEM_BUILT_INS` and the Fields of any of them); for a Loop of
 * its own items, their Fields.
 */
export function loopItemKnownValues(options: {
	source: "query" | "items";
	/** The Post Types a query Loop lists, by key. */
	listed: readonly string[];
	/** The Loop items' Fields. */
	fields: readonly FieldDefinition[];
	/** Every Post Type of the Site. */
	postTypes: readonly { key: string; fields: readonly FieldDefinition[] }[];
}): (path: string) => boolean {
	if (options.source === "items") return pathsUnder(fieldsShape(options.fields, options.postTypes));
	const builtIns = new Set<string>(QUERY_ITEM_BUILT_INS);
	const listed = options.postTypes
		.filter((postType) => options.listed.includes(postType.key))
		.map((postType) => fieldsShape(postType.fields, options.postTypes));
	return pathsUnder({
		part: (name) => {
			if (builtIns.has(name)) return LEAF;
			for (const shape of listed) {
				const found = shape.part(name);
				if (found) return found;
			}
			return undefined;
		},
	});
}

/** Whether a path names something under `root`. */
function pathsUnder(root: Shape): (path: string) => boolean {
	return (path) => {
		let shape: Shape | undefined = root;
		for (const name of path.split(".")) {
			shape = shape?.part(name);
			if (!shape) return false;
		}
		return true;
	};
}

// ---------------------------------------------------------------------------------------------------
// What a Placement's Component reads

/** What reading a Placement's Props needs besides the Placement itself. */
export type PlacementSources = {
	/** The Site's published Globals, for `site.x`. */
	site: Parts;
	/** The published Entries Relationship Props point at, by id, with their Post Type's key. */
	related: ReadonlyMap<string, RelatedEntry & { postTypeKey: string }>;
	/** A Prop's value from fixed text, through its Field type; null when the text isn't one it holds. */
	read(prop: FieldDefinition, text: string): Json;
};

/**
 * What a Component's bindings read where it is placed: `props.x` from the Placement's Prop values,
 * `site.x` from the Globals. A Prop the Placement doesn't give has its default. A Prop given as one
 * value (`heading="{{ title }}"`) reads that value where the Component is placed, parts and all
 * (`props.category.title` reads `category.title` there); fixed text is read through the Prop's Field
 * type, as a Field's value is.
 */
export function placementValues(
	props: readonly FieldDefinition[],
	given: ReadonlyMap<string, PropArgument>,
	outer: ValueReader,
	sources: PlacementSources,
): ValueReader {
	return (path) => {
		const [head, key = "", ...rest] = path.split(".");
		if (head === "site") return resolveNames(sources.site, [key, ...rest]);
		const prop = head === "props" ? props.find((candidate) => candidate.key === key) : undefined;
		if (!prop) return undefined;
		const argument = given.get(key);
		if (argument?.kind === "bound") return outer([argument.path, ...rest].join("."));
		const json = argument ? sources.read(prop, argument.text) : (prop.default as Json);
		return resolveNames(
			fieldValue(prop, json, { site: sources.site, related: relatedOf(prop, sources.related) }),
			rest,
		);
	};
}

/** The Entries a Relationship Prop may show: published ones of its Post Types. */
function relatedOf(prop: FieldDefinition, related: PlacementSources["related"]): ReadonlyMap<string, RelatedEntry> {
	if (prop.type !== "relationship") return related;
	return new Map([...related].filter(([, entry]) => prop.postTypes.includes(entry.postTypeKey)));
}

/** `postTypes` is null where Relationships aren't followed. */
function fieldsShape(
	fields: readonly FieldDefinition[],
	postTypes: readonly { key: string; fields: readonly FieldDefinition[] }[] | null,
): Shape {
	return {
		part: (name) => {
			const field = fields.find((candidate) => candidate.key === name);
			return field ? fieldShape(field, postTypes) : undefined;
		},
	};
}

function fieldShape(
	field: FieldDefinition,
	postTypes: readonly { key: string; fields: readonly FieldDefinition[] }[] | null,
): Shape | undefined {
	switch (field.type) {
		case "group":
		case "repeater":
			return fieldsShape(field.fields, postTypes);
		case "select":
			return named(["value", "label"]);
		case "link":
			return named(["url", "text"]);
		case "body":
			return named(BODY_PARTS);
		case "relationship": {
			if (!postTypes) return undefined;
			const targets = postTypes.filter((postType) => field.postTypes.includes(postType.key));
			const builtIns = new Set<string>(RELATED_BUILT_INS);
			return {
				part: (name) => {
					if (builtIns.has(name)) return LEAF;
					for (const target of targets) {
						const shape = fieldsShape(target.fields, null).part(name);
						if (shape) return shape;
					}
					return undefined;
				},
			};
		}
		default:
			return LEAF;
	}
}

function named(names: readonly string[]): Shape {
	return { part: (name) => (names.includes(name) ? LEAF : undefined) };
}
