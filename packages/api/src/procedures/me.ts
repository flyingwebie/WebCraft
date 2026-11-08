import { ADMIN_THEMES } from "@webcraft/core";
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
};
