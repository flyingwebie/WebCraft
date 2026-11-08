import { INSTALL_NAME_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { onInstall, sensitive } from "../context.ts";
import { adminLanguage } from "../inputs.ts";
import { emailBranding, emailLog, smtp } from "./email.ts";

/** The Install itself, for the Superadmin. */
export const install = {
	settings: {
		/** Install settings › General. */
		get: onInstall("install.manage").handler(({ context }) => context.services.settings.read()),
		/** Changes Install settings › General; an empty name clears it. */
		update: onInstall("install.manage")
			.input(
				z.object({
					name: z.string().trim().max(INSTALL_NAME_MAX_LENGTH).nullable().optional(),
					defaultAdminLanguage: adminLanguage.optional(),
				}),
			)
			.handler(({ context, input }) => context.services.settings.update(input)),
	},
	masterKey: {
		/** Whether the running Master key is confirmed as stored outside the server, and its fingerprint. */
		status: onInstall("install.manage").handler(async ({ context }) => ({
			...(await context.services.masterKey.status()),
			fingerprint: context.services.masterKey.fingerprint,
		})),
		/** The Superadmin confirms the running Master key is stored outside the server. */
		confirmStored: onInstall("install.manage")
			.use(sensitive("masterKey.confirmStored"))
			.handler(async ({ context }) => ({
				...(await context.services.masterKey.confirmStored(context.install)),
				fingerprint: context.services.masterKey.fingerprint,
			})),
	},
	/** Install settings › Security: how the Install checks people's passwords. */
	security: {
		get: onInstall("install.manage").handler(({ context }) => context.services.settings.security()),
		/** Switches the leaked-password check on new passwords on or off. */
		update: onInstall("install.manage")
			.use(sensitive("leakedPasswordCheck.change"))
			.input(z.object({ leakedPasswordCheck: z.boolean() }))
			.handler(({ context, input }) =>
				context.services.settings.setLeakedPasswordCheck(context.install, input.leakedPasswordCheck),
			),
	},
	/** The Install SMTP. */
	smtp,
	/** Install branding of System emails. */
	emailBranding,
	/** The Email log. */
	emailLog,
};
