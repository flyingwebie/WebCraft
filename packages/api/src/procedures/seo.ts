import { AI_CRAWLER_SETTINGS, ORGANIZATION_KINDS, ROBOTS_LINES_MAX, SAME_AS_MAX } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/**
 * A Site's SEO settings: the name titles give the Site, the separator title patterns use, the social
 * image of pages without one, the organisation its structured data names, Staff's own robots.txt
 * lines and the AI crawler setting. Site settings (Structure): Staff change them (`structure.edit`),
 * Owners too for the AI crawler setting (`aiCrawlers.manage`); they apply at once and are logged.
 * Everyone who sees the Site reads them.
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
	 * come from) and `robotsLines`, Staff's own robots.txt lines (`User-agent`, `Allow`, `Disallow`,
	 * `Crawl-delay`, `Sitemap` and `#` comments; "" for none). Refused with `SEO_SETTINGS_INVALID`,
	 * each problem at its place.
	 */
	update: signedIn
		.input(
			z.object({
				siteId: id,
				socialCards: z.object({ enabled: z.boolean().optional(), layout: z.string().max(100).optional() }).optional(),
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
				robotsLines: z
					.string()
					.max(ROBOTS_LINES_MAX.characters * 2)
					.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, ...change } = input;
			return { settings: await context.services.seo.updateSettings(site, change) };
		}),

	/**
	 * Chooses what the Site's robots.txt says to AI crawlers (spec story 119): `allowAll`,
	 * `allowSearch` (AI search and answer engines in, crawlers collecting for training out) or
	 * `blockAll` (every AI crawler out; search engines are never affected). Staff and Owners
	 * (`aiCrawlers.manage`); it applies at once and is logged.
	 */
	setAiCrawlers: signedIn
		.input(z.object({ siteId: id, aiCrawlers: z.enum(AI_CRAWLER_SETTINGS) }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "aiCrawlers.manage");
			return { settings: await context.services.seo.setAiCrawlers(site, input.aiCrawlers) };
		}),
};
