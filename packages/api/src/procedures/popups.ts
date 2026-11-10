import { publishPermission } from "@webcraft/core";
import { z } from "zod";
import { confirmationInput, confirmedPublish } from "../confirm.ts";
import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

const target = z.object({ siteId: id, popupId: id });
const publish = (content: boolean) =>
	signedIn
		.input(target.extend({ confirmation: confirmationInput }))
		.use(confirmedPublish((input) => ({ kind: content ? "popupContent" : "popup", id: input.popupId })))
		.handler(async ({ context, input }) => {
			const item = { kind: content ? ("popupContent" as const) : ("popup" as const), id: input.popupId };
			const scope = await context.services.data.site(context.access, input.siteId, publishPermission(item));
			return { published: await context.services.publishing.publish(scope, item) };
		});
export const popups = {
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => ({
		popups: await context.services.popups.list(
			await context.services.data.site(context.access, input.siteId, "site.view"),
		),
	})),
	get: signedIn
		.input(target.extend({ language: z.string().optional() }))
		.handler(async ({ context, input }) =>
			context.services.popups.get(
				await context.services.data.site(context.access, input.siteId, "site.view"),
				input.popupId,
				input.language,
			),
		),
	create: signedIn
		.input(z.object({ siteId: id, name: z.string().min(1).max(120), key: z.string().max(80).optional() }))
		.handler(async ({ context, input }) => ({
			popup: await context.services.popups.create(
				await context.services.data.site(context.access, input.siteId, "structure.edit"),
				input,
			),
		})),
	saveDraft: signedIn
		.input(
			target.extend({
				popup: z.object({
					animation: z.unknown().optional(),
					backdropClose: z.unknown().optional(),
					autoCloseSeconds: z.unknown().optional(),
					afterSubmitCloseSeconds: z.unknown().optional(),
					mainButton: z.unknown().optional(),
					additionalTriggers: z.unknown().optional(),
					layout: z.unknown().optional(),
					barPosition: z.unknown().optional(),
					barBehavior: z.unknown().optional(),
					trigger: z.unknown().optional(),
					rules: z.unknown().optional(),
					frequency: z.unknown().optional(),
				}),
			}),
		)
		.handler(async ({ context, input }) => ({
			popup: await context.services.popups.saveDraft(
				await context.services.data.site(context.access, input.siteId, "structure.edit"),
				input.popupId,
				input.popup,
			),
		})),
	saveContent: signedIn
		.input(target.extend({ language: z.string().optional(), values: z.record(z.string(), z.unknown()) }))
		.handler(async ({ context, input }) =>
			context.services.popups.saveContent(
				await context.services.data.site(context.access, input.siteId, "entry.edit"),
				input.popupId,
				input,
			),
		),
	publish: publish(false),
	publishContent: publish(true),
	delete: signedIn
		.input(target.extend({ confirmation: confirmationInput }))
		.handler(async ({ context, input }) =>
			context.services.popups.delete(
				await context.services.data.site(context.access, input.siteId, "structure.edit"),
				input.popupId,
				input.confirmation,
			),
		),
};
