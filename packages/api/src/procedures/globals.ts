import { publishPermission } from "@webcraft/core";
import { z } from "zod";

import { confirmationInput, confirmedPublish } from "../confirm.ts";
import { signedIn } from "../context.ts";
import { fieldInputs, fieldValues, language } from "../fields.ts";
import { id } from "../inputs.ts";

/**
 * The Globals: one set of Fields per Site that every Template reads as `site.x`. Staff define the
 * Fields (Structure); Members edit the values in a Draft and publish them (Content).
 */
export const globals = {
	/** The Site's Globals: their Fields, Draft and published values, and what keeps the Draft from being published. */
	get: signedIn.input(z.object({ siteId: id, language: language.optional() })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { globals: await context.services.globals.get(site, input.language) };
	}),

	/** Sets the Globals' Fields: the full list, in order. Applies at once, like a Post Type's Fields. */
	setFields: signedIn.input(z.object({ siteId: id, fields: fieldInputs })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { globals: await context.services.globals.setFields(site, input.fields) };
	}),

	/** Saves changes to the Globals' Draft. Visitors see nothing of them until the Globals are published. */
	saveDraft: signedIn
		.input(z.object({ siteId: id, language: language.optional(), fields: fieldValues }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
			return {
				globals: await context.services.globals.saveDraft(site, { language: input.language, fields: input.fields }),
			};
		}),

	/**
	 * The Globals' Data tab (Staff only): their Draft values as Templates read them (`site.x`, with the
	 * Site's own `site.language` and `site.name`), with the bindings that read each.
	 */
	data: signedIn.input(z.object({ siteId: id, language: language.optional() })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return context.services.globals.data(site, input.language);
	}),

	/** Publishes the Globals' Draft: every page shows the new values at once. */
	publish: signedIn
		.input(z.object({ siteId: id, confirmation: confirmationInput }))
		.use(confirmedPublish(() => ({ kind: "globals" })))
		.handler(async ({ context, input }) => {
			const item = { kind: "globals" } as const;
			const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
			await context.services.publishing.publish(site, item);
			return { globals: await context.services.globals.get(site) };
		}),
};
