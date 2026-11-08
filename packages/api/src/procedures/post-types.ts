import { FIELD_LABEL_MAX_LENGTH, FIELD_TYPES, MAX_FIELDS, POST_TYPE_NAME_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** A Field as Staff define it; the server checks keys, labels and types. */
const field = z.object({
	key: z.string().max(100),
	label: z.string().max(FIELD_LABEL_MAX_LENGTH * 2),
	type: z.enum(FIELD_TYPES),
	translatable: z.boolean().optional(),
	required: z.boolean().optional(),
});

const fields = z.array(field).max(MAX_FIELDS);

/** Post Types: the kinds of Entry a Site holds, with a URL pattern and Fields. Structure: Staff change them. */
export const postTypes = {
	/** The Post Types of a Site. Everyone who can see the Site sees them, to write Entries. */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { postTypes: await context.services.postTypes.list(site) };
	}),

	/** One Post Type, with its Fields and the built-in Fields every Entry has. */
	get: signedIn.input(z.object({ siteId: id, postTypeId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { postType: await context.services.postTypes.get(site, input.postTypeId) };
	}),

	/** Creates a Post Type with its URL pattern (`/blog/{slug}`) and Fields. */
	create: signedIn
		.input(
			z.object({
				siteId: id,
				name: z.string().max(POST_TYPE_NAME_MAX_LENGTH * 2),
				key: z.string().max(100).optional(),
				urlPattern: z.string().max(500),
				fields: fields.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { postType: await context.services.postTypes.create(site, input) };
		}),

	/**
	 * Changes a Post Type's name, URL pattern or Fields (the full list, in order). It applies at once:
	 * Post Types have no Draft, so the Site's page cache is cleared.
	 */
	update: signedIn
		.input(
			z.object({
				siteId: id,
				postTypeId: id,
				name: z
					.string()
					.max(POST_TYPE_NAME_MAX_LENGTH * 2)
					.optional(),
				urlPattern: z.string().max(500).optional(),
				fields: fields.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, postTypeId, ...change } = input;
			return { postType: await context.services.postTypes.update(site, postTypeId, change) };
		}),
};
