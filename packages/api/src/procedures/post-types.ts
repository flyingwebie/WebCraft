import { POST_TYPE_NAME_MAX_LENGTH, SEARCH_WEIGHTS, SEARCHED_FIELDS_MAX } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { fieldInputs as fields, language } from "../fields.ts";
import { id } from "../inputs.ts";

/**
 * Searched fields: what Site search (and Filters' search boxes) look in, each with a weight from A
 * (counts most) to D: `title` or a Field's path (`summary`, `origin.city`, `steps.text`).
 */
const searchedFields = z
	.array(z.object({ field: z.string().max(300), weight: z.enum(SEARCH_WEIGHTS) }))
	.max(SEARCHED_FIELDS_MAX * 2);

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
				searchable: z.boolean().optional(),
				searchedFields: searchedFields.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { postType: await context.services.postTypes.create(site, input) };
		}),

	/**
	 * Changes a Post Type's name, URL pattern, Fields (the full list, in order), whether Site search
	 * shows its Entries, or its Searched fields (the full list). It applies at once: Post Types have no
	 * Draft, so the Site's page cache is cleared; a change to what is searched rebuilds the Site's
	 * search index in the background.
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
				searchable: z.boolean().optional(),
				searchedFields: searchedFields.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, postTypeId, ...change } = input;
			return { postType: await context.services.postTypes.update(site, postTypeId, change) };
		}),

	/**
	 * The Data tab of a Post Type's Entry template (Staff only): one of its Entries from the Draft (the
	 * one given, or the one saved last) as JSON shaped the way the template reads it, with the bindings
	 * Template markup writes to read each value.
	 */
	data: signedIn
		.input(z.object({ siteId: id, postTypeId: id, entryId: id.optional(), language: language.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.postTypes.data(site, input.postTypeId, {
				language: input.language,
				entryId: input.entryId,
			});
		}),
};
