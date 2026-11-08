import { adminLanguageDirection } from "@webcraft/core";

import { procedure, withPerson } from "../context.ts";
import { personView } from "../views.ts";

/** What the admin needs on every page, signed in or not. */
export const shell = {
	/**
	 * The signed-in person (or null), the Admin language and theme pages are shown in, the setup
	 * stage, the Install's name, and which banners to show.
	 */
	context: procedure.use(withPerson).handler(async ({ context }) => {
		const { services, person } = context;
		const [settings, stage] = await Promise.all([services.settings.read(), services.setup.stage()]);
		const code = person?.adminLanguage ?? settings.defaultAdminLanguage;
		const masterKeyBanner = person?.installRole === "superadmin" ? !(await services.masterKey.status()).stored : false;
		return {
			setup: { stage },
			person: person ? personView(person) : null,
			language: { code, dir: adminLanguageDirection(code) },
			theme: person?.adminTheme ?? "system",
			install: { name: settings.name, defaultAdminLanguage: settings.defaultAdminLanguage },
			banners: { masterKey: masterKeyBanner },
		};
	}),
};
