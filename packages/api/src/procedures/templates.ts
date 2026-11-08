import { publishPermission } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";

/** The longest Template markup one save takes, in characters. */
const TEMPLATE_MARKUP_MAX_LENGTH = 2_000_000;

import { id } from "../inputs.ts";

/** Templates: Structure, stored as element trees with a Draft and a published version. Staff change and publish them. */
export const templates = {
	/** A Post Type's Entry template, or null while it has none. */
	getEntryTemplate: signedIn.input(z.object({ siteId: id, postTypeId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { template: await context.services.templates.entryTemplate(site, input.postTypeId) };
	}),

	/**
	 * Saves the Draft of a Post Type's Entry template as an element tree, creating the template the
	 * first time. Refused with the problems listed when the tree isn't one WebCraft may store.
	 */
	saveEntryTemplate: signedIn
		.input(z.object({ siteId: id, postTypeId: id, tree: z.unknown() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { template: await context.services.templates.saveEntryTemplate(site, input.postTypeId, input.tree) };
		}),

	/**
	 * A Post Type's Entry template as Template markup: its Draft and its published version (null until
	 * the first publish), with the template itself; both null while it has none.
	 */
	getEntryTemplateMarkup: signedIn
		.input(z.object({ siteId: id, postTypeId: id }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.templates.entryTemplateMarkup(site, input.postTypeId);
		}),

	/**
	 * Saves the Draft of a Post Type's Entry template from Template markup, creating the template the
	 * first time. Answers the template, its markup as stored now (every element with its
	 * `data-wc-id`) and notices, such as an inline style that became a generated Class. Refused
	 * with each problem's line and column when the markup can't be saved.
	 */
	saveEntryTemplateMarkup: signedIn
		.input(z.object({ siteId: id, postTypeId: id, markup: z.string().max(TEMPLATE_MARKUP_MAX_LENGTH) }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.templates.saveEntryTemplateMarkup(site, input.postTypeId, input.markup);
		}),

	/** The Site template, or null while the Site has none and its pages show the built-in one. */
	getSiteTemplate: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { template: await context.services.templates.siteTemplate(site) };
	}),

	/**
	 * Saves the Draft of the Site template as an element tree, creating it the first time. It holds
	 * the header, the footer and one `{{@outlet}}` inside the page's <main>.
	 */
	saveSiteTemplate: signedIn.input(z.object({ siteId: id, tree: z.unknown() })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { template: await context.services.templates.saveSiteTemplate(site, input.tree) };
	}),

	/** The Site template as Template markup, Draft and published; both null while the Site has none. */
	getSiteTemplateMarkup: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return context.services.templates.siteTemplateMarkup(site);
	}),

	/**
	 * Saves the Draft of the Site template from Template markup, creating it the first time, and
	 * answers it as `saveEntryTemplateMarkup` does.
	 */
	saveSiteTemplateMarkup: signedIn
		.input(z.object({ siteId: id, markup: z.string().max(TEMPLATE_MARKUP_MAX_LENGTH) }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.templates.saveSiteTemplateMarkup(site, input.markup);
		}),

	/** Publishes a Template's Draft: every page it renders changes at once, and the Site's page cache is cleared. */
	publish: signedIn.input(z.object({ siteId: id, templateId: id })).handler(async ({ context, input }) => {
		const item = { kind: "template", id: input.templateId } as const;
		const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
		const published = await context.services.publishing.publish(site, item);
		return { published };
	}),
};
