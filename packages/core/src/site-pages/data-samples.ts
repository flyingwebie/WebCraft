import { entries, globals, loops } from "@webcraft/db/schema";
import { bodyExcerpt, bodyImage, bodyReadingTime, bodyToc, DEFAULT_ITEM_NAME, storedBlocks } from "@webcraft/renderer";
import { and, desc, eq } from "drizzle-orm";

import { entryValues } from "../content/entries.ts";
import { publishedAddresses } from "../content/entry-paths.ts";
import { LoopNotFoundError } from "../content/errors.ts";
import type { FieldDefinition, Json } from "../content/field-types.ts";
import { type Languages, linksIn } from "../content/field-values.ts";
import { storedFields } from "../content/fields.ts";
import { globalsVersion } from "../content/globals.ts";
import { languagesFor, siteLanguages } from "../content/languages.ts";
import { loopItems, storedLoopVersion } from "../content/loops.ts";
import { getPostType, listPostTypes, type PostType } from "../content/post-types.ts";
import { QUERY_ITEM_BUILT_INS, type RelatedEntry, SITE_VALUES } from "../content/render-values.ts";
import { storedVersion } from "../content/values.ts";
import { isUuid } from "../ids.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { queryRows } from "./loops.ts";
import { namesOf, relatedEntries } from "./related.ts";

/**
 * The Data tab (Staff only): a real item's values from the Draft, as JSON shaped the way bindings
 * read them (a select as its value and label, a Relationship as the Entries it points at, a body as
 * its excerpt, image, reading time and headings), and the bindings Template markup writes to read
 * each value, so Staff write correct markup without guessing. For a Loop (its first item), an Entry
 * template (an Entry of its Post Type) and the Globals (`site.x`).
 */
export type DataSample = {
	/** The item shown, with what names it (an Entry's title); null when there is none yet. */
	item: { label: string; values: Record<string, Json> } | null;
	/** What markup writes, in order, each with the label of the Field it reads (null for a built-in value). */
	bindings: DataBinding[];
};

export type DataBinding = { binding: string; label: string | null };

/**
 * A Loop's first item from its Draft: for a query Loop, the first Entry its Draft query finds among
 * the Drafts of the Site's Entries (never published ones too); for a Loop of its own items, its first
 * Loop item. Values in `language` (the Default language unless given).
 */
export async function loopData(scope: SiteScope, loopId: string, language?: string): Promise<DataSample> {
	const row = isUuid(loopId) ? await scope.first(loops, eq(loops.id, loopId)) : undefined;
	if (!row) throw new LoopNotFoundError();
	const languages = await languagesOf(scope, language);
	const version = storedLoopVersion(row.draft);
	const postTypes = await listPostTypes(scope);
	const around = [
		{ binding: `{{@loop ${row.name} as ${DEFAULT_ITEM_NAME}}}`, label: null },
		{ binding: `{{ ${row.name}.count }}`, label: null },
		{ binding: `{{@if ${row.name}.empty}}`, label: null },
		{ binding: "{{ loop.index }}", label: null },
		{ binding: "{{@if loop.first}}", label: null },
		{ binding: "{{@if loop.last}}", label: null },
	];
	if (version.source === "items") {
		const [first] = loopItems(version, languages);
		const { id: _, ...values } = first ?? {};
		return {
			item: first
				? {
						label: String(Object.values(values).find((value) => typeof value === "string") ?? ""),
						values: sampleOf(version.fields, values, new Map(), false),
					}
				: null,
			bindings: [...around, ...fieldBindings(version.fields, `${DEFAULT_ITEM_NAME}.`, postTypes, false)],
		};
	}
	const listed = postTypes.filter((postType) => version.query.postTypes.includes(postType.key));
	const [first] = await queryRows(
		scope,
		version.query,
		{ current: null, languages, page: null, path: "/", version: "draft" },
		postTypes,
		version.query.offset,
		1,
	);
	const bindings = [
		...around,
		...QUERY_ITEM_BUILT_INS.map((name) => ({ binding: `{{ ${DEFAULT_ITEM_NAME}.${name} }}`, label: null })),
		...fieldBindings(uniqueFields(listed), `${DEFAULT_ITEM_NAME}.`, postTypes, true),
	];
	return { item: first ? await entrySample(scope, first.entry, postTypes, languages) : null, bindings };
}

