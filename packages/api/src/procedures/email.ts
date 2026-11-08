import {
	categoryOf,
	DEFAULT_ACCENT_COLOUR,
	FOOTER_MAX_LENGTH,
	type InstallServices,
	isAccentColour,
	isLogoUrl,
	isSystemEmailType,
	SENDER_NAME_MAX_LENGTH,
	SMTP_SECURITY,
} from "@webcraft/core";
import { z } from "zod";

import { onInstall, sensitive } from "../context.ts";
import { email } from "../inputs.ts";

/**
 * Who may manage the Install SMTP, Install branding and the Email log: people who manage the
 * Install (`install.manage`, the Superadmin).
 */
const emailAdmin = onInstall("install.manage");

/** A mail server's hostname or IP address. */
const host = z
	.string()
	.trim()
	.min(1)
	.max(253)
	.regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|[0-9A-Fa-f:]+)$/);

/** An SMTP server's settings, as the admin's form sends them. */
const smtpSettings = z.object({
	host,
	port: z.number().int().min(1).max(65_535),
	security: z.enum(SMTP_SECURITY),
	username: z.string().trim().max(320).nullable(),
	fromAddress: email,
	replyTo: email.nullable(),
});

/** A password typed into the admin: a new one, null to remove it, absent to keep the stored one. */
const smtpPassword = z.string().min(1).max(1024);

/** The Install SMTP, for the Superadmin. */
export const smtp = {
	/** Its settings (the password only as set, with its last 4 characters) and how it has been doing. */
	get: emailAdmin.handler(async ({ context }) => installSmtpView(context.services)),

	/** Sets it. The password is stored as a secret; leave it out to keep the stored one. */
	update: emailAdmin
		.use(sensitive("installSmtp.change"))
		.input(smtpSettings.extend({ password: smtpPassword.nullable().optional() }))
		.handler(async ({ context, input }) => {
			await context.services.email.installSmtp.update(context.install, input);
			return installSmtpView(context.services);
		}),

	/**
	 * Sends a test email at once through the settings in the form, which may not be saved yet, and
	 * answers whether the server took it, with its reply. Without `password`, the stored one is used.
	 */
	sendTest: emailAdmin
		.input(z.object({ to: email, settings: smtpSettings, password: smtpPassword.optional() }))
		.handler(async ({ context, input }) => {
			const { services, person } = context;
			const language = person.adminLanguage ?? (await services.settings.read()).defaultAdminLanguage;
			const result = await services.email.sendTest({
				to: input.to,
				language,
				smtp: input.settings,
				password: input.password,
				personId: person.id,
			});
			return { status: result.status, response: result.response };
		}),
};

async function installSmtpView(services: InstallServices) {
	const { installSmtp } = services.email;
	const [settings, health] = await Promise.all([installSmtp.read(), installSmtp.health()]);
	return { settings, health };
}

/** The Email log, for the Superadmin. */
export const emailLog = {
	/** Every email the Install sent, newest first, a page at a time. Never an email's body. */
	list: emailAdmin
		.input(z.object({ after: z.string().max(200).nullish(), limit: z.number().int().min(1).max(200).optional() }))
		.handler(async ({ context, input }) => {
			const page = await context.services.email.emailLog.list(input);
			return {
				lines: page.lines.map((line) => ({
					...line,
					category: isSystemEmailType(line.type) ? categoryOf(line.type) : null,
				})),
				next: page.next,
			};
		}),
};

/** Install branding, for the Superadmin: what every System email carries. */
export const emailBranding = {
	/** The values the Superadmin set (null: the default) and the defaults they replace. */
	get: emailAdmin.handler(async ({ context }) => brandingView(context.services)),

	/** Changes the given values; null puts one back to its default. */
	update: emailAdmin
		.input(
			z.object({
				senderName: z.string().trim().max(SENDER_NAME_MAX_LENGTH).nullish(),
				logoUrl: z
					.string()
					.trim()
					.refine((value) => value === "" || isLogoUrl(value), "an HTTPS address")
					.nullish(),
				accentColour: z
					.string()
					.trim()
					.refine((value) => value === "" || isAccentColour(value), "a colour such as #c2410c")
					.nullish(),
				footer: z.string().trim().max(FOOTER_MAX_LENGTH).nullish(),
			}),
		)
		.handler(async ({ context, input }) => {
			await context.services.email.branding.update(input);
			return brandingView(context.services);
		}),
};

async function brandingView(services: InstallServices) {
	const [values, settings] = await Promise.all([services.email.branding.read(), services.settings.read()]);
	return {
		...values,
		defaults: { senderName: settings.name ?? "WebCraft", accentColour: DEFAULT_ACCENT_COLOUR },
	};
}
