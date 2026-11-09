/**
 * A Module source's Import settings: where each type of item goes (a Post Type, a Post Type the run
 * creates, the Media library, or nowhere) and where each of its keys goes (the title, the slug, a
 * Field, a Field the run adds, an SEO field, or nowhere), in one of the Site's languages. They are
 * checked against the Site, and against what the file holds once it is surveyed (a key's kind of
 * value must suit where it goes).
 *
 * `suggestedSettings` makes the first mapping the Map step shows, from the survey and the Site's Post
 * Types, by generic patterns only: names that match, the kind of each value, `seo`/`meta` with
 * `title` or `desc` in a key's name, keys starting with `_` (a system's own) skipped.
 */
import { z } from "zod";
import type { ContentProblem } from "../content/errors.ts";
import { PostTypeNotFoundError } from "../content/errors.ts";
import type { FieldDefinition, FieldInput, LeafField } from "../content/field-types.ts";
import { parseFields, RESERVED_FIELD_KEYS } from "../content/fields.ts";
import { languagesFor, siteLanguages } from "../content/languages.ts";
import { isPagePostType, PAGE_BUILT_IN_FIELDS } from "../content/pages.ts";
import { getPostType, listPostTypes, type PostType } from "../content/post-types.ts";
import { slugify } from "../content/slugs.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { ImportInvalidError, type ImportSettingProblem } from "./errors.ts";
import type { ItemDestination } from "./items.ts";
import { NEW_FIELD_TYPES, SOURCE_KEY_TARGETS, takes } from "./source-rules.ts";
import type { SourceSurvey, SurveyKey } from "./survey.ts";

export { NEW_FIELD_TYPES, SOURCE_KEY_TARGETS, takes };

const FIELD_KEY = /^[a-z][A-Za-z0-9_]{0,63}$/;

/** A Field the run adds to the Post Type for a key (a Relationship's `to`: the source type its Entries are). */
const newFieldSchema = z.object({
	key: z.string().regex(FIELD_KEY),
	label: z.string().trim().min(1).max(100),
	type: z.enum(NEW_FIELD_TYPES),
	to: z.string().min(1).max(100).optional(),
});

const keyTargetSchema = z.union([
	z.enum(SOURCE_KEY_TARGETS),
	z.string().regex(/^fields\.[a-z][A-Za-z0-9_]{0,63}$/),
	z.object({ newField: newFieldSchema }),
]);

export const sourceSettingsSchema = z.object({
	/** One of the Site's languages; null for its Default language. */
	language: z.string().min(2).max(35).nullable(),
	types: z
		.array(
			z.object({
				type: z.string().trim().min(1).max(100),
				to: z.union([
					z.object({ postTypeId: z.uuid() }),
					z.object({ newPostType: z.object({ name: z.string().trim().min(1).max(100) }) }),
					z.literal("media"),
					z.null(),
				]),
				keys: z.array(z.object({ key: z.string().min(1).max(300), to: keyTargetSchema.nullable() })).max(1000),
			}),
		)
		.max(200),
});

export type SourceSettings = z.infer<typeof sourceSettingsSchema>;
export type SourceKeyTarget = z.infer<typeof keyTargetSchema>;
export type NewFieldTarget = z.infer<typeof newFieldSchema>;

/** Where one key's values go. */
export type KeyTarget =
	| { kind: "title" }
	| { kind: "slug" }
	| { kind: "seo"; part: "title" | "description" | "canonical" | "noindex" | "image" }
	| { kind: "field"; field: LeafField; isNew: boolean };

/** Where one type's items go when they become Entries. */
export type EntryTypeTarget = {
	type: string;
	destination: ItemDestination;
	/** A Post Type the run creates, with its key and URL pattern; null for one the Site has. */
	planned: { name: string; key: string; urlPattern: string } | null;
	/** The Fields the run adds to the Post Type (all of a planned one's). */
	newFields: FieldInput[];
	keys: Map<string, KeyTarget>;
};

/** Import settings checked against the Site: what a run, a preview or a sample needs. */
export type SourceMapping = {
	languages: { language: string; defaultLanguage: string };
	entries: Map<string, EntryTypeTarget>;
	/** Types whose files go into the Media library. */
	media: Set<string>;
	/** The Site's Post Types' ids by key, planned ones too. */
	postTypeIds: Map<string, string>;
};

/** The id a Post Type the run will create has until it does. */
export function plannedId(type: string): string {
	return `planned:${type}`;
}

/**
 * Checks a source's Import settings against the scope's Site (and the file's survey, when given):
 * Post Types and Fields it has, Fields the run adds that fit, each key's kind of value suited to where
 * it goes. Throws `ImportInvalidError` with every problem, each at its place.
 */
