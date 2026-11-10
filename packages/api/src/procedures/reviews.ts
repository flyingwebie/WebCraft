import { REVIEW_LIMITS } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id, reviewItem } from "../inputs.ts";

/**
 * Review (GLOSSARY.md › Review): Authors submit Drafts for someone who may publish them to check.
 * While it waits the item is In review; its Author may withdraw it; those who may publish it publish
 * it (each item's own `publish`, or Publish all), schedule it (`publishing.schedule`) or send it back
 * here with a comment. Whatever publishes or schedules an item In review ends its Review and emails
 * its Author.
 */
export const reviews = {
	/**
	 * The Site's Reviews waiting for someone to act, oldest first; with `item`, that item's. Each says
	 * what is reviewed (`item`, `name`), who submitted it and when, their `note`, whether its Draft
	 * changed since (`changedSinceSubmitted`), and whether the person may act on it (`canAct`: publish,
	 * schedule or send back) or withdraw it (`canWithdraw`). Anyone who sees the Site may look.
	 */
	list: signedIn.input(z.object({ siteId: id, item: reviewItem.optional() })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { reviews: await context.services.reviews.list(site, { item: input.item }) };
	}),

	/** One of the Site's Reviews, whatever became of it (`status`: `inReview`, `withdrawn`, `sentBack`, `published`, `scheduled`). */
	get: signedIn.input(z.object({ siteId: id, reviewId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { review: await context.services.reviews.get(site, input.reviewId) };
	}),

	/** How many waiting Reviews the person may act on: what the admin shows beside "Waiting for review". */
	count: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { count: await context.services.reviews.countToAct(site) };
	}),

	/**
	 * Submits Drafts for Review, together, with an optional note: each becomes In review, and the
	 * people who may publish them on the Site (its Owners and Editors; Staff when it has none) are
	 * emailed once. The Draft stays shared while it waits: anyone may go on editing it, and whoever
	 * acts on it publishes it as it is then. Refused: a Draft that is what visitors see already
	 * (`REVIEW_INVALID`, `nothingToReview`), one whose values publishing would refuse (`ENTRY_INCOMPLETE`,
	 * `ENTRY_INVALID`, `GLOBALS_INCOMPLETE`, …), and an item In review already (`ALREADY_IN_REVIEW`).
	 */
	submit: signedIn
		.input(
			z.object({
				siteId: id,
				items: z.array(reviewItem).min(1).max(REVIEW_LIMITS.itemsMax),
				note: z.string().max(REVIEW_LIMITS.noteMax).nullable().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
			return { reviews: await context.services.reviews.submit(site, input.items, input.note ?? null) };
		}),

	/**
	 * Withdraws a Review while it waits: its item is a Draft again. Only the person who submitted it
	 * may (`REVIEW_NOT_YOURS`); one decided already is `REVIEW_DECIDED`.
	 */
	withdraw: signedIn.input(z.object({ siteId: id, reviewId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
		return { review: await context.services.reviews.withdraw(site, input.reviewId) };
	}),

	/**
	 * Sends a waiting Review back with a comment saying why (required): its item is a Draft again, its
	 * editor shows the comment until it is submitted again or published, and its Author is emailed.
	 * Needs what publishing the item needs (`entry.publish`). One decided already is `REVIEW_DECIDED`.
	 */
	sendBack: signedIn
		.input(
			z.object({
				siteId: id,
				reviewId: id,
				comment: z.string().trim().min(1).max(REVIEW_LIMITS.commentMax),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return { review: await context.services.reviews.sendBack(site, input.reviewId, input.comment) };
		}),
};
