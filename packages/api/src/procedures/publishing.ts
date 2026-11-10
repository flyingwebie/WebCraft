import { publishPermission } from "@webcraft/core";
import { z } from "zod";

import { confirmationInput, confirmedForApiClients } from "../confirm.ts";
import { signedIn } from "../context.ts";
import { id, publishItem } from "../inputs.ts";

/** A time a Scheduled publish runs at: an ISO date and time (`2026-03-02T09:00:00Z`), stored in UTC. */
const scheduleTime = z.coerce.date();

/** An item's key in a confirmation's target. */
function targetOf(item: z.infer<typeof publishItem>): string {
	return "id" in item ? `${item.kind}:${item.id}` : item.kind;
}

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

	/**
	 * The Site's Scheduled publishes waiting for their time, soonest first; with `item`, those it waits
	 * in. Each says what it does (`action`: `publish` or `unpublish`), whether it is one item's or a
	 * Publish all set (`kind`), when (`at`, UTC), its items in the order they go live (each with
	 * `changedSinceScheduled`: its Draft changed after it was scheduled, and those edits stay in the
	 * Draft; `missing`: deleted since), who scheduled it, and whether the person may change it
	 * (`canChange`). Anyone who sees the Site may look.
	 */
	scheduled: signedIn
		.input(z.object({ siteId: id, item: publishItem.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return { scheduled: await context.services.publishing.scheduled(site, { item: input.item }) };
		}),

	/**
	 * Schedules one item's publish at `at` (UTC, in the future): its Draft as it is now, every
	 * language, is what goes live then, whatever is edited later. Whoever may publish the item may
	 * schedule it (Authors can't). At the time WebCraft publishes it on behalf of the person who
	 * scheduled it, as publishing it then would (its Revision, Webhooks, the page cache, Automatic
	 * translation); if it can't be published then, nothing is, and that person is emailed. Refused: a
	 * time in the past or more than ten years ahead (`SCHEDULE_INVALID`), an item already scheduled to
	 * publish (`ALREADY_SCHEDULED`, with its `scheduleId`), and a Draft that couldn't be published now
	 * (the reason publishing it would give). API clients confirm a preview first.
	 */
	schedule: signedIn
		.input(z.object({ siteId: id, item: publishItem, at: scheduleTime, confirmation: confirmationInput }))
		.use(
			confirmedForApiClients({
				action: "scheduledPublish.create",
				permission: (input) => publishPermission(input.item),
				describe: async (site, input, services) => ({
					target: targetOf(input.item),
					preview: { at: input.at.toISOString(), ...(await services.publishing.preview(site, input.item)) },
				}),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, publishPermission(input.item));
			return { scheduled: await context.services.publishing.schedule(site, input.item, input.at) };
		}),

	/**
	 * "Publish all at…": schedules the ticked Drafts as one Scheduled publish at `at`, in two calls
	 * like Publish all. The first schedules nothing: it answers the items in the order they would go
	 * live (`preview`) and a `confirmation` id; calling again with the same items, time and id
	 * schedules them, each frozen as its Draft is then. At the time they are published together, all
	 * or none. Refused as Publish all is, and for a time in the past or too far ahead
	 * (`SCHEDULE_INVALID`) or an item already scheduled to publish (`ALREADY_SCHEDULED`).
	 */
	scheduleAll: signedIn
		.input(
			z.object({
				siteId: id,
				items: z.array(publishItem).min(1).max(PUBLISH_ALL_MAX_ITEMS),
				at: scheduleTime,
				confirmation: z.string().max(100).optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return await context.services.publishing.scheduleAll(site, input.items, input.at, input.confirmation);
		}),

	/**
	 * Schedules an Entry's unpublish at `at` (UTC, in the future; `entry.publish`): from then its pages
	 * answer 410 Gone, it leaves Loops, sitemaps and Site search, and it keeps its Draft and its
	 * Revisions, so it can be published again. A Page takes every Page under it along. Refused: the
	 * Site's home page or a Page above it (`HOME_PAGE_UNPUBLISH`), an Entry already scheduled to
	 * unpublish (`ALREADY_SCHEDULED`) and a time in the past or too far ahead (`SCHEDULE_INVALID`).
	 * API clients confirm a preview first.
	 */
	scheduleUnpublish: signedIn
		.input(z.object({ siteId: id, entryId: id, at: scheduleTime, confirmation: confirmationInput }))
		.use(
			confirmedForApiClients({
				action: "entry.unpublish",
				permission: () => "entry.publish",
				describe: async (site, input, services) => {
					const entry = await services.entries.get(site, input.entryId);
					return {
						target: `entry:${entry.id}`,
						preview: { at: input.at.toISOString(), title: entry.draft.title, path: entry.path },
					};
				},
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.publish");
			return {
				scheduled: await context.services.publishing.scheduleUnpublish(
					site,
					{ kind: "entry", id: input.entryId },
					input.at,
				),
			};
		}),

	/**
	 * Changes when a Scheduled publish runs (`at`, UTC, in the future). It still publishes the versions
	 * it froze; taking the current Drafts is `updateScheduled`. Whoever may publish every item of it
	 * may change it.
	 */
	reschedule: signedIn
		.input(z.object({ siteId: id, scheduleId: id, at: scheduleTime }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return { scheduled: await context.services.publishing.reschedule(site, input.scheduleId, input.at) };
		}),

	/**
	 * Takes each item's current Draft into a Scheduled publish in place of the version frozen before
	 * ("Update to the current Drafts"), checked as scheduling is; its time stays. An unpublish has no
	 * Draft to take (`SCHEDULE_INVALID`). API clients confirm a preview first.
	 */
	updateScheduled: signedIn
		.input(z.object({ siteId: id, scheduleId: id, confirmation: confirmationInput }))
		.use(
			confirmedForApiClients({
				action: "scheduledPublish.update",
				permission: () => "site.view",
				describe: async (site, input, services) => {
					const scheduled = await services.publishing.getScheduled(site, input.scheduleId);
					return {
						target: scheduled.id,
						preview: {
							at: scheduled.at.toISOString(),
							items: scheduled.items.map(({ item, name, changedSinceScheduled }) => ({
								item,
								name,
								changedSinceScheduled,
							})),
						},
					};
				},
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return { scheduled: await context.services.publishing.updateScheduled(site, input.scheduleId) };
		}),

	/** Cancels a Scheduled publish: nothing of it is published, and the Drafts stay as they are. */
	cancelScheduled: signedIn.input(z.object({ siteId: id, scheduleId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		await context.services.publishing.cancelScheduled(site, input.scheduleId);
		return { cancelled: true as const };
	}),
};
