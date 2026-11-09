import { CONSENT_LAYOUTS, CONSENT_MODES } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/**
 * A Site's Consent banner (ADR 0020). Its setting (mode and layout) is a Site setting: Staff change it
 * (`structure.edit`), it applies at once and is logged. Everyone who sees the Site reads it.
 */
export const consentBanner = {
	/** The Site's banner: its mode, layout and version. */
	get: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { banner: await context.services.consent.get(site) };
	}),

	/**
	 * Changes how the Site asks for consent (`optIn`, `optOut`, `none`, `outside`) and how the banner
	 * shows (`bar`, `box`, `dialog`). Applies at once and makes a new banner version.
	 */
	setSettings: signedIn
		.input(z.object({ siteId: id, mode: z.enum(CONSENT_MODES), layout: z.enum(CONSENT_LAYOUTS) }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return {
				banner: await context.services.consent.setSettings(site, { mode: input.mode, layout: input.layout }),
			};
		}),
};
