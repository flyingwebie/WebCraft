import { ORGANIZATION_KINDS, SAME_AS_MAX } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/**
 * A Site's SEO settings: the name titles give the Site, the separator title patterns use, the social
 * image of pages without one, and the organisation its structured data names. A Site setting
 * (Structure): Staff change them (`structure.edit`), they apply at once and are logged. Everyone who
 * sees the Site reads them.
 */
export const seoSettings = {
	get: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { settings: await context.services.seo.settings(site) };
	}),

	/**
	 * Changes the settings given (the organisation part by part): `siteName` (null for the Site's own
	 * name), `separator`, `defaultImage` (a Media image's id, null for none) and `organization` (its
	 * `kind`, `name`, `logo`, `sameAs` addresses and the Globals its `telephone`, `email` and `address`
	 * come from). Refused with `SEO_SETTINGS_INVALID`, each problem at its place.
	 */
	update: signedIn
		.input(
			z.object({
				siteId: id,
				siteName: z.string().max(1_000).nullable().optional(),
				separator: z.string().max(100).optional(),
				defaultImage: z.string().max(100).nullable().optional(),
				organization: z
					.object({
						kind: z.enum(ORGANIZATION_KINDS).optional(),
						name: z.string().max(1_000).nullable().optional(),
						logo: z.string().max(100).nullable().optional(),
						sameAs: z
							.array(z.string().max(2_000))
							.max(SAME_AS_MAX * 2)
							.optional(),
						telephone: z.string().max(300).nullable().optional(),
						email: z.string().max(300).nullable().optional(),
						address: z.string().max(300).nullable().optional(),
					})
					.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, ...change } = input;
			return { settings: await context.services.seo.updateSettings(site, change) };
		}),
};
