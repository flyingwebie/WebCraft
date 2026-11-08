import { ADMIN_THEMES, SYSTEM_EMAIL_TYPE_IDS } from "@webcraft/core";
import { z } from "zod";

import { sensitive, setCookies, signedIn } from "../context.ts";
import { adminLanguage, id, password } from "../inputs.ts";
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

	/** The browsers the person is signed in with: see them, and sign them out. */
	sessions: {
		/** Every session that hasn't ended: browser, system, network, when it started and was last used. */
		list: signedIn.handler(async ({ context }) => ({
			sessions: await context.services.account.sessions(context.session),
		})),
		/** Signs one of the person's sessions out at once; for this browser's own session, as signing out does. */
		revoke: signedIn.input(z.object({ sessionId: id })).handler(async ({ context, input }) => {
			const { services, access, session } = context;
			const { wasCurrent } = await services.account.revokeSession(access, session, input.sessionId);
			if (wasCurrent) setCookies(context, (await services.auth.signOut(context.headers)).setCookie);
			return { ok: true as const };
		}),
		/** Signs out every other session of the person, keeping this browser signed in. */
		revokeOthers: signedIn.handler(async ({ context }) =>
			context.services.account.revokeOtherSessions(context.access, context.session),
		),
	},

	/**
	 * Changes the person's password (a Sensitive action) and signs out their other sessions; this
	 * browser stays signed in.
	 */
	changePassword: signedIn
		.use(sensitive("password.change"))
		.input(z.object({ newPassword: password }))
		.handler(async ({ context, input }) => {
			const { signedOutSessions } = await context.services.account.changePassword(
				context.access,
				context.session,
				input.newPassword,
			);
			return { signedOutSessions };
		}),

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
