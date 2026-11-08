import { postTypes } from "@webcraft/db/schema";
import { asc, eq } from "drizzle-orm";

import { isUniqueViolation } from "../db-errors.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type ContentProblem, PostTypeInvalidError, PostTypeNotFoundError, PostTypeTakenError } from "./errors.ts";
import { UUID } from "./field-types.ts";
import {
	BUILT_IN_FIELDS,
	type BuiltInField,
	type FieldDefinition,
	type FieldInput,
	parseFields,
	RESERVED_FIELD_KEYS,
	storedFields,
} from "./fields.ts";
import { clearPageCache } from "./page-cache.ts";
import { slugify } from "./slugs.ts";
import { parseUrlPattern } from "./url-patterns.ts";

/** A Post Type, as the content store hands it out. */
export type PostType = {
	id: string;
	siteId: string;
	/** Names it in Template markup, the APIs and files, such as `blog`. */
	key: string;
	name: string;
	/** Where its Entries are, such as `/blog/{slug}`. */
	urlPattern: string;
	/** The Fields it adds, in order. */
	fields: FieldDefinition[];
	/** The Fields every Entry has, whatever its Post Type. */
	builtInFields: readonly BuiltInField[];
	createdAt: Date;
	updatedAt: Date;
};

export type NewPostType = {
	name: string;
	/** Made from the name when not given. */
	key?: string;
	urlPattern: string;
	fields?: FieldInput[];
};

/** What can change on a Post Type. Its key can't: Templates, Loops and files name it. */
export type PostTypeChange = { name?: string; urlPattern?: string; fields?: FieldInput[] };

export const POST_TYPE_NAME_MAX_LENGTH = 100;

/** A Post Type key: lower-case letters, digits and dashes, starting with a letter; at most 64. */
const POST_TYPE_KEY = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Creates a Post Type on the scope's Site (open it with `structure.edit`), and records it in the Audit log. */
export async function createPostType(scope: SiteScope, input: NewPostType): Promise<PostType> {
	const problems: ContentProblem[] = [];
	const name = checkName(input.name, problems);
	const key = (input.key ?? slugify(input.name)).trim();
	if (!POST_TYPE_KEY.test(key)) {
		problems.push({
			at: "key",
			message: "A Post Type key is lower-case letters, digits and dashes, starting with a letter (at most 64).",
		});
	}
	const urlPattern = checkUrlPattern(input.urlPattern, problems);
	// A Relationship may point at the Post Type's own Entries.
	const fields = parseFields(input.fields ?? [], problems, await defineContext(scope, key));
	if (problems.length > 0) throw new PostTypeInvalidError(problems);

	return saving(() =>
		scope.transaction(async (tx) => {
			const now = tx.now();
			const row = await tx.insert(postTypes, { key, name, urlPattern, fields, createdAt: now, updatedAt: now });
			await tx.audit("postType.create", { postTypeId: row.id, key, name, urlPattern });
			return toPostType(row);
		}),
	);
}

/**
 * Changes a Post Type (open the Site with `structure.edit`). Post Types have no Draft, so a change
 * applies at once and clears the Site's page cache.
 */
export async function updatePostType(scope: SiteScope, postTypeId: string, change: PostTypeChange): Promise<PostType> {
	const existing = toPostType(await findPostType(scope, postTypeId));
	const problems: ContentProblem[] = [];
	const name = change.name === undefined ? existing.name : checkName(change.name, problems);
	const urlPattern =
		change.urlPattern === undefined ? existing.urlPattern : checkUrlPattern(change.urlPattern, problems);
	const fields =
		change.fields === undefined
			? existing.fields
			: parseFields(change.fields, problems, await defineContext(scope, existing.key), existing.fields);
	if (problems.length > 0) throw new PostTypeInvalidError(problems);

	return saving(() =>
		scope.transaction(async (tx) => {
			const [row] = await tx.update(
				postTypes,
				{ name, urlPattern, fields, updatedAt: tx.now() },
				eq(postTypes.id, existing.id),
			);
			if (!row) throw new PostTypeNotFoundError();
			await clearPageCache(tx);
			await tx.audit("postType.update", {
				postTypeId: existing.id,
				key: existing.key,
				changed: Object.keys(change).filter((setting) => change[setting as keyof PostTypeChange] !== undefined),
			});
			return toPostType(row);
		}),
	);
}

/** What defining a Post Type's Fields needs to know: the Post Types Relationships may point at. */
async function defineContext(scope: Pick<SiteScope, "select">, ownKey: string) {
	const keys = new Set((await listPostTypes(scope)).map((postType) => postType.key));
	keys.add(ownKey);
	return { postTypeKeys: keys, owner: "postType" as const, reservedKeys: RESERVED_FIELD_KEYS };
}

/** The Post Types of the scope's Site, by name. */
export async function listPostTypes(scope: Pick<SiteScope, "select">): Promise<PostType[]> {
	const rows = await scope.select(postTypes, undefined, { orderBy: [asc(postTypes.name), asc(postTypes.key)] });
	return rows.map(toPostType);
}

/** One Post Type of the scope's Site; `PostTypeNotFoundError` when it has none with that id. */
export async function getPostType(scope: Pick<SiteScope, "first">, postTypeId: string): Promise<PostType> {
	return toPostType(await findPostType(scope, postTypeId));
}

async function findPostType(scope: Pick<SiteScope, "first">, postTypeId: string) {
	const row = UUID.test(postTypeId) ? await scope.first(postTypes, eq(postTypes.id, postTypeId)) : undefined;
	if (!row) throw new PostTypeNotFoundError();
	return row;
}

function checkName(input: string, problems: ContentProblem[]): string {
	const name = input.trim();
	if (!name || name.length > POST_TYPE_NAME_MAX_LENGTH) {
		problems.push({ at: "name", message: `A Post Type's name has 1 to ${POST_TYPE_NAME_MAX_LENGTH} characters.` });
	}
	return name;
}

function checkUrlPattern(input: string, problems: ContentProblem[]): string {
	const parsed = parseUrlPattern(input);
	if ("problem" in parsed) {
		problems.push({ at: "urlPattern", message: parsed.problem });
		return input;
	}
	return parsed.pattern;
}

/** Runs a save, turning a duplicate key or URL pattern into `PostTypeTakenError`. */
async function saving<Result>(save: () => Promise<Result>): Promise<Result> {
	try {
		return await save();
	} catch (error) {
		if (isUniqueViolation(error, "post_types_site_id_key_unique")) throw new PostTypeTakenError("key");
		if (isUniqueViolation(error, "post_types_site_id_url_pattern_unique")) throw new PostTypeTakenError("urlPattern");
		throw error;
	}
}

export function toPostType(row: typeof postTypes.$inferSelect): PostType {
	return {
		id: row.id,
		siteId: row.siteId,
		key: row.key,
		name: row.name,
		urlPattern: row.urlPattern,
		fields: storedFields(row.fields),
		builtInFields: BUILT_IN_FIELDS,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Any UUID: ids that can't be one are simply not found, rather than a database error. */
export { UUID };
