import { z } from "zod";
import { signedIn } from "../context.ts";
import { language } from "../fields.ts";
import { id } from "../inputs.ts";

const text = z.string().trim().min(1).max(5000);
const url = z
	.string()
	.trim()
	.max(2000)
	.url()
	.refine((value) => /^https:\/\//i.test(value));
const contact = z
	.string()
	.trim()
	.max(2000)
	.refine((value) => /^https:\/\/[^\s]+$/i.test(value) || /^mailto:[^\s@]+@[^\s@]+$/i.test(value));
const date = z.iso.date();
export const accessibilityStatement = {
	get: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const scope = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { settings: await context.services.accessibilityStatement.get(scope) };
	}),
	generate: signedIn
		.input(
			z.object({
				siteId: id,
				language: language.optional(),
				organisation: text,
				website: url,
				standard: text,
				status: z.enum(["notAssessed", "full", "partial", "notCompliant"]),
				limitations: text,
				burden: text,
				excluded: text,
				alternatives: text,
				preparedOn: date,
				reviewedOn: date,
				method: text,
				feedback: text,
				feedbackUrl: contact,
				enforcement: text,
				enforcementUrl: url,
			}),
		)
		.handler(async ({ context, input }) => {
			const scope = await context.services.data.site(context.access, input.siteId, "structure.edit");
			const { siteId: _, language, ...form } = input;
			return context.services.accessibilityStatement.generate(scope, form, language);
		}),
	setEnabled: signedIn.input(z.object({ siteId: id, enabled: z.boolean() })).handler(async ({ context, input }) => {
		const scope = await context.services.data.site(context.access, input.siteId, "structure.edit");
		return { settings: await context.services.accessibilityStatement.setEnabled(scope, input.enabled) };
	}),
};
