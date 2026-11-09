import { HISTORY_PAGE, historyEditPermission, historyReadPermission } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { language } from "../fields.ts";
import { id, publishItem } from "../inputs.ts";

/** One saved copy of an item: a Revision or a Checkpoint, by id. */
const copyRef = z.object({ type: z.enum(["revision", "checkpoint"]), id });

/**
 * An item's history (GLOSSARY.md › Revision, Checkpoint): the Revisions each publish saved and the
 * Checkpoints its Draft was saved as while it was edited. Reading it needs what reading the item
 * needs: anyone who sees the Site for Entries, the Globals and the Consent banner's words; Staff, Owners
 * and Editors for a Form's emails; Staff for Structure.
 */
export const history = {
	/**
	 * One page of an item's history, Revisions and Checkpoints together, newest first (at most 100;
	 * `cursor` continues from the last page), with whether publishing it saves a Revision now (and if
	 * not, which switch is off) and how long Revisions and Checkpoints are kept.
	 */
	list: signedIn
		.input(
			z.object({
				siteId: id,
				item: publishItem,
				cursor: z.string().max(200).optional(),
				limit: z.number().int().min(1).max(HISTORY_PAGE.max).optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, historyReadPermission(input.item));
			return await context.services.history.list(site, input.item, { cursor: input.cursor, limit: input.limit });
		}),

	/**
	 * A Revision or Checkpoint next to the item's Draft, part by part: an Entry's built-in values and
	 * Fields (the Globals' and the Consent banner's Fields) in one `language` (the Site's Default language
	 * unless given), a Structure item's sections. Each part says whether it differs, how each side reads
	 * (a Body Block by Block, markup and settings line by line) and who changed the Draft's value last and
	 * when ("<person> via <client>" for an API or AI client). `languages` counts the differences in each.
	 */
	compare: signedIn
		.input(z.object({ siteId: id, item: publishItem, copy: copyRef, language: language.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, historyReadPermission(input.item));
			return await context.services.history.compare(site, input.item, input.copy, input.language);
		}),

	/** One Revision or Checkpoint with the whole version it holds, every language included, as the item stores it. */
	get: signedIn
		.input(z.object({ siteId: id, item: publishItem, copy: copyRef }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, historyReadPermission(input.item));
			const { item, copy } = await context.services.history.get(site, input.item, input.copy);
			const { content, ...summary } = copy;
			return { item, copy: summary, content };
		}),

	/**
	 * Restores a Revision or Checkpoint into the item's Draft: anyone who may change the Draft may
	 * restore (Authors too, for Entries). The Draft as it is is saved as a Checkpoint first (answered as
	 * `checkpoint`, null when the newest Revision or Checkpoint holds it already), then the copy's
	 * version replaces the Draft, checked as any save is (`ELEMENT_TREE_INVALID` for a Template placing a
	 * Component deleted since). Nothing is published: visitors see it once someone publishes the item.
	 * Logged as `draft.restore`.
	 */
	restore: signedIn
		.input(z.object({ siteId: id, item: publishItem, copy: copyRef }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, historyEditPermission(input.item));
			return await context.services.history.restore(site, input.item, input.copy);
		}),

	/**
	 * The editor of an item closed: the admin's editors say so as they close. When nobody else is
	 * editing it, its Draft is saved as a Checkpoint unless nothing changed since its newest Revision or
	 * Checkpoint. Answers the Checkpoint saved, or null. Co-editing will call the same when its last
	 * participant goes.
	 */
	leave: signedIn.input(z.object({ siteId: id, item: publishItem })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, historyReadPermission(input.item));
		return { checkpoint: await context.services.history.leave(site, input.item) };
	}),
};
