import { z } from "zod";

import { signedIn } from "../context.ts";
import { language } from "../fields.ts";
import { id } from "../inputs.ts";

/**
 * The Pages a Site gives a special job: its home page, at `/`, its 404 page, for every path with no
 * page, and its search results page. Everyone who sees the Site sees which they are; Staff choose them (Structure).
 */
export const pages = {
	/** Which Pages are the Site's home page and 404 page; null where none is chosen. */
	settings: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { settings: await context.services.pages.settings(site) };
	}),

	/**
	 * Chooses the Page that answers at `/` (null for none). A Page that isn't published yet shows once
	 * it is; its own path then sends visitors on to `/`.
	 */
	setHomePage: signedIn.input(z.object({ siteId: id, pageId: id.nullable() })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { settings: await context.services.pages.setHomePage(site, input.pageId) };
	}),

	/**
	 * Chooses the Page that answers every path with no page, with status 404 (null for the built-in
	 * one, which also stands in while the chosen Page isn't published). With `language`, the 404 page of
	 * that language alone; null there leaves the Site's 404 page to answer in it.
	 */
	setNotFoundPage: signedIn
		.input(z.object({ siteId: id, pageId: id.nullable(), language: language.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { settings: await context.services.pages.setNotFoundPage(site, input.pageId, input.language) };
		}),

	/**
	 * Chooses the Site's search results page (null for none): visitors searching the Site land there,
	 * in their language, and it shows the Search results template's hits. The Search element shows
	 * only while the Site has one, published and shown in the page's language.
	 */
	setSearchPage: signedIn.input(z.object({ siteId: id, pageId: id.nullable() })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { settings: await context.services.pages.setSearchPage(site, input.pageId) };
	}),
};
