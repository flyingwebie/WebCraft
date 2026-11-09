import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** One item to publish, as Publish all ticks it. */
const publishItem = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("entry"), id }),
	z.object({ kind: z.literal("template"), id }),
	z.object({ kind: z.literal("component"), id }),
	z.object({ kind: z.literal("loop"), id }),
	z.object({ kind: z.literal("script"), id }),
	z.object({ kind: z.literal("form"), id }),
	z.object({ kind: z.literal("globals") }),
	z.object({ kind: z.literal("consentBanner") }),
	z.object({ kind: z.literal("designSystem") }),
]);

/** The most items one Publish all takes. */
const PUBLISH_ALL_MAX_ITEMS = 1000;

/**
 * Publish all (ADR 0014): every Draft of a Site, reviewed together, and the ticked ones published in
 * one go. Content (Entries, the Globals, the Consent banner's words) needs `entry.publish`: Editors,
 * Owners and Staff; Structure (Templates, Components, Loops, scripts, Forms, the Design system) needs
 * `structure.edit`: Staff only. Publishing one item on its own stays with each item's `publish`.
 */
export const publishing = {
	/**
	 * Every Draft of the Site: Content first (Entries, newest change first, the Globals, the Consent
	 * banner's words), then Structure (the Design system, Components, Loops, Forms, Templates,
	 * scripts). Each says what changed (`changes`), who changed it last and when, whether the person
	 * may publish it (`canPublish`), and for an Entry where it shows on the Staging address (`path`).
	 * `count` is how many the person may publish. Anyone who sees the Site may look.
	 */
	drafts: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		const drafts = await context.services.publishing.drafts(site);
		return { drafts, count: drafts.filter((draft) => draft.canPublish).length };
	}),

	/** How many of the Site's Drafts the person may publish: what the admin shows beside Publish all. */
	count: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { count: await context.services.publishing.count(site) };
	}),

	/**
	 * Publishes the ticked Drafts together, in two calls. The first publishes nothing: it answers the
	 * items in the order they would go live (`preview.items`) and a `confirmation` id, valid for 5
	 * minutes. Calling again with the same items and that id publishes them, all or none, in one
	 * transaction (the Site's page cache is cleared once; each item is logged, and fires its Webhooks
	 * and Module events, as publishing it alone does; then `site.publishAll` is logged), and answers
	 * what was published. Refused: an item that is no Draft of the Site (`PUBLISH_ALL_INVALID`,
	 * `data.items`), one the person may not publish (`FORBIDDEN`), an item that can't be published yet,
	 * which stops all of them (`PUBLISH_ALL_REFUSED`, with the item, its name and its own refusal's
	 * `code` and `data`), and a confirmation for Drafts that changed since (`CONFIRMATION_INVALID`).
	 */
	publishAll: signedIn
		.input(
			z.object({
				siteId: id,
				items: z.array(publishItem).min(1).max(PUBLISH_ALL_MAX_ITEMS),
				confirmation: z.string().max(100).optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return await context.services.publishing.publishAll(site, input.items, input.confirmation);
		}),
};
