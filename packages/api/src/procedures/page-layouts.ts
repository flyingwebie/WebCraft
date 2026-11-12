import { configureLayout, getPageLayout, layoutSettings } from "@webcraft/core";
import { z } from "zod";
import { signedIn } from "../context.ts";
import { language } from "../fields.ts";
import { id } from "../inputs.ts";

export const pageLayouts = {
	settings: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const scope = await context.services.data.site(context.access, input.siteId, "site.view");
		return layoutSettings(scope);
	}),
	configure: signedIn
		.input(
			z.object({
				siteId: id,
				enabled: z.boolean().optional(),
				allowedComponents: z.array(z.string().max(100)).max(1000).optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const scope = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, ...change } = input;
			return configureLayout(scope, change);
		}),
	get: signedIn
		.input(z.object({ siteId: id, entryId: id, language: language.optional() }))
		.handler(async ({ context, input }) => {
			const scope = await context.services.data.site(context.access, input.siteId, "site.view");
			return getPageLayout(scope, input.entryId, input.language);
		}),
	save: signedIn
		.input(
			z.object({
				siteId: id,
				entryId: id,
				language: language.optional(),
				layout: z.unknown(),
				basedOn: z.string().min(1).max(100),
			}),
		)
		.handler(async ({ context, input }) => {
			const scope = await context.services.data.site(context.access, input.siteId, "entry.edit");
			return scope.transaction(async (tx) => {
				await context.services.entries.saveDraft(tx, input.entryId, {
					layout: input.layout,
					layoutBasedOn: input.basedOn,
				});
				return getPageLayout(tx, input.entryId, input.language);
			});
		}),
};
