import { LOOP_ITEMS_MAX, publishPermission } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { fieldInputs, language } from "../fields.ts";
import { id } from "../inputs.ts";

/** A Loop's name; the server checks its form. */
const loopName = z.string().max(200);

const source = z.enum(["query", "items"]);

/**
 * A query as given: its settings are checked loosely here, as a shape; the server checks each one
 * against the Site's Post Types and answers every problem where it is (`query.filters[1].value`).
 */
const query = z.object({
	postTypes: z.array(z.string().max(100)).max(100).optional(),
	match: z.string().max(10).optional(),
	filters: z.array(z.unknown()).max(100).optional(),
	sort: z.array(z.unknown()).max(20).optional(),
	limit: z.number().optional(),
	offset: z.number().optional(),
	paginate: z.boolean().optional(),
	excludeCurrent: z.boolean().optional(),
});

/** Loop items as given: each `{ id?, …values }`, as a Repeater's rows. */
const items = z.array(z.record(z.string().max(100), z.unknown())).max(LOOP_ITEMS_MAX * 5);

/**
 * Loops: repeated parts of a Site, placed in Templates and Components by name
 * (`{{@loop latest-posts as post}} … {{@empty}} … {{/loop}}`). Structure, with a Draft and a
 * published version: Staff define and publish them. Their Loop items are Content.
 */
export const loops = {
	/** The Site's Loops, by name. */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { loops: await context.services.loops.list(site) };
	}),

	/** One Loop: its Draft and published version, its Loop items in a language (the Default language unless given). */
	get: signedIn
		.input(z.object({ siteId: id, loopId: id, language: language.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { loop: await context.services.loops.get(site, input.loopId, input.language) };
		}),

	/**
	 * Creates a Loop with its name (how Template markup names it; it never changes), where its items
	 * come from, and optionally its query or its Loop items' Fields. It starts as a Draft.
	 */
	create: signedIn
		.input(z.object({ siteId: id, name: loopName, source, query: query.optional(), fields: fieldInputs.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, ...loop } = input;
			return { loop: await context.services.loops.create(site, loop) };
		}),

	/**
	 * Saves a Loop's Draft: where its items come from, its query (settings left out take their
	 * defaults) and its Loop items' Fields (the full list), each part given replacing that part.
	 * Visitors see nothing of it until it is published.
	 */
	saveDraft: signedIn
		.input(
			z.object({
				siteId: id,
				loopId: id,
				source: source.optional(),
				query: query.optional(),
				fields: fieldInputs.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, loopId, ...change } = input;
			return { loop: await context.services.loops.saveDraft(site, loopId, change) };
		}),

	/**
	 * Saves a Loop's items in its Draft, in one language: the whole list, in order, each with the
	 * `id` it had (keeping its values in other languages) or none for a new one. Loop items are Content.
	 */
	saveItems: signedIn
		.input(z.object({ siteId: id, loopId: id, language: language.optional(), items }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
			return {
				loop: await context.services.loops.saveItems(site, input.loopId, {
					language: input.language,
					items: input.items,
				}),
			};
		}),

	/** Publishes a Loop's Draft: every page showing it changes at once, and the Site's page cache is cleared. */
	publish: signedIn.input(z.object({ siteId: id, loopId: id })).handler(async ({ context, input }) => {
		const item = { kind: "loop", id: input.loopId } as const;
		const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
		const published = await context.services.publishing.publish(site, item);
		return { published, loop: await context.services.loops.get(site, input.loopId) };
	}),
};
