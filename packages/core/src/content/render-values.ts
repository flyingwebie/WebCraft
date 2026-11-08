import type { RenderValue } from "@webcraft/renderer";

import type { FieldDefinition, Json, LinkValue } from "./field-types.ts";
import { BUILT_IN_FIELDS } from "./fields.ts";

/**
 * What the names in a Template resolve to (the value side of rendering; Template markup and the
 * renderer decide how a value is written and escaped). A binding's path is names joined by dots:
 *
 * - a built-in Field (`title`, `publishedAt`) or a Field of the Entry's Post Type (`summary`);
 * - a part of a Field: a Group's Field (`address.city`), a Repeater's Field across its rows
 *   (`team.name`: every row's name), a link's `url` or `text`, a select's `value` or `label`;
 * - what a Relationship points at, one level deep: its published Entries' built-in Fields, `url`
 *   and Fields (`category.title`, `category.url`, `authors.name`), unpublished Entries left out;
 * - `site.x`: the Site's published Globals (`site.phone`, `site.address.city`).
 *
 * On its own, a select shows its label, a link its text (or address), a Relationship its Entries'
 * titles, rich text its cleaned HTML; Groups and Repeater rows show nothing. A path through a list
 * gives a list, which a text position shows joined with commas until Loops show items one by one.
 */

/** A value with named parts, and what it shows on its own. */
export type Parts = { readonly text: RenderValue; part(name: string): Resolved | undefined };

/** A value on its way to the renderer, before a path picks a part of it. */
export type Resolved = RenderValue | Parts | readonly Resolved[];

function isParts(value: Resolved | undefined): value is Parts {
	return typeof value === "object" && value !== null && !Array.isArray(value) && "part" in value;
}

/** The value a path names from `root`, or undefined when it names nothing. */
export function resolvePath(root: Parts, path: string): RenderValue {
	let current: Resolved | undefined = root;
	for (const name of path.split(".")) {
		current = step(current, name);
		if (current === undefined) return undefined;
	}
	return finish(current);
}

function step(value: Resolved | undefined, name: string): Resolved | undefined {
	if (Array.isArray(value)) {
		return (value as readonly Resolved[])
			.map((item) => step(item, name))
			.filter((item) => item !== undefined) as Resolved[];
	}
	return isParts(value) ? value.part(name) : undefined;
}

function finish(value: Resolved): RenderValue {
	if (Array.isArray(value)) return (value as readonly Resolved[]).map(finish);
	return isParts(value) ? value.text : (value as RenderValue);
}

/** A published Entry a Relationship points at, ready to be read one level deep. */
export type RelatedEntry = {
	/** Its built-in values: `title`, `slug`, `url`, dates. */
	builtIns: Readonly<Record<string, RenderValue>>;
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
	builtIns: Readonly<Record<string, RenderValue>>,
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

/** The Globals as `site.x` reads them. */
export function globalsParts(fields: readonly FieldDefinition[], values: Readonly<Record<string, Json>>): Parts {
	return fieldParts(fields, values, null, null);
}

/** Fields' values by key. `sources` is null where Relationships aren't followed (a related Entry's own, the Globals). */
function fieldParts(
	fields: readonly FieldDefinition[],
	values: Readonly<Record<string, Json>>,
	sources: ValueSources | null,
	text: RenderValue,
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
			return typeof value === "string" ? { kind: "richText", html: value } : null;
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
			// Media Fields render once the Media library (#73) gives them Media.
			return null;
		default:
			return value as RenderValue;
	}
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
	const site = fieldsShape(options.globalFields, null);
	const root: Shape = {
		part: (name) => (builtIns.has(name) ? LEAF : name === "site" ? site : own.part(name)),
	};
	return (path) => {
		let shape: Shape | undefined = root;
		for (const name of path.split(".")) {
			shape = shape?.part(name);
			if (!shape) return false;
		}
		return true;
	};
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