/**
 * An Entry of a Post Type from its Draft, read as its Entry template reads it: the one asked for, or
 * the one saved last. Its bindings name its values without a prefix (`{{ title }}`).
 */
export async function entryTemplateData(
	scope: SiteScope,
	postTypeId: string,
	options: { language?: string; entryId?: string } = {},
): Promise<DataSample> {
	const postType = await getPostType(scope, postTypeId);
	const languages = await languagesOf(scope, options.language);
	const postTypes = await listPostTypes(scope);
	const row = await scope.first(
		entries,
		and(
			eq(entries.postTypeId, postType.id),
			options.entryId && isUuid(options.entryId) ? eq(entries.id, options.entryId) : undefined,
		),
		{ orderBy: [desc(entries.updatedAt)] },
	);
	return {
		item: row ? await entrySample(scope, row, postTypes, languages) : null,
		bindings: [
			...QUERY_ITEM_BUILT_INS.map((name) => ({ binding: `{{ ${name} }}`, label: null })),
			...fieldBindings(postType.fields, "", postTypes, true),
		],
	};
}

/** The Globals' Draft values, with the Site's own `site.language` and `site.name`, read as `site.x`. */
export async function globalsData(scope: SiteScope, language?: string): Promise<DataSample> {
	const languages = await languagesOf(scope, language);
	const row = await scope.first(globals);
	const draft = globalsVersion(row, languages, "draft");
	const fields = storedFields(row?.fields);
	const own = { language: languages.language, name: scope.site.name };
	return {
		item: {
			label: scope.site.name,
			values: { ...sampleOf(fields, draft.values, new Map(), false), ...own },
		},
		bindings: [
			...fieldBindings(fields, "site.", [], false),
			...SITE_VALUES.map((name) => ({ binding: `{{ site.${name} }}`, label: null })),
		],
	};
}

async function languagesOf(scope: SiteScope, language?: string): Promise<Languages> {
	const site = await siteLanguages(scope);
	return languagesFor(site, language) ?? { language: site.defaultLanguage, defaultLanguage: site.defaultLanguage };
}

/** An Entry's Draft as bindings read it: its built-in values, then its Fields. */
async function entrySample(
	scope: SiteScope,
	row: typeof entries.$inferSelect,
	postTypes: readonly PostType[],
	languages: Languages,
): Promise<DataSample["item"]> {
	const postType = postTypes.find((candidate) => candidate.id === row.postTypeId);
	if (!postType) return null;
	const version = storedVersion(row.draft);
	const values = entryValues(version, postType.fields, languages);
	const address = (await publishedAddresses(scope, postType, [row.id], languages)).get(row.id);
	const author = row.authorId ? ((await namesOf(scope, [row.authorId])).get(row.authorId) ?? null) : null;
	const related = await relatedEntries(
		scope,
		postTypes,
		linksIn(version.values, postType.fields).map((link) => link.targetId),
		languages,
	);
	return {
		label: values.title,
		values: {
			title: values.title,
			slug: address?.slug ?? values.slug,
			url: address?.path ?? null,
			author,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			publishedAt: row.publishedAt?.toISOString() ?? null,
			lastPublishedAt: row.lastPublishedAt?.toISOString() ?? null,
			...sampleOf(postType.fields, values.fields, related, true),
		},
	};
}

/** Fields' values (as the API gives them) the way bindings read them. */
function sampleOf(
	fields: readonly FieldDefinition[],
	values: Readonly<Record<string, Json>>,
	related: ReadonlyMap<string, RelatedEntry>,
	follow: boolean,
): Record<string, Json> {
	return Object.fromEntries(
		fields.map((field) => [field.key, sampleValue(field, values[field.key] ?? null, related, follow)]),
	);
}

