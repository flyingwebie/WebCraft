import { z } from "zod";
import { signedIn } from "../context.ts";
import { language } from "../fields.ts";
import { id } from "../inputs.ts";
export const checks = {
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const scope = await context.services.data.site(context.access, input.siteId, "site.view");
		return { checks: await context.services.checks.list(scope) };
	}),
	entry: signedIn
		.input(z.object({ siteId: id, entryId: id, language: language.optional() }))
		.handler(async ({ context, input }) => {
			const scope = await context.services.data.site(context.access, input.siteId, "site.view");
			return { checks: await context.services.checks.entry(scope, input.entryId, input.language) };
		}),
};
