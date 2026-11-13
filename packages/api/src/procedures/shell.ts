import { adminLanguageDirection, can, INSTALL, permissionsOn } from "@webcraft/core";

import { procedure, withPerson } from "../context.ts";
import { personView } from "../views.ts";

/** What the admin needs on every page, signed in or not. */
export const shell = {
	/**
	 * The signed-in person (or null), their Permissions on the Install and the Workspaces they reach,
	 * the Admin language and theme pages are shown in, the setup stage, the Install's name, and which
	 * banners to show (all for people who manage the Install): the Master key one, the notice that the
	 * Install SMTP is Failing, the notice that the last Backup failed, "Update available" with the
	 * newest release, and Install health's banner while parts of the Install are Failing; where the person stands with two-factor authentication; and the impersonation
	 * going on in this session, if any (`person` is then the person impersonated).
	 */
	context: procedure.use(withPerson).handler(async ({ context }) => {
		const { services, person, acting, session } = context;
		const [settings, stage] = await Promise.all([services.settings.read(), services.setup.stage()]);
		const code = person?.adminLanguage ?? settings.defaultAdminLanguage;
		// While impersonating, the person's access, limited to the Workspaces the impersonation reaches.
		const actor = acting?.access.actor.kind === "person" ? acting.access.actor : null;
		const workspaces = actor && acting ? await services.workspaces.list(acting.access) : [];
		const managesInstall = actor ? can(actor, "install.manage", INSTALL) : false;
		// Install health's banner: for whoever sees Install health (the Superadmin), the parts Failing now.
		const healthFailing = actor && can(actor, "installHealth.manage", INSTALL) ? await services.health.failing() : null;
		// Two-factor authentication is about whoever signed in: never the person they impersonate.
		const twoFactor = session ? await services.twoFactor.status(session.personId) : null;
		const impersonation = acting?.impersonation ?? null;
		const [masterKeyBanner, smtpFailing, backupFailing, update] = managesInstall
			? await Promise.all([
					services.masterKey.status().then((status) => !status.stored),
					// Emails about a Failing Install SMTP would go through it, so this notice is the alert.
					services.email.installSmtp.health().then((health) => health.state === "failing"),
					services.backups.status().then((status) => status.failing),
					services.updates
						.latest()
						.then((check) =>
							check.updateAvailable && check.latest
								? { version: check.latest.version, url: check.latest.url, running: check.running }
								: null,
						),
				])
			: [false, false, false, null];
		return {
			setup: { stage },
			person: person ? personView(person) : null,
			/** The Permissions the person holds on the Install itself. */
			permissions: actor ? permissionsOn(actor, INSTALL) : [],
			/** The Workspaces the person reaches, for the context switcher. */
			workspaces: workspaces.map(({ id, name }) => ({ id, name })),
			language: { code, dir: adminLanguageDirection(code) },
			theme: person?.adminTheme ?? "system",
			install: { name: settings.name, defaultAdminLanguage: settings.defaultAdminLanguage },
			banners: {
				masterKey: masterKeyBanner,
				smtpFailing,
				backupFailing,
				update,
				/** The parts of Install health Failing now, for the banner across the admin; null for people who don't see it. */
				health: healthFailing ? { failing: healthFailing } : null,
			},
			/**
			 * The person's two-factor authentication: `mustSetUp` sends them to add it before anything
			 * else; `reminder` shows the reminder to add it.
			 */
			twoFactor: twoFactor
				? {
						on: twoFactor.on,
						methods: twoFactor.methods,
						required: twoFactor.required,
						mustSetUp: twoFactor.required && !twoFactor.on,
						reminder: twoFactor.reminder && !impersonation,
					}
				: null,
			/**
			 * The impersonation going on in this session, for the banner on every page: who is
			 * impersonated, by whom, and when it ends by itself. Null while there is none.
			 */
			impersonation: impersonation
				? {
						person: impersonation.person,
						impersonator: impersonation.impersonator,
						startedAt: impersonation.startedAt,
						endsAt: impersonation.endsAt,
						/** How long is left now, by the Install's clock (the banner counts down from it). */
						secondsLeft: Math.max(
							0,
							Math.round((impersonation.endsAt.getTime() - services.clock.now().getTime()) / 1000),
						),
					}
				: null,
		};
	}),
};
