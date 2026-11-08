import { INSTALL_NAME_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { superadminOnly } from "../context.ts";
import { adminLanguage } from "../inputs.ts";
import { emailBranding, emailLog, smtp } from "./email.ts";

/** The Install itself, for the Superadmin. */
export const install = {
	settings: {
		/** Install settings › General. */
		get: superadminOnly.handler(({ context }) => context.services.settings.read()),
		/** Changes Install settings › General; an empty name clears it. */
		update: superadminOnly
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
		status: superadminOnly.handler(async ({ context }) => ({
			...(await context.services.masterKey.status()),
			fingerprint: context.services.masterKey.fingerprint,
		})),
		/** The Superadmin confirms the running Master key is stored outside the server. */
		confirmStored: superadminOnly.handler(async ({ context }) => ({
			...(await context.services.masterKey.confirmStored(context.person.id)),
			fingerprint: context.services.masterKey.fingerprint,
		})),
	},
	/** The Install SMTP. */
	smtp,
	/** Install branding of System emails. */
	emailBranding,
	/** The Email log. */
	emailLog,
};
