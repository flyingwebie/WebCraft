import { WEBHOOK_EVENTS } from "@webcraft/core";
import { z } from "zod";

import { onSite, sensitive, signedIn } from "../context.ts";
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
 * and read the delivery log (`structure.edit`); a change applies at once and is recorded in the Audit
 * log. Adding one, and changing where it goes, what it receives or its secret, are Sensitive actions
 * (`webhook.change`).
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
		.use(onSite("structure.edit"))
		.use(sensitive("webhook.change"))
		.handler(async ({ context, input }) => await context.services.webhooks.add(context.site, input)),

	/**
	 * Changes a Webhook's name (its URL's host when empty), URL and events at once; deliveries waiting
	 * for an attempt go to the new URL. A Sensitive action.
	 */
	update: signedIn
		.input(z.object({ siteId: id, webhookId: id, name, url, events }))
		.use(onSite("structure.edit"))
		.use(sensitive("webhook.change"))
		.handler(async ({ context, input }) => ({
			webhook: await context.services.webhooks.update(context.site, input.webhookId, input),
		})),

	/**
	 * Replaces a Webhook's signing secret with the one given, or a new one WebCraft makes and answers
	 * here (`secret`), once. Every attempt from now on is signed with it. A Sensitive action.
	 */
	changeSecret: signedIn
		.input(z.object({ siteId: id, webhookId: id, secret }))
		.use(onSite("structure.edit"))
		.use(sensitive("webhook.change"))
		.handler(
			async ({ context, input }) =>
				await context.services.webhooks.changeSecret(context.site, input.webhookId, input.secret),
		),

	/**
	 * Removes a Webhook, in two steps. The first call removes nothing: it answers what would go
	 * (`preview`: its name, URL and how many deliveries its log holds) and a `confirmation` id, valid
	 * for 5 minutes; calling again with it removes the Webhook, its delivery log and its secret.
	 */
	remove: signedIn
		.input(z.object({ siteId: id, webhookId: id, confirmation: z.string().max(100).optional() }))
		.use(onSite("structure.edit"))
		.handler(
			async ({ context, input }) =>
				await context.services.webhooks.remove(context.site, input.webhookId, input.confirmation),
		),

	/**
	 * A Webhook's delivery log, newest first, 20 at a time (up to 100): each delivery's body as sent,
	 * its status and every attempt (when, how long, the receiver's status and the start of its
	 * answer, or what went wrong). `next` asks for the following page. Deliveries are kept 30 days.
	 * Staff only (`structure.edit`): a body can hold what a visitor sent in a Form, and an answer
	 * whatever the receiver said.
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
		.use(onSite("structure.edit"))
		.handler(
			async ({ context, input }) => await context.services.webhooks.deliveries(context.site, input.webhookId, input),
		),

	/**
	 * Switches a Webhook on or off. Off, it receives nothing, and deliveries waiting for an attempt
	 * stop (they can be redelivered once it is on again); on again, its count of failures starts over.
	 */
	setEnabled: signedIn
		.input(z.object({ siteId: id, webhookId: id, enabled: z.boolean() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { webhook: await context.services.webhooks.setEnabled(site, input.webhookId, input.enabled) };
		}),

	/**
	 * Send test: sends the Webhook a signed `test` event at once (on or off) and answers the delivery,
	 * with what the receiver said. Never retried, and never counted as a failure.
	 */
	test: signedIn.input(z.object({ siteId: id, webhookId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { delivery: await context.services.webhooks.test(site, input.webhookId) };
	}),

	/**
	 * Redeliver: queues a failed delivery again, with the same id and body, for a new round of
	 * attempts. Refused for one that isn't failed, for a test send, and while the Webhook is off
	 * (`WEBHOOK_REDELIVERY_REFUSED`).
	 */
	redeliver: signedIn
		.input(z.object({ siteId: id, webhookId: id, deliveryId: id }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return {
				delivery: await context.services.webhooks.redeliver(site, input.webhookId, input.deliveryId),
			};
		}),
};