function sampleValue(
	field: FieldDefinition,
	value: Json,
	related: ReadonlyMap<string, RelatedEntry>,
	follow: boolean,
): Json {
	switch (field.type) {
		case "group":
			return sampleOf(field.fields, record(value), related, follow);
		case "repeater":
			return (Array.isArray(value) ? value : []).map((row) => sampleOf(field.fields, record(row), related, follow));
		case "select": {
			const option = (choice: Json): Json => {
				const found = field.options.find((candidate) => candidate.value === choice);
				return found ? { value: found.value, label: found.label } : null;
			};
			return Array.isArray(value) ? value.map(option) : value === null ? null : option(value);
		}
		case "media":
			return typeof value === "string" ? `media:${value}` : null;
		case "body": {
			const blocks = storedBlocks(value);
			const image = bodyImage(blocks);
			return {
				excerpt: bodyExcerpt(blocks),
				image: image === null ? null : `media:${image}`,
				reading_time: bodyReadingTime(blocks),
				toc: bodyToc(blocks).map((heading) => ({ ...heading })),
			};
		}
		case "relationship": {
			if (!follow) return null;
			const ids = Array.isArray(value) ? value : value === null ? [] : [value];
			const shown = ids.flatMap((id) => {
				const entry = typeof id === "string" ? related.get(id) : undefined;
				return entry ? [relatedSample(entry)] : [];
			});
			return field.multiple ? shown : (shown[0] ?? null);
		}
		default:
			return value;
	}
}

function relatedSample(entry: RelatedEntry): Json {
	const builtIns: Record<string, Json> = {};
	for (const [name, value] of Object.entries(entry.builtIns)) {
		builtIns[name] = value instanceof Date ? value.toISOString() : ((value ?? null) as Json);
	}
	return { ...builtIns, ...sampleOf(entry.fields, entry.values, new Map(), false) };
}

/**
 * The bindings that read Fields under `prefix` (`item.`, `site.`, or none): a leaf as `{{ path }}`, a
 * select's value and label, a link's address and text, a body's parts, a Group's Fields, and a
 * Repeater or multiple Relationship as a Loop over it with its own item's values. A single
 * Relationship's Entry is read one level deep when `follow`.
 */
function fieldBindings(
	fields: readonly FieldDefinition[],
	prefix: string,
	postTypes: readonly PostType[],
	follow: boolean,
): DataBinding[] {
	const bindings: DataBinding[] = [];
	const add = (path: string, label: string) => bindings.push({ binding: `{{ ${path} }}`, label });
	for (const field of fields) {
		const path = `${prefix}${field.key}`;
		switch (field.type) {
			case "group":
				bindings.push(...fieldBindings(field.fields, `${path}.`, postTypes, follow));
				break;
			case "repeater": {
				const item = itemName(field.key);
				bindings.push({ binding: `{{@loop ${path} as ${item}}}`, label: field.label });
				bindings.push(...fieldBindings(field.fields, `${item}.`, postTypes, follow));
				break;
			}
			case "select":
				add(path, field.label);
				add(`${path}.value`, field.label);
				add(`${path}.label`, field.label);
				break;
			case "link":
				add(`${path}.url`, field.label);
				add(`${path}.text`, field.label);
				break;
			case "body":
				add(path, field.label);
				for (const part of ["excerpt", "image", "reading_time", "toc"]) add(`${path}.${part}`, field.label);
				break;
			case "relationship": {
				if (!follow) break;
				const targets = postTypes.filter((postType) => field.postTypes.includes(postType.key));
				const reading = field.multiple ? itemName(field.key) : path;
				if (field.multiple) bindings.push({ binding: `{{@loop ${path} as ${reading}}}`, label: field.label });
				for (const name of ["title", "url"]) add(`${reading}.${name}`, field.label);
				for (const target of uniqueFields(targets)) {
					if (target.type === "relationship" || target.type === "repeater" || target.type === "group") continue;
					add(`${reading}.${target.key}`, `${field.label} › ${target.label}`);
				}
				break;
			}
			default:
				add(path, field.label);
		}
	}
	return bindings;
}

/** What a Loop over a list calls its items: the list's name in the singular (`steps` → `step`), else `<name>Item`. */
function itemName(key: string): string {
	return key.length > 3 && key.endsWith("s") && !key.endsWith("ss") ? key.slice(0, -1) : `${key}Item`;
}

/** The Fields of several Post Types, each key once (the first Post Type's). */
function uniqueFields(postTypes: readonly PostType[]): FieldDefinition[] {
	const seen = new Map<string, FieldDefinition>();
	for (const postType of postTypes)
		for (const field of postType.fields) if (!seen.has(field.key)) seen.set(field.key, field);
	return [...seen.values()];
}

function record(value: Json): Record<string, Json> {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
