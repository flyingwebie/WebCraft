import type { FieldDefinition } from "../content/field-types.ts";
import type { PostType } from "../content/post-types.ts";
import type { ContentApiHidden } from "./settings.ts";

/**
 * What a Site's Content API shows of its Structure: every Post Type Staff didn't hide, each with the
 * Fields Staff didn't hide, and the Globals' Fields likewise. Everything the API answers (Entries,
 * Relationships, filters, sorts, search and the schema) reads Post Types and Fields from here only,
 * so what is hidden can't appear anywhere, nor be told apart from what doesn't exist.
 *
 * A Relationship Field points only at exposed Post Types; one that could point at hidden ones alone
 * is left out with them.
 */
export type Exposure = {
	/** The exposed Post Types, in the Site's order, each with its exposed Fields only. */
	postTypes: PostType[];
	byKey(key: string): PostType | undefined;
	byId(id: string): PostType | undefined;
	/** The Globals' exposed Fields. */
	globals: FieldDefinition[];
};

export function exposureOf(
	hidden: ContentApiHidden,
	postTypes: readonly PostType[],
	globals: readonly FieldDefinition[],
): Exposure {
	const shown = postTypes.filter((postType) => !hidden.postTypes.includes(postType.id));
	const keys = new Set(shown.map((postType) => postType.key));
	const exposed = shown.map((postType) => ({
		...postType,
		fields: exposedFields(postType.fields, new Set(hidden.fields[postType.id] ?? []), keys),
	}));
	const byKey = new Map(exposed.map((postType) => [postType.key, postType]));
	const byId = new Map(exposed.map((postType) => [postType.id, postType]));
	return {
		postTypes: exposed,
		byKey: (key) => byKey.get(key),
		byId: (id) => byId.get(id),
		globals: exposedFields(globals, new Set(hidden.globals), keys),
	};
}

function exposedFields(
	fields: readonly FieldDefinition[],
	hidden: ReadonlySet<string>,
	postTypeKeys: ReadonlySet<string>,
	at = "",
): FieldDefinition[] {
	return fields.flatMap((field): FieldDefinition[] => {
		const path = `${at}${field.key}`;
		if (hidden.has(path)) return [];
		if (field.type === "group" || field.type === "repeater") {
			return [{ ...field, fields: exposedFields(field.fields, hidden, postTypeKeys, `${path}.`) }];
		}
		if (field.type === "relationship") {
			const targets = field.postTypes.filter((key) => postTypeKeys.has(key));
			return targets.length === 0 ? [] : [{ ...field, postTypes: targets }];
		}
		return [field];
	});
}
