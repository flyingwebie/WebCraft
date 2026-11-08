import { adminLanguageDirection, can, INSTALL, permissionsOn } from "@webcraft/core";

import { procedure, withPerson } from "../context.ts";
import { personView } from "../views.ts";

/** What the admin needs on every page, signed in or not. */
export const shell = {
	/**
	 * The signed-in person (or null) and their Permissions on the Install, the Admin language and
	 * theme pages are shown in, the setup stage, the Install's name, and which banners to show.
	 */
	context: procedure.use(withPerson).handler(async ({ context }) => {
		const { services, person } = context;
		const [settings, stage] = await Promise.all([services.settings.read(), services.setup.stage()]);
		const code = person?.adminLanguage ?? settings.defaultAdminLanguage;
		const actor = person ? await services.actors.person(person.id) : null;
		const masterKeyBanner =
			actor && can(actor, "install.manage", INSTALL) ? !(await services.masterKey.status()).stored : false;
		return {
			setup: { stage },
			person: person ? personView(person) : null,
			/** The Permissions the person holds on the Install itself. */
			permissions: actor ? permissionsOn(actor, INSTALL) : [],
			language: { code, dir: adminLanguageDirection(code) },
			theme: person?.adminTheme ?? "system",
			install: { name: settings.name, defaultAdminLanguage: settings.defaultAdminLanguage },
			banners: { masterKey: masterKeyBanner },
		};
	}),
};
