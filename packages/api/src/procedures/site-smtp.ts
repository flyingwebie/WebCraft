import { type InstallServices, SITE_FROM_NAME_MAX_LENGTH, type SiteScope, SMTP_SECURITY } from "@webcraft/core";
import { z } from "zod";

import { onSite, sensitive, signedIn } from "../context.ts";
import { email, id } from "../inputs.ts";
import { host, smtpPassword } from "./email.ts";

/** A sender name: one line, no control characters. */
const fromName = z
	.string()
	.trim()
	.max(SITE_FROM_NAME_MAX_LENGTH)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
	.regex(/^[^\u0000-\u001f\u007f]*$/, "one line")
	.nullable();

/** A Site's own mail server, as the admin's form sends it. */
const server = z.object({
	host,
	port: z.number().int().min(1).max(65_535),
	security: z.enum(SMTP_SECURITY),
	username: z.string().trim().max(320).nullable(),
	fromAddress: email,
	password: smtpPassword.nullable().optional(),
});

/** A Site's email settings, as the admin's form sends them: null `server` for the Install SMTP. */
const settings = { fromName, replyTo: email.nullable(), server: server.nullable() };

/**
 * A Site's email settings and its own mail server, its Site SMTP (Site settings, Structure: Staff,
 * `structure.edit`): the sender name and reply-to of the Site's mail (Notifications, Auto-replies), and
 * the server it goes through. Changing them is a Sensitive action (`siteSmtp.change`), saved at once
 * and recorded in the Audit log, never with the password.
 */
export const siteSmtp = {
	/** The settings (the password only as set, with its last 4 characters), the Site's name and how its server has been doing. */
	get: signedIn
		.input(z.object({ siteId: id }))
		.use(onSite("structure.edit"))
		.handler(async ({ context }) => siteSmtpView(context)),

	/** Changes them all at once. Without `server.password` the stored password is kept; without `server` it is forgotten. */
	update: signedIn
		.input(z.object({ siteId: id, ...settings }))
		.use(onSite("structure.edit"))
		.use(sensitive("siteSmtp.change"))
		.handler(async ({ context, input }) => {
			await context.services.email.siteSmtp.update(context.site, {
				fromName: input.fromName,
				replyTo: input.replyTo,
				server: input.server,
			});
			return siteSmtpView(context);
		}),

	/**
	 * Sends a test email at once, as the Site's mail would go with the settings in the form (which may
	 * not be saved yet), and answers whether the server took it, with its reply. Without a password the
	 * stored one is used; without a server it goes through the Install SMTP under the Site's name. The
	 * server's host must resolve to addresses on the public internet (unless the Superadmin lets Sites
	 * use servers inside the Install's network); otherwise, and when nothing answers there as a mail
	 * server, `response` is one fixed reason, never what was found.
	 */
	sendTest: signedIn
		.input(z.object({ siteId: id, to: email, ...settings }))
		.use(onSite("structure.edit"))
		.handler(async ({ context, input }) => {
			const { services, person } = context;
			const language = person.adminLanguage ?? (await services.settings.read()).defaultAdminLanguage;
			const result = await services.email.siteSmtp.sendTest(context.site, {
				to: input.to,
				settings: { fromName: input.fromName, replyTo: input.replyTo, server: input.server },
				personId: person.id,
				language,
			});
			return { status: result.status, response: result.response };
		}),
};

/** The Site's email settings as the admin shows them. */
async function siteSmtpView({ services, site }: { services: InstallServices; site: SiteScope }) {
	const [settings, health] = await Promise.all([
		services.email.siteSmtp.read(site),
		services.email.siteSmtp.health(site),
	]);
	return { settings, siteName: site.site.name, health };
}
