import { publishPermission } from "@webcraft/core";
import { z } from "zod";

import { confirmationInput, confirmedPublish } from "../confirm.ts";
import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** A Filter's or Loop's name; the server checks its form. */
const name = z.string().max(200);

/** Words: a string, or `{ text, translations }` by language tag; the server checks them. */
const words = z.union([
	z.string().max(2_000),
	z.object({
		text: z.string().max(2_000),
		translations: z.record(z.string().max(35), z.string().max(2_000)).optional(),
	}),
	z.null(),
]);

/**
 * A Filter's Draft as given: its parts are checked loosely here, as a shape; the server checks each
 * control against the Loop's Post Types and answers every problem where it is
 * (`controls[2].source.field`).
 */
const version = {
	mode: z.string().max(10).optional(),
	layout: z.string().max(10).optional(),
	phone: z.string().max(10).optional(),
	label: words.optional(),
	applyLabel: words.optional(),
	controls: z
		.array(z.record(z.string().max(100), z.unknown()))
		.max(50)
		.optional(),
};

/**
 * Filters: the controls visitors use to narrow, search and sort the items of one query Loop
 * (`{{@filter shop for="products"}}`). Structure, with a Draft and a published version: Staff build
 * and publish them.
 */
export const filters = {
	/** The Site's Filters, by name. */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { filters: await context.services.filters.list(site) };
	}),

	/** One Filter: its Draft and published version. */
	get: signedIn.input(z.object({ siteId: id, filterId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { filter: await context.services.filters.get(site, input.filterId) };
	}),

	/**
	 * Creates a Filter with its name (how Template markup names it; it never changes) for one query
	 * Loop of the Site (a Loop has one Filter at most), optionally with its controls. It starts as a Draft.
	 */
	create: signedIn.input(z.object({ siteId: id, name, loop: name, ...version })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const { siteId: _, ...filter } = input;
		return { filter: await context.services.filters.create(site, filter) };
	}),

	/**
	 * Saves a Filter's Draft: its mode (live or submit), words and controls (the full list), each part
	 * given replacing that part. Visitors see nothing of it until it is published.
	 */
	saveDraft: signedIn.input(z.object({ siteId: id, filterId: id, ...version })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		const { siteId: _, filterId, ...change } = input;
		return { filter: await context.services.filters.saveDraft(site, filterId, change) };
	}),

	/** Publishes a Filter's Draft: every page showing it changes at once, and the Site's page cache is cleared. */
	publish: signedIn
		.input(z.object({ siteId: id, filterId: id, confirmation: confirmationInput }))
		.use(confirmedPublish((input) => ({ kind: "filter", id: input.filterId })))
		.handler(async ({ context, input }) => {
			const item = { kind: "filter", id: input.filterId } as const;
			const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
			const published = await context.services.publishing.publish(site, item);
			return { published, filter: await context.services.filters.get(site, input.filterId) };
		}),
};
