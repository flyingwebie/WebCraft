import { ADMIN_THEMES, SYSTEM_EMAIL_TYPE_IDS } from "@webcraft/core";
import { z } from "zod";

import {
	inAdminSession,
	inAdminSessionBeforeTwoFactor,
	notWhileImpersonating,
	sensitive,
	setCookies,
	signedIn,
	signedInBeforeTwoFactor,
} from "../context.ts";
import { adminLanguage, authenticatorCode, id, password, registrationCredential } from "../inputs.ts";
import { personView } from "../views.ts";

/** The signed-in person's own account. */
export const me = {
	/**
	 * Changes the person's own admin preferences: their Admin language (null follows the Install's
	 * default) and light or dark (or `system`, following the device).
	 */
	updatePreferences: signedInBeforeTwoFactor
		.use(notWhileImpersonating("preferences"))
		.input(
			z.object({ adminLanguage: adminLanguage.nullable().optional(), adminTheme: z.enum(ADMIN_THEMES).optional() }),
		)
		.handler(async ({ context, input }) => ({
			person: personView(await context.services.people.updatePreferences(context.person.id, input)),
		})),

	/** The browsers the person is signed in with: see them, and sign them out. */
	sessions: {
		/** Every session that hasn't ended: browser, system, network, when it started and was last used. */
		list: inAdminSession.handler(async ({ context }) => ({
			// While impersonating, the person's own sessions, none of them this browser's.
			sessions: await context.services.account.sessions(
				context.person.id,
				context.impersonation ? null : context.session.id,
			),
		})),
		/** Signs one of the person's sessions out at once; for this browser's own session, as signing out does. */
		revoke: inAdminSession
			.use(notWhileImpersonating("sessions"))
			.input(z.object({ sessionId: id }))
			.handler(async ({ context, input }) => {
				const { services, access, session } = context;
				const { wasCurrent } = await services.account.revokeSession(access, session, input.sessionId);
				if (wasCurrent) setCookies(context, (await services.auth.signOut(context.headers)).setCookie);
				return { ok: true as const };
			}),
		/** Signs out every other session of the person, keeping this browser signed in. */
		revokeOthers: inAdminSession
			.use(notWhileImpersonating("sessions"))
			.handler(async ({ context }) => context.services.account.revokeOtherSessions(context.access, context.session)),
	},

	/**
	 * Changes the person's password (a Sensitive action) and signs out their other sessions; this
	 * browser stays signed in.
	 */
	changePassword: inAdminSession
		.use(notWhileImpersonating("password"))
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

	/**
	 * Two-factor authentication: the person's authenticator app, passkeys and backup codes. Adding or
	 * removing one is a Sensitive action, emailed to them, and signs out their other sessions. These
	 * stay open to a person who must add it before anything else.
	 */
	twoFactor: {
		/** The person's second factors, how many backup codes are left, and whether it is required of them. */
		get: inAdminSessionBeforeTwoFactor.handler(async ({ context }) => {
			const { services, person } = context;
			const [factors, status] = await Promise.all([
				services.twoFactor.factors(person.id),
				services.twoFactor.status(person.id),
			]);
			return {
				authenticator: factors.authenticator,
				passkeys: factors.passkeys,
				backupCodes: { left: factors.backupCodesLeft },
				required: status.required,
				requiredBy: status.requiredBy,
			};
		}),

		/**
		 * Starts adding an authenticator app: answers a new secret, as text and as the address its QR
		 * code holds. Nothing changes until `confirmAuthenticator` gets a code from the app.
		 */
		startAuthenticator: inAdminSessionBeforeTwoFactor
			.use(notWhileImpersonating("twoFactor"))
			.use(sensitive("twoFactor.change"))
			.handler(({ context }) => context.services.twoFactor.startAuthenticator(context.access, context.person)),

		/**
		 * Adds the authenticator app once a code from it is right. When it is the person's first second
		 * factor, answers their 10 backup codes, shown this once.
		 */
		confirmAuthenticator: inAdminSessionBeforeTwoFactor
			.use(notWhileImpersonating("twoFactor"))
			.use(sensitive("twoFactor.change"))
			.input(z.object({ code: authenticatorCode }))
			.handler(({ context, input }) =>
				context.services.twoFactor.confirmAuthenticator(context.access, context.session, input.code),
			),

		/** Removes the authenticator app. */
		removeAuthenticator: inAdminSession
			.use(notWhileImpersonating("twoFactor"))
			.use(sensitive("twoFactor.change"))
			.handler(({ context }) => context.services.twoFactor.removeAuthenticator(context.access, context.session)),

		/**
		 * Starts adding a passkey: options for the person's device (the admin's hostname as the relying
		 * party, user verification required). The device's answer goes to `addPasskey`.
		 */
		passkeyOptions: inAdminSessionBeforeTwoFactor
			.use(notWhileImpersonating("twoFactor"))
			.use(sensitive("twoFactor.change"))
			.handler(async ({ context }) => ({
				options: await context.services.twoFactor.passkeyOptions(context.access, context.person),
			})),

		/**
		 * Adds the passkey the device made, under the name the person gives it. When it is their first
		 * second factor, answers their 10 backup codes, shown this once.
		 */
		addPasskey: inAdminSessionBeforeTwoFactor
			.use(notWhileImpersonating("twoFactor"))
			.use(sensitive("twoFactor.change"))
			.input(z.object({ credential: registrationCredential, name: z.string().trim().min(1).max(100) }))
			.handler(({ context, input }) =>
				context.services.twoFactor.addPasskey(context.access, context.session, input.credential, input.name),
			),

		/** Removes one of the person's passkeys. */
		removePasskey: inAdminSession
			.use(notWhileImpersonating("twoFactor"))
			.use(sensitive("twoFactor.change"))
			.input(z.object({ passkeyId: id }))
			.handler(({ context, input }) =>
				context.services.twoFactor.removePasskey(context.access, context.session, input.passkeyId),
			),

		/** Replaces the backup codes with 10 new ones, answered this once; the old ones stop working. */
		regenerateBackupCodes: inAdminSession
			.use(notWhileImpersonating("twoFactor"))
			.use(sensitive("twoFactor.change"))
			.handler(({ context }) => context.services.twoFactor.regenerateBackupCodes(context.access)),

		/** "Remind me later": hides the reminder to add two-factor authentication for 7 days. */
		remindLater: inAdminSession
			.use(notWhileImpersonating("twoFactor"))
			.handler(({ context }) => context.services.twoFactor.remindLater(context.person.id)),
	},

	/**
	 * What the person did, anywhere on the Install, newest first (Your account › Activity): as
	 * themselves, and what the Superadmin or Staff did as them while impersonating them ("<Staff> as
	 * <you>"), and, for Staff, what they did as others. While impersonating, the Workspaces the
	 * impersonation reaches only.
	 */
	activity: signedIn
		.input(
			z
				.object({
					after: z
						.string()
						.regex(/^\d{1,18}$/)
						.optional(),
					limit: z.number().int().min(1).max(200).default(50),
				})
				.default({ limit: 50 }),
		)
		.handler(({ context, input }) =>
			context.services.audit.activity(context.person.id, {
				...input,
				workspaceIds: context.impersonation?.workspaceIds ?? null,
			}),
		),

	/** The person's email switches: work and alert emails can be turned off; security emails always go. */
	emails: {
		/** Every System email type, by category, with whether the person gets it. */
		get: signedIn.handler(async ({ context }) => ({
			emails: await context.services.email.preferences.read(context.person.id),
		})),
		/** Sets exactly which work and alert emails the person turned off; every other type is on. */
		update: signedIn
			.use(notWhileImpersonating("preferences"))
			.input(z.object({ turnedOff: z.array(z.enum(SYSTEM_EMAIL_TYPE_IDS)).max(100) }))
			.handler(async ({ context, input }) => ({
				emails: await context.services.email.preferences.update(context.person.id, input.turnedOff),
			})),
	},
};
