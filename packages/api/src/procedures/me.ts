import { ADMIN_THEMES, SYSTEM_EMAIL_TYPE_IDS } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { adminLanguage } from "../inputs.ts";
import { personView } from "../views.ts";

/** The signed-in person's own account. */
export const me = {
	/**
	 * Changes the person's own admin preferences: their Admin language (null follows the Install's
	 * default) and light or dark (or `system`, following the device).
	 */
	updatePreferences: signedIn
		.input(
			z.object({ adminLanguage: adminLanguage.nullable().optional(), adminTheme: z.enum(ADMIN_THEMES).optional() }),
		)
		.handler(async ({ context, input }) => ({
			person: personView(await context.services.people.updatePreferences(context.person.id, input)),
		})),

	/** The person's email switches: work and alert emails can be turned off; security emails always go. */
	emails: {
		/** Every System email type, by category, with whether the person gets it. */
		get: signedIn.handler(async ({ context }) => ({
			emails: await context.services.email.preferences.read(context.person.id),
		})),
		/** Sets exactly which work and alert emails the person turned off; every other type is on. */
		update: signedIn
			.input(z.object({ turnedOff: z.array(z.enum(SYSTEM_EMAIL_TYPE_IDS)).max(100) }))
			.handler(async ({ context, input }) => ({
				emails: await context.services.email.preferences.update(context.person.id, input.turnedOff),
			})),
	},
};
