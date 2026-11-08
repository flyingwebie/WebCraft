import { ENTRY_TITLE_MAX_LENGTH, publishPermission, TEXT_VALUE_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** A language tag, such as `en`; the Site decides which it has. */
const language = z.string().min(2).max(35);

/** Field values by key; null or "" clears one. */
const fieldValues = z.record(
	z.string().max(100),
	z
		.string()
		.max(TEXT_VALUE_MAX_LENGTH * 2)
		.nullable(),
);

/** Entries: Content. Members and Staff write them; Editors, Owners and Staff publish them. */
export const entries = {
	/** The Entries of a Post Type, newest first, with their Draft and published values. */
	list: signedIn
		.input(z.object({ siteId: id, postTypeId: id, language: language.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return { entries: await context.services.entries.list(site, input.postTypeId, input.language) };
		}),

	/** One Entry: its built-in Fields (title, slug, status, author, dates), its Draft and its published version. */
	get: signedIn
		.input(z.object({ siteId: id, entryId: id, language: language.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return { entry: await context.services.entries.get(site, input.entryId, input.language) };
		}),

	/** Creates an Entry of a Post Type; its values go into the Draft. A slug is made from the title when none is given. */
	create: signedIn
		.input(
			z.object({
				siteId: id,
				postTypeId: id,
				language: language.optional(),
				title: z.string().trim().min(1).max(ENTRY_TITLE_MAX_LENGTH),
				slug: z.string().max(500).optional(),
				fields: fieldValues.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
			return { entry: await context.services.entries.create(site, input) };
		}),

	/** Saves changes to an Entry's Draft. Visitors see nothing of them until it is published. */
	saveDraft: signedIn
		.input(
			z.object({
				siteId: id,
				entryId: id,
				language: language.optional(),
				title: z
					.string()
					.max(ENTRY_TITLE_MAX_LENGTH * 2)
					.optional(),
				slug: z.string().max(500).optional(),
				fields: fieldValues.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
			const { siteId: _, entryId, ...change } = input;
			return { entry: await context.services.entries.saveDraft(site, entryId, change) };
		}),

	/** Publishes an Entry's Draft: it goes live at once and the Site's page cache is cleared. */
	publish: signedIn.input(z.object({ siteId: id, entryId: id })).handler(async ({ context, input }) => {
		const item = { kind: "entry", id: input.entryId } as const;
		const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
		await context.services.publishing.publish(site, item);
		return { entry: await context.services.entries.get(site, input.entryId) };
	}),
};
