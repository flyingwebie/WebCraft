import { ENTRY_BODY_FORMATS, ENTRY_TITLE_MAX_LENGTH, PASTE_MAX_LENGTH, publishPermission } from "@webcraft/core";
import { z } from "zod";
import { confirmationInput, confirmedPublish } from "../confirm.ts";
import { signedIn } from "../context.ts";
import { fieldValues, language, seoFields } from "../fields.ts";
import { id } from "../inputs.ts";
import { languageOf } from "./modules.ts";

/**
 * How the Body field's value is read or written: its JSON Blocks (the default), or Markdown with the
 * body's extensions (`:::callout{tone="info"}`, `:::toggle[Summary]`, `::video[Title]{url="…"}`,
 * `::image`, `![alt](media:<id>)`, Components as `<Name prop="value" />`). Markdown that doesn't
 * convert is refused (`ENTRY_INVALID`), each problem at the Field with its `line`.
 */
const bodyFormat = z.enum(ENTRY_BODY_FORMATS).optional();

/** Entries: Content. Members and Staff write them; Editors, Owners and Staff publish them. */
export const entries = {
	/** The Entries of a Post Type, newest first, with their Draft and published values. */
	list: signedIn
		.input(z.object({ siteId: id, postTypeId: id, language: language.optional(), bodyFormat }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return {
				entries: await context.services.entries.list(site, input.postTypeId, input.language, {
					bodyFormat: input.bodyFormat,
				}),
			};
		}),

	/** One Entry: its built-in Fields (title, slug, status, author, dates), its Draft and its published version. */
	get: signedIn
		.input(z.object({ siteId: id, entryId: id, language: language.optional(), bodyFormat }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return {
				entry: await context.services.entries.get(site, input.entryId, input.language, {
					bodyFormat: input.bodyFormat,
				}),
			};
		}),

	/**
	 * The Components a Post Type's Body field allows (Staff choose them), that are published, with
	 * their Props: what the block editors offer from the `/` menu, and what Markdown may place as
	 * `<Name prop="value" />`.
	 */
	bodyComponents: signedIn.input(z.object({ siteId: id, postTypeId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return {
			components: await context.services.entries.bodyComponents(
				site,
				input.postTypeId,
				await languageOf(context.services, context.person),
			),
		};
	}),

	/**
	 * What was pasted into a Post Type's body, as Blocks (nothing is saved): the clipboard's HTML (from
	 * a document or a web page) when it has some, else its text (Markdown, or plain paragraphs).
	 */
	pasteBody: signedIn
		.input(
			z.object({
				siteId: id,
				postTypeId: id,
				html: z.string().max(PASTE_MAX_LENGTH).optional(),
				text: z.string().max(PASTE_MAX_LENGTH).optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
			const { siteId: _, postTypeId, ...pasted } = input;
			return { blocks: await context.services.entries.pasteBody(site, postTypeId, pasted) };
		}),

	/**
	 * Creates an Entry of a Post Type; its values go into the Draft. A slug is made from the title when
	 * none is given. A Page may name its parent Page.
	 */
	create: signedIn
		.input(
			z.object({
				siteId: id,
				postTypeId: id,
				language: language.optional(),
				title: z.string().trim().min(1).max(ENTRY_TITLE_MAX_LENGTH),
				slug: z.string().max(500).optional(),
				parentId: id.nullable().optional(),
				hiddenLanguages: z.array(language).max(100).optional(),
				fields: fieldValues.optional(),
				/** Its SEO fields: the SEO title, description, canonical URL and social image, and noindex. */
				seo: seoFields.optional(),
				bodyFormat,
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
			return { entry: await context.services.entries.create(site, input) };
		}),

	/**
	 * Saves changes to an Entry's Draft. Visitors see nothing of them until it is published. Values of
	 * the wrong kind are refused (`ENTRY_INVALID`, each problem at its Field's path); values that break
	 * a rule are saved and listed in the Entry's `problems`, and keep it from being published.
	 */
	saveDraft: signedIn
		.input(
			z.object({
				siteId: id,
				entryId: id,
				language: language.optional(),
				title: z
					.string()
					.max(ENTRY_TITLE_MAX_LENGTH * 2)
					.optional(),
				slug: z.string().max(500).optional(),
				/** A Page's parent Page; null moves it to the top level. */
				parentId: id.nullable().optional(),
				/** Every language the Entry is hidden in: it has no page there once published. */
				hiddenLanguages: z.array(language).max(100).optional(),
				fields: fieldValues.optional(),
				/**
				 * Changes to its SEO fields, in the language (noindex is one value for every language): only
				 * those given change; null or "" clears one.
				 */
				seo: seoFields.optional(),
				bodyFormat,
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.edit");
			const { siteId: _, entryId, ...change } = input;
			return { entry: await context.services.entries.saveDraft(site, entryId, change) };
		}),

	/**
	 * Deletes an Entry, in two steps. The first call deletes nothing: it answers how many other Entries
	 * link to it (`links`) and a `confirmation` id, valid for 5 minutes. Calling again with that id
	 * deletes it and removes those links on both sides. Refused with `ENTRY_LINKED` while an Entry must
	 * point at it through a required Relationship.
	 */
	delete: signedIn
		.input(z.object({ siteId: id, entryId: id, confirmation: z.string().max(100).optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "entry.delete");
			return await context.services.entries.delete(site, input.entryId, input.confirmation);
		}),

	/** Publishes an Entry's Draft: it goes live at once and the Site's page cache is cleared. */
	publish: signedIn
		.input(z.object({ siteId: id, entryId: id, confirmation: confirmationInput }))
		.use(confirmedPublish((input) => ({ kind: "entry", id: input.entryId })))
		.handler(async ({ context, input }) => {
			const item = { kind: "entry", id: input.entryId } as const;
			const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
			await context.services.publishing.publish(site, item);
			return { entry: await context.services.entries.get(site, input.entryId) };
		}),
};
