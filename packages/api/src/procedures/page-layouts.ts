import { configureLayout, getPageLayout, layoutSettings } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { language } from "../fields.ts";
import { componentId, id } from "../inputs.ts";

/**
 * Page layouts (GLOSSARY.md): the Components placed in a Page's content area, each with its own Prop
 * values. Staff (`structure.edit`) switch arranging on for a Site's Members and choose its Allowed
 * components; anyone who edits Entries then arranges a Page, Members within those limits. Every
 * check beyond the input's shape is core's (`content/page-layouts.ts`): what only Staff may do is
 * refused as `PAGE_LAYOUT_REFUSED`, a layout that can't be saved as `ENTRY_INVALID`.
 */
export const pageLayouts = {
	/** Whether the Site's Members may arrange Pages, and the Components they may add. Anyone who sees the Site. */
	settings: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const scope = await context.services.data.site(context.access, input.siteId, "site.view");
		return layoutSettings(scope);
	}),

	/**
	 * Switches arranging on or off for the Site's Members, or replaces the Allowed components (the
	 * whole list, Component ids); what is left out stays as it is. Staff only (`structure.edit`). A
	 * Component the Site doesn't have is `ENTRY_INVALID`.
	 */
	configure: signedIn
		.input(
			z.object({
				siteId: id,
				enabled: z.boolean().optional(),
				allowedComponents: z.array(componentId).max(1000).optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const scope = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, ...change } = input;
			return configureLayout(scope, change);
		}),

	/**
	 * A Page's layout in one language: its Placements with their Props and values, its `version` (to
	 * save against), the Components the caller may add and the Entries its Relationship Props can
	 * point at.
	 */
	get: signedIn
		.input(z.object({ siteId: id, entryId: id, language: language.optional() }))
		.handler(async ({ context, input }) => {
			const scope = await context.services.data.site(context.access, input.siteId, "site.view");
			return getPageLayout(scope, input.entryId, input.language);
		}),

	/**
	 * Saves a Page's whole layout (`{ placements }`, as `get` answers it) into its Draft, checked whole
	 * in core, and answers it as `get` would. `basedOn` is the `version` it was changed from: when the
	 * layout changed since, it is refused with `CHANGED_MEANWHILE`.
	 */
	save: signedIn
		.input(
			z.object({
				siteId: id,
				entryId: id,
				language: language.optional(),
				// A shared-document value, checked whole by core's `writePageLayout` (at most 200 Placements).
				layout: z.unknown(),
				basedOn: z.string().min(1).max(100),
			}),
		)
		.handler(async ({ context, input }) => {
			const scope = await context.services.data.site(context.access, input.siteId, "entry.edit");
			return scope.transaction(async (tx) => {
				await context.services.entries.saveDraft(tx, input.entryId, {
					layout: input.layout,
					layoutBasedOn: input.basedOn,
				});
				return getPageLayout(tx, input.entryId, input.language);
			});
		}),
};