export async function sourceMapping(
	scope: SiteScope,
	settings: SourceSettings,
	survey: SourceSurvey | null,
): Promise<SourceMapping> {
	const problems: ImportSettingProblem[] = [];
	const site = await siteLanguages(scope);
	const languages = languagesFor(site, settings.language ?? undefined);
	if (!languages) {
		problems.push({
			at: "settings.language",
			rule: "languageUnknown",
			message: `The Site has no language ${settings.language}.`,
			params: { language: settings.language },
		});
	}
	const existing = await listPostTypes(scope);
	const keys = new Set(existing.map((postType) => postType.key));
	const patterns = new Set(existing.map((postType) => postType.urlPattern));
	const postTypeIds = new Map(existing.map((postType) => [postType.key, postType.id]));
	const mapping: SourceMapping = {
		languages: languages ?? { language: site.defaultLanguage, defaultLanguage: site.defaultLanguage },
		entries: new Map(),
		media: new Set(),
		postTypeIds,
	};
	const surveyed = new Map((survey?.types ?? []).map((type) => [type.key, type]));
	const typeTwice = new Set<string>();

	// Where each type goes first, so a Relationship can name a type a later entry maps.
	const destinations = new Map<string, { postType: PostType; planned: EntryTypeTarget["planned"] }>();
	for (const [index, mapped] of settings.types.entries()) {
		const at = `settings.types[${index}]`;
		if (typeTwice.has(mapped.type)) {
			problems.push({ at: `${at}.type`, rule: "typeTwice", message: `The type ${mapped.type} is mapped twice.` });
			continue;
		}
		typeTwice.add(mapped.type);
		const holds = surveyed.get(mapped.type)?.holds;
		if (mapped.to === null) continue;
		if (mapped.to === "media") {
			if (holds === "entries") {
				problems.push({ at: `${at}.to`, rule: "typeKind", message: `${mapped.type} holds Entries, not files.` });
			} else mapping.media.add(mapped.type);
			continue;
		}
		if (holds === "media") {
			problems.push({
				at: `${at}.to`,
				rule: "typeKind",
				message: `${mapped.type} holds files: they go into the Media library.`,
			});
			continue;
		}
		if ("postTypeId" in mapped.to) {
			try {
				destinations.set(mapped.type, { postType: await getPostType(scope, mapped.to.postTypeId), planned: null });
			} catch (error) {
				if (!(error instanceof PostTypeNotFoundError)) throw error;
				problems.push({
					at: `${at}.to.postTypeId`,
					rule: "postTypeNotFound",
					message: "The Site has no such Post Type.",
				});
			}
			continue;
		}
		const name = mapped.to.newPostType.name;
		let key = slugify(name).slice(0, 60).replace(/-+$/, "") || "imported";
		if (!/^[a-z]/.test(key)) key = `t-${key}`;
		for (let n = 2; keys.has(key); n++) key = `${key.replace(/-\d+$/, "")}-${n}`;
		keys.add(key);
		let urlPattern = `/${key}/{slug}`;
		for (let n = 2; patterns.has(urlPattern); n++) urlPattern = `/${key}-${n}/{slug}`;
		patterns.add(urlPattern);
		postTypeIds.set(key, plannedId(mapped.type));
		destinations.set(mapped.type, {
			postType: plannedPostType(scope, mapped.type, name, key, urlPattern),
			planned: { name, key, urlPattern },
		});
	}

	for (const [index, mapped] of settings.types.entries()) {
		const destination = destinations.get(mapped.type);
		if (!destination || !languages) continue;
		const { postType, planned } = destination;
		const at = `settings.types[${index}]`;
		const target: EntryTypeTarget = {
			type: mapped.type,
			destination: { postType, languages, match: null },
			planned,
			newFields: [],
			keys: new Map(),
		};
		const kindOf = (key: string) => surveyed.get(mapped.type)?.keys.find((each) => each.key === key)?.kind;
		const taken = new Set<string>(postType.fields.map((field) => field.key));
		const used = new Set<string>();
		let bodies = postType.fields.filter((field) => field.type === "body").length;
		for (const [keyIndex, { key, to }] of mapped.keys.entries()) {
			const here = `${at}.keys[${keyIndex}].to`;
			if (to === null) continue;
			const kind = kindOf(key);
			const refuse = (rule: string, message: string, params?: Record<string, unknown>) =>
				problems.push({ at: here, rule, message, ...(params ? { params } : {}) });
			if (typeof to === "string") {
				if (!to.startsWith("fields.")) {
					if (kind && !takes(to, kind)) {
						refuse("keyKind", `${key} can't go into ${to}.`, { key, to });
						continue;
					}
					if (used.has(to)) {
						refuse("targetTwice", `Two keys go into ${to}.`, { to });
						continue;
					}
					used.add(to);
					target.keys.set(
						key,
						to === "title"
							? { kind: "title" }
							: to === "slug"
								? { kind: "slug" }
								: { kind: "seo", part: to.slice("seo.".length) as Extract<KeyTarget, { kind: "seo" }>["part"] },
					);
					continue;
				}
				const fieldKey = to.slice("fields.".length);
				const field = postType.fields.find((candidate) => candidate.key === fieldKey);
				if (!field) {
					refuse("targetUnknown", `The Post Type has no Field ${fieldKey}.`, { to });
					continue;
				}
				if (field.type === "group" || field.type === "repeater") {
					refuse("targetNotLeaf", `${fieldKey} can't take a key: map its Fields one by one.`, { to });
					continue;
				}
				if (kind && !takes(field.type, kind)) {
					refuse("keyKind", `${key} can't go into ${fieldKey}.`, { key, to });
					continue;
				}
				if (used.has(to)) {
					refuse("targetTwice", `Two keys go into ${to}.`, { to });
					continue;
				}
				used.add(to);
				target.keys.set(key, { kind: "field", field: field as LeafField, isNew: false });
				continue;
			}
			const wanted = to.newField;
			if (kind && !takes(wanted.type, kind)) {
				refuse("keyKind", `${key} can't go into a new ${wanted.type} Field.`, { key, type: wanted.type });
				continue;
			}
			if (
				taken.has(wanted.key) ||
				RESERVED_FIELD_KEYS.has(wanted.key) ||
				(isPagePostType(postType) && wanted.key === "parent")
			) {
				refuse("fieldKeyTaken", `The Post Type has a Field ${wanted.key} already, or the key is reserved.`, {
					key: wanted.key,
				});
				continue;
			}
			if (wanted.type === "body" && (bodies > 0 || isPagePostType(postType))) {
				refuse(
					isPagePostType(postType) ? "bodyOnPage" : "bodyTwice",
					isPagePostType(postType)
						? "Pages have no Body field: a rich text Field takes their content."
						: "A Post Type has one Body field.",
				);
				continue;
			}
			let input: FieldInput = { key: wanted.key, label: wanted.label, type: wanted.type };
			if (wanted.type === "date") input = { ...input, mode: "dateTime" };
			if (wanted.type === "relationship") {
				const related = wanted.to ? destinations.get(wanted.to) : undefined;
				if (!related) {
					refuse("relationshipTarget", "A new Relationship points at the Post Type a mapped type goes into.", {
						to: wanted.to ?? null,
					});
					continue;
				}
				input = { ...input, postTypes: [related.postType.key], multiple: true };
			}
			const parsed: ContentProblem[] = [];
			const [field] = parseFields([input], parsed, {
				postTypeKeys: new Set(postTypeIds.keys()),
				owner: isPagePostType(postType) ? "page" : "postType",
				reservedKeys: RESERVED_FIELD_KEYS,
			});
			if (!field || parsed.length > 0) {
				refuse("fieldInvalid", parsed[0]?.message ?? "That Field can't be added.");
				continue;
			}
			taken.add(wanted.key);
			if (wanted.type === "body") bodies++;
			target.newFields.push(input);
			target.keys.set(key, { kind: "field", field: field as LeafField, isNew: true });
		}
		if (planned) {
			const fields =
				target.keys.size === 0
					? []
					: [...target.keys.values()].flatMap((each) => (each.kind === "field" ? [each.field] : []));
			target.destination = { ...target.destination, postType: { ...postType, fields: fields as FieldDefinition[] } };
		} else if (target.newFields.length > 0) {
			const added = [...target.keys.values()].flatMap((each) =>
				each.kind === "field" && each.isNew ? [each.field] : [],
			);
			target.destination = { ...target.destination, postType: { ...postType, fields: [...postType.fields, ...added] } };
		}
		mapping.entries.set(mapped.type, target);
	}
	if (problems.length > 0) throw new ImportInvalidError(problems);
	return mapping;
}

