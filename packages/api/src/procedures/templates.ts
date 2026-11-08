import { publishPermission } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** Templates: Structure, stored as element trees with a Draft and a published version. Staff change and publish them. */
export const templates = {
	/** A Post Type's Entry template, or null while it has none. */
	getEntryTemplate: signedIn.input(z.object({ siteId: id, postTypeId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { template: await context.services.templates.entryTemplate(site, input.postTypeId) };
	}),

	/**
	 * Saves the Draft of a Post Type's Entry template as an element tree, creating the template the
	 * first time. Refused with the problems listed when the tree isn't one WebCraft may store.
	 */
	saveEntryTemplate: signedIn
		.input(z.object({ siteId: id, postTypeId: id, tree: z.unknown() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { template: await context.services.templates.saveEntryTemplate(site, input.postTypeId, input.tree) };
		}),

	/** Publishes a Template's Draft: every page it renders changes at once, and the Site's page cache is cleared. */
	publish: signedIn.input(z.object({ siteId: id, templateId: id })).handler(async ({ context, input }) => {
		const item = { kind: "template", id: input.templateId } as const;
		const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
		const published = await context.services.publishing.publish(site, item);
		return { published };
	}),
};
