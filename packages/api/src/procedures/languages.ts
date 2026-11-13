import { LANGUAGE_NAME_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

const direction = z.enum(["ltr", "rtl"]);
const domain = z.string().max(300);
const name = z.string().max(LANGUAGE_NAME_MAX_LENGTH * 2);
/** A language tag as typed; the server checks it and answers its canonical form. */
const code = z.string().max(100);

/**
 * A Site's languages (Structure, ADR 0010): its Default language, unprefixed in URLs, and the others,
 * each on its own prefix (`/fr/…`) or, once domains are verified, a domain of its own. Everyone who
 * sees the Site sees them; Staff change them, and a change applies at once.
 */
export const languages = {
	/** The Site's languages (the Default language first) and its browser-language redirect setting. */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return { settings: await context.services.languages.get(site) };
	}),

	/**
	 * Adds a language: a BCP 47 tag (`fr`, `pt-BR`), kept in its canonical form. Its name is the
	 * language's own and its direction follows from the code unless given.
	 */
	add: signedIn
		.input(
			z.object({
				siteId: id,
				code,
				name: name.optional(),
				direction: direction.optional(),
				domain: domain.nullable().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, ...language } = input;
			return { settings: await context.services.languages.add(site, language) };
		}),

	/**
	 * Makes another of the Site's languages its Default language, in two steps. The first call changes
	 * nothing: it answers what would change (`preview`: how many published addresses change, how many
	 * Entries have no title of their own in the new Default language) and a `confirmation` id, valid
	 * for 5 minutes; calling again with it goes ahead and answers the addresses that changed.
	 */
	setDefault: signedIn
		.input(z.object({ siteId: id, code, confirmation: z.string().max(100).optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return await context.services.languages.setDefault(site, input.code, input.confirmation);
		}),

	/**
	 * Removes a language, in two steps. The first call removes nothing: it answers how many published
	 * pages the language has (`preview.pages`) and a `confirmation` id, valid for 5 minutes; calling
	 * again with it removes the language, and its pages are gone at once. Values written in it are kept,
	 * so adding it again brings them back. The Default language can't be removed.
	 */
	remove: signedIn
		.input(z.object({ siteId: id, code, confirmation: z.string().max(100).optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return await context.services.languages.remove(site, input.code, input.confirmation);
		}),

	/**
	 * Turns the browser-language redirect on or off: when on, a visitor's first request to the home
	 * page goes on to the home page in the language their browser prefers. Off by default.
	 */
	setBrowserRedirect: signedIn
		.input(z.object({ siteId: id, browserLanguageRedirect: z.boolean() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { settings: await context.services.languages.setBrowserRedirect(site, input.browserLanguageRedirect) };
		}),

	/** Changes a language's name, direction or domain (null for none). */
	update: signedIn
		.input(
			z.object({
				siteId: id,
				code,
				name: name.optional(),
				direction: direction.optional(),
				domain: domain.nullable().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, code, ...change } = input;
			return { settings: await context.services.languages.update(site, code, change) };
		}),
};
