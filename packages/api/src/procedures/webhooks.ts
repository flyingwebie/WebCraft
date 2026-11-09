import { WEBHOOK_EVENTS } from "@webcraft/core";
import { z } from "zod";

import { sensitive, signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** A Webhook's name; the URL's host when left empty. */
const name = z.string().trim().max(100).optional();

/** A Webhook's URL as typed; the server checks it (`WEBHOOK_INVALID`). */
const url = z.string().max(2048);

/** The events a Webhook receives: at least one. */
const events = z
	.array(z.enum(WEBHOOK_EVENTS))
	.min(1)
	.max(WEBHOOK_EVENTS.length * 2);

/** A signing secret Staff give; the server checks it (`WEBHOOK_INVALID`). Empty or left out: WebCraft makes one. */
const secret = z.string().max(300).optional();

/**
 * A Site's Webhooks (spec story 139): signed calls to outside addresses when something happens on the
 * Site, sent by the worker with retries and kept in a delivery log. Site settings: everyone who sees
 * the Site reads them (people without `structure.edit` see each URL's origin only), Staff change them
 * (`structure.edit`); a change applies at once and is recorded in the Audit log. Adding one, and
 * changing where it goes, what it receives or its secret, are Sensitive actions (`webhook.change`).
 */
export const webhooks = {
	/** The Site's Webhooks, oldest first, and the events a Webhook can receive. */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { webhooks: await context.services.webhooks.list(site), events: [...WEBHOOK_EVENTS] };
	}),

	/**
	 * Adds a Webhook, on at once: an `https` URL without credentials, the events it receives and its
	 * signing secret. Without a secret, WebCraft makes one and answers it here (`secret`), once: it is
	 * never shown again. A Sensitive action.
	 */
	add: signedIn
		.input(z.object({ siteId: id, name, url, events, secret }))
		.use(async ({ context, next }, input) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return next({ context: { site } });
		})
		.use(sensitive("webhook.change"))
		.handler(async ({ context, input }) => await context.services.webhooks.add(context.site, input)),

	/**
	 * A Webhook's delivery log, newest first, 20 at a time (up to 100): each delivery's body as sent,
	 * its status and every attempt (when, how long, the receiver's status and the start of its
	 * answer, or what went wrong). `next` asks for the following page. Deliveries are kept 30 days.
	 */
	deliveries: signedIn
		.input(
			z.object({
				siteId: id,
				webhookId: id,
				before: id.optional(),
				limit: z.number().int().min(1).max(100).default(20),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return await context.services.webhooks.deliveries(site, input.webhookId, input);
		}),
};
