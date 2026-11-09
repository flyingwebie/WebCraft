import { CONSENT_LAYOUTS, CONSENT_MODES, publishPermission } from "@webcraft/core";
import { z } from "zod";

import { confirmationInput, confirmedPublish } from "../confirm.ts";
import { signedIn } from "../context.ts";
import { fieldValues, language } from "../fields.ts";
import { id } from "../inputs.ts";

/**
 * A Site's Consent banner (ADR 0020). Its setting (mode and layout) is a Site setting: Staff change it
 * (`structure.edit`), it applies at once and is logged. Its words are Content: Members write them in
 * a Draft (`entry.edit`), per language, and publish them (`entry.publish`). Everyone who sees the
 * Site reads it.
 */
export const consentBanner = {
	/** The Site's banner: its mode, layout and version, and its words in `language` (the Default language unless given). */
	get: signedIn.input(z.object({ siteId: id, language: language.optional() })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { banner: await context.services.consent.get(site, input.language) };
	}),

	/** Saves changes to the words' Draft, in one language. Visitors see nothing of them until published. */
	saveDraft: signedIn
		.input(z.object({ siteId: id, language: language.optional(), fields: fieldValues }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
			return {
				banner: await context.services.consent.saveDraft(site, { language: input.language, fields: input.fields }),
			};
		}),

	/** Publishes the words' Draft: every page shows them at once, as a new banner version. */
	publish: signedIn
		.input(z.object({ siteId: id, confirmation: confirmationInput }))
		.use(confirmedPublish(() => ({ kind: "consentBanner" })))
		.handler(async ({ context, input }) => {
			const item = { kind: "consentBanner" } as const;
			const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
			await context.services.publishing.publish(site, item);
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

	/**
	 * One of the Site's Consent records, by the id its visitor's `webcraft.consent` cookie names: the
	 * proof of what they chose. `CONSENT_RECORD_NOT_FOUND` for any other id (records go after 12 months).
	 */
	record: signedIn
		.input(z.object({ siteId: id, recordId: z.string().max(100) }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return { record: await context.services.consent.findRecord(site, input.recordId) };
		}),
};
