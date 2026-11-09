import { publishPermission } from "@webcraft/core";
import { z } from "zod";

import { sensitive, signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** A Form's name, as people call it; the server checks its length. */
const formName = z.string().max(400);

/** A Form's key, as `{{@form <key>}}` names it; the server checks its form. */
const formKey = z.string().max(200);

/**
 * A change to a Form's Draft: each part given replaces that part. Fields are checked by the server,
 * which answers every problem where it is (`FORM_INVALID`, `data.problems`).
 */
const formChange = z.object({
	fields: z.array(z.unknown()).max(1000).optional(),
	submitLabel: z.unknown().optional(),
	success: z.unknown().optional(),
	spam: z.unknown().optional(),
});

/**
 * Forms (GLOSSARY.md): what visitors fill in on a Site, placed with `{{@form <key>}}`. Structure,
 * with a Draft and a published version: Staff build and publish them.
 */
export const forms = {
	/** The Site's Forms, by name, each with where it is placed. */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { forms: await context.services.forms.list(site) };
	}),

	/** One Form: its Draft and published version, with the Templates and Components placing it. */
	get: signedIn.input(z.object({ siteId: id, formId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return context.services.forms.get(site, input.formId);
	}),

	/** Creates a Form with its name (and key, made from the name when not given), as a Draft with no fields. */
	create: signedIn
		.input(z.object({ siteId: id, name: formName, key: formKey.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { form: await context.services.forms.create(site, { name: input.name, key: input.key }) };
		}),

	/**
	 * Saves a Form's Draft: its fields (the full list, in order), its button, what happens once it is
	 * sent and its spam limits, each part given replacing that part. Visitors see nothing until it is
	 * published.
	 */
	saveDraft: signedIn
		.input(z.object({ siteId: id, formId: id, form: formChange }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { form: await context.services.forms.saveDraft(site, input.formId, input.form) };
		}),

	/** Publishes a Form's Draft: what visitors fill in from now on. */
	publish: signedIn.input(z.object({ siteId: id, formId: id })).handler(async ({ context, input }) => {
		const item = { kind: "form", id: input.formId } as const;
		const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
		const published = await context.services.publishing.publish(site, item);
		return { published, ...(await context.services.forms.get(site, input.formId)) };
	}),

	/** Changes a Form's name or key: every Template and Component placing it writes the new key at once. */
	rename: signedIn
		.input(z.object({ siteId: id, formId: id, name: formName.optional(), key: formKey.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return { form: await context.services.forms.rename(site, input.formId, { name: input.name, key: input.key }) };
		}),

	/** The Site's CAPTCHA for its Forms: its settings, and whether its secret key is set (never the key). */
	captcha: {
		get: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.forms.captcha.get(site);
		}),

		/**
		 * Sets the Site's CAPTCHA (the provider's script, where answers are checked, the Site's public
		 * key, the field the widget fills in and the class its element takes), with the secret key when
		 * it changes; null switches it off and forgets the key. A Sensitive action.
		 */
		set: signedIn
			.use(sensitive("formCaptcha.change"))
			.input(
				z.object({
					siteId: id,
					captcha: z.record(z.string(), z.unknown()).nullable(),
					secret: z.string().max(4000).optional(),
				}),
			)
			.handler(async ({ context, input }) => {
				const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
				return context.services.forms.captcha.set(site, { captcha: input.captcha, secret: input.secret });
			}),
	},

	/**
	 * Deletes a Form, in two steps: the first call answers a confirmation, the second (with its id)
	 * deletes it. Refused while a Template or Component places it (`FORM_IN_USE`).
	 */
	delete: signedIn
		.input(z.object({ siteId: id, formId: id, confirmation: z.string().max(100).optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "structure.edit");
			return context.services.forms.delete(site, input.formId, input.confirmation);
		}),
};
