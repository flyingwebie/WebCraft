import { adminLanguageDirection, can, INSTALL, permissionsOn } from "@webcraft/core";

import { procedure, withPerson } from "../context.ts";
import { personView } from "../views.ts";

/** What the admin needs on every page, signed in or not. */
export const shell = {
	/**
	 * The signed-in person (or null), their Permissions on the Install and the Workspaces they reach,
	 * the Admin language and theme pages are shown in, the setup stage, the Install's name, and which
	 * banners to show.
	 */
	context: procedure.use(withPerson).handler(async ({ context }) => {
		const { services, person } = context;
		const [settings, stage] = await Promise.all([services.settings.read(), services.setup.stage()]);
		const code = person?.adminLanguage ?? settings.defaultAdminLanguage;
		const actor = person ? await services.actors.person(person.id) : null;
		const workspaces = actor ? await services.workspaces.list({ actor, via: context.via }) : [];
		const masterKeyBanner =
			actor && can(actor, "install.manage", INSTALL) ? !(await services.masterKey.status()).stored : false;
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
			banners: { masterKey: masterKeyBanner },
		};
	}),
};
