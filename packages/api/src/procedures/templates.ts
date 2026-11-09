import { publishPermission } from "@webcraft/core";
import { z } from "zod";

import { confirmationInput, confirmedPublish } from "../confirm.ts";
import { signedIn } from "../context.ts";

/** The longest Template markup one save takes, in characters. */
const TEMPLATE_MARKUP_MAX_LENGTH = 2_000_000;

import { basedOn, id } from "../inputs.ts";

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
	 * `data-wc-id`), the Draft's version and notices, such as an inline style that became a generated
	 * Class. Refused with each problem's line and column when the markup can't be saved, and with
	 * `CHANGED_MEANWHILE` (the version now in `data.version`) when `basedOn` names an older version.
	 */
	saveEntryTemplateMarkup: signedIn
		.input(z.object({ siteId: id, postTypeId: id, markup: z.string().max(TEMPLATE_MARKUP_MAX_LENGTH), basedOn }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.templates.saveEntryTemplateMarkup(site, input.postTypeId, input.markup, {
				basedOn: input.basedOn,
			});
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
		.input(z.object({ siteId: id, markup: z.string().max(TEMPLATE_MARKUP_MAX_LENGTH), basedOn }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.templates.saveSiteTemplateMarkup(site, input.markup, { basedOn: input.basedOn });
		}),

	/**
	 * A Post Type's Archive template, or null while it has none. It lists the Post Type's Entries
	 * through Loops at the URL pattern's fixed address (`/blog` for `/blog/{slug}`).
	 */
	getArchiveTemplate: signedIn.input(z.object({ siteId: id, postTypeId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { template: await context.services.templates.archiveTemplate(site, input.postTypeId) };
	}),

	/**
	 * Saves the Draft of a Post Type's Archive template as an element tree, creating it the first
	 * time. Pages have none, nor has a Post Type whose URL pattern starts with `{slug}` (`ARCHIVE_UNAVAILABLE`).
	 */
	saveArchiveTemplate: signedIn
		.input(z.object({ siteId: id, postTypeId: id, tree: z.unknown() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { template: await context.services.templates.saveArchiveTemplate(site, input.postTypeId, input.tree) };
		}),

	/** A Post Type's Archive template as Template markup, Draft and published; both null while it has none. */
	getArchiveTemplateMarkup: signedIn
		.input(z.object({ siteId: id, postTypeId: id }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.templates.archiveTemplateMarkup(site, input.postTypeId);
		}),

	/** Saves the Draft of a Post Type's Archive template from Template markup, as `saveEntryTemplateMarkup` does. */
	saveArchiveTemplateMarkup: signedIn
		.input(z.object({ siteId: id, postTypeId: id, markup: z.string().max(TEMPLATE_MARKUP_MAX_LENGTH), basedOn }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.templates.saveArchiveTemplateMarkup(site, input.postTypeId, input.markup, {
				basedOn: input.basedOn,
			});
		}),

	/**
	 * The Site's Search results template (ADR 0021), or null while it has none and its search results
	 * page shows the built-in one. It lists the hits for the visitor's query through the Loop `search`.
	 */
	getSearchTemplate: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { template: await context.services.templates.searchTemplate(site) };
	}),

	/**
	 * Saves the Draft of the Search results template as an element tree, creating it the first time.
	 * It reads the Globals, the Loops of the Site, the Loop `search` (its hits, each with its `snippet`)
	 * and `search.query`; no Entry's values.
	 */
	saveSearchTemplate: signedIn
		.input(z.object({ siteId: id, tree: z.unknown() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { template: await context.services.templates.saveSearchTemplate(site, input.tree) };
		}),

	/** The Search results template as Template markup, Draft and published; both null while the Site has none. */
	getSearchTemplateMarkup: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return context.services.templates.searchTemplateMarkup(site);
	}),

	/** Saves the Draft of the Search results template from Template markup, as `saveEntryTemplateMarkup` does. */
	saveSearchTemplateMarkup: signedIn
		.input(z.object({ siteId: id, markup: z.string().max(TEMPLATE_MARKUP_MAX_LENGTH), basedOn }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.templates.saveSearchTemplateMarkup(site, input.markup, { basedOn: input.basedOn });
		}),

	/**
	 * Publishes a Template's Draft: every page it renders changes at once, and the Site's page cache is
	 * cleared. An Archive template takes its address (`PATH_TAKEN` where a Page or URL pattern has it).
	 */
	publish: signedIn
		.input(z.object({ siteId: id, templateId: id, confirmation: confirmationInput }))
		.use(confirmedPublish((input) => ({ kind: "template", id: input.templateId })))
		.handler(async ({ context, input }) => {
			const item = { kind: "template", id: input.templateId } as const;
			const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
			const published = await context.services.publishing.publish(site, item);
			return { published };
		}),
};
