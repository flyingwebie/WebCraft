import { JSON_SCHEMA_REGISTRY, ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { type Access, can, type InstallServices, PermissionDeniedError, publishPermission } from "@webcraft/core";
import {
	FORM_AUTOCOMPLETE,
	FORM_CONDITION_OPS,
	FORM_FIELD_TYPES,
	FORM_FIELD_WIDTHS,
	FORM_LIMITS,
	FORM_UPLOAD_FORMATS,
	type FormUploadFormat,
} from "@webcraft/renderer";
import { z } from "zod";

import { confirmationInput, confirmedPublish } from "../confirm.ts";
import { onSite, sensitive, signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/**
 * The Site opened for reading its Forms: by Staff (Structure), and by the clients who change a Form's
 * emails (`formEmails.edit`: Owners and Editors), who see each Form's Submissions and Emails. Never
 * Authors.
 */
async function formsReader(context: { services: InstallServices; access: Access }, siteId: string) {
	const site = await context.services.data.site(context.access, siteId, "site.view");
	const resource = { level: "site", workspaceId: site.workspace.id, siteId: site.site.id } as const;
	if (
		!can(context.access.actor, "structure.edit", resource) &&
		!can(context.access.actor, "formEmails.edit", resource)
	) {
		throw new PermissionDeniedError("formEmails.edit");
	}
	return site;
}

/** A change to a Form's emails Draft: each part given replaces that part; the server checks them. */
const emailsChange = z.object({
	notifications: z.array(z.unknown()).max(100).optional(),
	autoReply: z.unknown().optional(),
	/** How much of a Submission's Form uploads its Notifications attach, in bytes (0 to 25 MB). */
	attachmentsMaxBytes: z.number().optional(),
});

/** A Form's name, as people call it; the server checks its length. */
const formName = z.string().max(400);

/** A Form's key, as `{{@form <key>}}` names it; the server checks its form. */
const formKey = z.string().max(200);

/** Text in a Form: as written, or with its own text in other languages by BCP 47 tag. */
const formText = z.union([
	z.string(),
	z.object({ text: z.string(), translations: z.record(z.string(), z.string()).optional() }),
]);

/** A setting left unset: null, or left out. */
const unset = <Schema extends z.ZodType>(schema: Schema) => schema.nullable().optional();

/**
 * What one item of a Form's fields holds, for the API's document only: its settings as
 * `@webcraft/renderer`'s `FormField` keeps them. Nothing is checked against it (see `formItem`).
 */
const formItemShape = z.object({
	key: z
		.string()
		.max(FORM_LIMITS.keyLength)
		.describe("Names its value in Submissions: a lower-case letter, then lower-case letters, digits and underscores."),
	type: z
		.enum(FORM_FIELD_TYPES)
		.describe(
			"A field visitors fill in, or a section or a step: those hold the items after them and no value. Each type takes only its own settings.",
		),
	label: formText,
	hideLabel: unset(z.boolean()),
	help: unset(formText),
	placeholder: unset(formText),
	message: unset(formText).describe("The error shown for a value the field refuses, in place of WebCraft's own words."),
	required: unset(z.boolean()),
	width: z
		.enum(FORM_FIELD_WIDTHS)
		.nullable()
		.default("whole")
		.describe(
			"How much of a line the field takes on a page: fields narrower than the whole line sit side by side and wrap; under a narrow width every field is whole. A section or a step has no width (null).",
		),
	minLength: unset(z.number()),
	maxLength: unset(z.number()),
	pattern: unset(z.string().max(FORM_LIMITS.patternLength)),
	autocomplete: unset(z.enum(FORM_AUTOCOMPLETE)),
	min: unset(z.number()),
	max: unset(z.number()),
	integer: unset(z.boolean()),
	minDate: unset(z.string()).describe("The earliest day, such as 2026-03-02."),
	maxDate: unset(z.string()).describe("The latest day, such as 2026-03-02."),
	options: z
		.array(z.object({ value: z.string().max(FORM_LIMITS.optionValueLength), label: formText }))
		.max(FORM_LIMITS.options)
		.optional(),
	minChoices: unset(z.number()),
	maxChoices: unset(z.number()),
	source: unset(
		z.union([
			z.object({ kind: z.literal("query"), name: z.string() }),
			z.object({ kind: z.literal("page") }),
			z.object({ kind: z.literal("fixed"), value: z.string() }),
		]),
	).describe("A hidden field's value: a parameter of the page's address, the page's address, or fixed text."),
	accept: z
		.array(z.enum(Object.keys(FORM_UPLOAD_FORMATS) as [FormUploadFormat, ...FormUploadFormat[]]))
		.optional()
		.describe("The file formats a file field takes."),
	maxFileBytes: unset(z.number()),
	maxFiles: unset(z.number()),
	condition: unset(
		z.object({
			match: z.enum(["all", "any"]),
			rules: z
				.array(
					z.object({
						field: z.string(),
						op: z.enum(FORM_CONDITION_OPS),
						value: unset(z.union([z.string(), z.number()])),
					}),
				)
				.max(FORM_LIMITS.conditionRules),
		}),
	).describe("When the item shows: rules about the values of fields before it."),
});

/**
 * One item of a Form's fields, as a procedure takes it: anything, since the server checks every
 * setting against the item's type and answers each problem where it is (`FORM_INVALID` at
 * `fields[2].width`), which a schema refusing the whole request couldn't. The API's document
 * describes it by `formItemShape` instead.
 */
const formItem = z.unknown();
// The registry types a schema's own JSON Schema by that schema's values; this one is another schema's.
JSON_SCHEMA_REGISTRY.add(
	formItem,
	new ZodToJsonSchemaConverter().convert(formItemShape, { strategy: "input" })[1] as object,
);

/**
 * A change to a Form's Draft: each part given replaces that part. Fields are checked by the server,
 * which answers every problem where it is (`FORM_INVALID`, `data.problems`).
 */
const formChange = z.object({
	fields: z.array(formItem).max(1000).optional(),
	submitLabel: z.unknown().optional(),
	success: z.unknown().optional(),
	spam: z.unknown().optional(),
});

/**
 * Forms (GLOSSARY.md): what visitors fill in on a Site, placed with `{{@form <key>}}`. Structure,
 * with a Draft and a published version: Staff build and publish them. A Form's emails (its
 * Notifications and Auto-reply) are Content with a Draft of their own: Staff, Owners and Editors
 * change and publish them (`formEmails.edit`).
 */
export const forms = {
	/** The Site's Forms, by name, each with where it is placed (Staff, and the clients who change their emails). */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await formsReader(context, input.siteId);
		return { forms: await context.services.forms.list(site) };
	}),

	/** One Form: its Draft and published version and its emails, with the Templates and Components placing it. */
	get: signedIn.input(z.object({ siteId: id, formId: id })).handler(async ({ context, input }) => {
		const site = await formsReader(context, input.siteId);
		return context.services.forms.get(site, input.formId);
	}),

	/**
	 * Saves a Form's emails Draft: its Notifications (the full list) and its Auto-reply, each part
	 * given replacing that part. A Submission sets off nothing different until they are published.
	 * A change to who receives Submissions (a Notification's recipients or routing) is the Sensitive
	 * action `formRecipients.change`, which `services.forms.saveEmails` checks itself: only that kind
	 * of change is one, so the procedure carries no `sensitive(…)` of its own.
	 */
	saveEmails: signedIn
		.input(z.object({ siteId: id, formId: id, emails: emailsChange }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "formEmails.edit");
			return { form: await context.services.forms.saveEmails(site, input.formId, input.emails) };
		}),

	/** Publishes a Form's emails Draft: what each Submission sets off from now on. */
	publishEmails: signedIn
		.input(z.object({ siteId: id, formId: id, confirmation: confirmationInput }))
		.use(confirmedPublish((input) => ({ kind: "formEmails", id: input.formId })))
		.handler(async ({ context, input }) => {
			const item = { kind: "formEmails", id: input.formId } as const;
			const site = await context.services.data.site(context.access, input.siteId, publishPermission(item));
			const published = await context.services.publishing.publish(site, item);
			return { published, ...(await context.services.forms.get(site, input.formId)) };
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
	publish: signedIn
		.input(z.object({ siteId: id, formId: id, confirmation: confirmationInput }))
		.use(confirmedPublish((input) => ({ kind: "form", id: input.formId })))
		.handler(async ({ context, input }) => {
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
			.input(
				z.object({
					siteId: id,
					captcha: z.record(z.string(), z.unknown()).nullable(),
					secret: z.string().max(4000).optional(),
				}),
			)
			.use(onSite("structure.edit"))
			.use(sensitive("formCaptcha.change"))
			.handler(async ({ context, input }) =>
				context.services.forms.captcha.set(context.site, { captcha: input.captcha, secret: input.secret }),
			),
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