/** A Post Type the run will create, as the preview pictures it before it exists. */
function plannedPostType(scope: SiteScope, type: string, name: string, key: string, urlPattern: string): PostType {
	const now = scope.now();
	return {
		id: plannedId(type),
		siteId: scope.site.id,
		key,
		name,
		builtIn: null,
		urlPattern,
		fields: [],
		builtInFields: PAGE_BUILT_IN_FIELDS.filter((field) => field !== "parent"),
		searchable: true,
		searchedFields: [],
		seo: {} as PostType["seo"],
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * The mapping the Map step starts from (see the module's comment): each type into the Site's Post
 * Type of the same key or name (Pages into the Page Post Type), else into a new one, files into the
 * Media library; each key into the title, the slug, a Field of the same name or kind, an SEO field,
 * or a new Field.
 */
export function suggestedSettings(survey: SourceSurvey, postTypes: readonly PostType[]): SourceSettings {
	const destinations = new Map<string, PostType | null>();
	for (const type of survey.types) {
		if (type.holds === "media") continue;
		const words = [type.key, type.label].map(normal);
		const found =
			postTypes.find(
				(postType) => isPagePostType(postType) && words.some((word) => word === "page" || word === "pages"),
			) ?? postTypes.find((postType) => words.includes(normal(postType.key)) || words.includes(normal(postType.name)));
		destinations.set(type.key, found ?? null);
	}
	return {
		language: null,
		types: survey.types.map((type) => {
			if (type.holds === "media") return { type: type.key, to: "media" as const, keys: [] };
			const postType = destinations.get(type.key) ?? null;
			const fields = postType?.fields ?? [];
			const used = new Set<string>();
			const newKeys = new Set(fields.map((field) => field.key));
			let hasBody = fields.some((field) => field.type === "body");
			const keys = type.keys.map(({ key, kind }) => {
				const to = suggestedTarget(key, kind);
				return { key, to };
			});
			function suggestedTarget(key: string, kind: SurveyKey["kind"]): SourceKeyTarget | null {
				const claim = (target: string) => {
					if (used.has(target)) return null;
					used.add(target);
					return target as SourceKeyTarget;
				};
				if (kind === "title") return claim("title");
				if (kind === "slug") return claim("slug");
				const name = normal(key);
				// Built-in fields of a page's search card, by the generic names systems give them.
				if (kind === "text" && /seo|meta/.test(name)) {
					if (/title/.test(name)) return claim("seo.title");
					if (/desc/.test(name)) return claim("seo.description");
				}
				if (kind === "text" && /canonical/.test(name)) return claim("seo.canonical");
				if (kind === "text" && /noindex/.test(name)) return claim("seo.noindex");
				const same = fields.find(
					(field) =>
						(normal(field.key) === name || normal(field.label) === name) &&
						field.type !== "group" &&
						field.type !== "repeater" &&
						takes(field.type, kind),
				);
				if (same) return claim(`fields.${same.key}`);
				if (kind === "html" && /content|body/.test(name)) {
					const body = fields.find((field) => field.type === "body");
					if (body) return claim(`fields.${body.key}`);
				}
				if (kind === "items") {
					const related = destinations.get(key.replace(/^terms:/, ""));
					const relatedType = survey.types.find((each) => each.key === key.replace(/^terms:/, ""));
					if (related === undefined || !relatedType) return null;
					const existing = fields.find(
						(field) => field.type === "relationship" && related !== null && field.postTypes.includes(related.key),
					);
					if (existing) return claim(`fields.${existing.key}`);
					return newField(relatedType.label, "relationship", relatedType.key);
				}
				if (kind === "file") {
					const media = fields.find((field) => field.type === "media");
					return media ? claim(`fields.${media.key}`) : newField("Image", "media");
				}
				// A system's own keys (`_edit_lock`) are skipped.
				if (key.startsWith("_")) return null;
				if (kind === "html") {
					if (/content|body/.test(name)) {
						if (postType && isPagePostType(postType)) return newField("Content", "richText");
						if (!hasBody) {
							hasBody = true;
							return newField("Body", "body");
						}
						return newField(labelOf(key), "richText");
					}
					return newField(labelOf(key), "text");
				}
				if (kind === "date") {
					if (/modif|updat/.test(name)) return null;
					return newField(/^date$/.test(name) ? "Published" : labelOf(key), "date");
				}
				if (/author/.test(name)) return newField("Author name", "text");
				return newField(labelOf(key), "text");
			}
			function newField(label: string, fieldType: NewFieldTarget["type"], to?: string): SourceKeyTarget {
				let key = fieldKeyOf(label);
				for (let n = 2; newKeys.has(key) || RESERVED_FIELD_KEYS.has(key) || key === "parent"; n++) {
					key = `${fieldKeyOf(label)}_${n}`;
				}
				newKeys.add(key);
				return { newField: { key, label, type: fieldType, ...(to ? { to } : {}) } };
			}
			return {
				type: type.key,
				to: postType ? { postTypeId: postType.id } : { newPostType: { name: type.label } },
				keys,
			};
		}),
	};
}

/** A name compared loosely: lower case, letters and digits only. */
function normal(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** A key as a Field's label: `serves_people` is "Serves people". */
function labelOf(key: string): string {
	const words = key
		.replace(/^terms:/, "")
		.replace(/[_\-:]+/g, " ")
		.trim();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Value";
}

/** A Field key made from a label: `Author name` is `author_name`. */
function fieldKeyOf(label: string): string {
	const key = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 60);
	return /^[a-z]/.test(key) ? key : `field_${key}`.replace(/_+$/, "");
}
