import { isEditPath, STAGING_PASSWORD_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { inAdminSession, onSite, sensitive, signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** A path on a Site: one leading `/`, no query, fragment, backslash or space. */
const sitePath = z.string().max(2000).refine(isEditPath, "A path on the Site, such as /about.");

/**
 * The Staging address (ADR 0014): the Site with all its Drafts, for the people reviewing it. Its
 * Members who reach it, Staff and the Superadmin open it from here; with a staging password, people
 * without an account may see it too.
 */
export const staging = {
	/**
	 * "Staging": a link that opens `path` (the home page unless given) on the Site's Staging address.
	 * It works once, within 60 seconds, for this person and this Site only; following it lets this
	 * browser see the Staging address for at most 8 hours, tied to this admin session (signing out
	 * ends it). Needs `site.view`; `STAGING_UNAVAILABLE` on an Install without a sites domain.
	 */
	open: inAdminSession
		.input(z.object({ siteId: id, path: sitePath.default("/") }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return await context.services.staging.openLink(site, { adminSessionId: context.session.id, path: input.path });
		}),

	/**
	 * The Site's Staging address (`url`, null without a sites domain) and whether it has a staging
	 * password (`password.set`, and when it was last set or removed). Never the password itself.
	 */
	get: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return await context.services.staging.settings(site);
	}),

	/**
	 * Sets the Site's staging password (8 to 200 characters), or removes it (null). People without an
	 * account who give it see the Staging address for a week, or until it changes. Only its hash is
	 * kept. Owners and Staff (`staging.manage`); a Sensitive action; logged `stagingPassword.change`.
	 */
	setPassword: signedIn
		.input(
			z.object({
				siteId: id,
				password: z
					.string()
					.max(STAGING_PASSWORD_MAX_LENGTH * 4)
					.nullable(),
			}),
		)
		.use(onSite("staging.manage"))
		.use(sensitive("stagingPassword.change"))
		.handler(async ({ context, input }) => await context.services.staging.setPassword(context.site, input.password)),
};
