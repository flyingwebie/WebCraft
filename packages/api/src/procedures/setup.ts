import { z } from "zod";

import { onInstall, procedure, setCookies } from "../context.ts";
import { adminLanguage, email, password, personName } from "../inputs.ts";

const token = z.string().max(512);

/** The setup wizard: claiming a fresh Install with the setup token printed in the web log. */
export const setup = {
	/** Where the Install is in its setup: `claim`, `continue` or `done`. */
	state: procedure.handler(async ({ context }) => ({ stage: await context.services.setup.stage() })),

	/** Checks a setup token before the wizard asks for the account, without using it up. */
	checkToken: procedure.input(z.object({ token })).handler(async ({ context, input }) => {
		await context.services.setup.checkToken(input.token.trim());
		return { ok: true as const };
	}),

	/** Claims the Install with the setup token: creates the Superadmin and signs them in. */
	claim: procedure
		.input(z.object({ token, name: personName, email, password, adminLanguage }))
		.handler(async ({ context, input }) => {
			const { services } = context;
			const { token: setupToken, ...account } = input;
			const { personId } = await services.setup.claim(setupToken.trim(), account, context.via);
			const { setCookie } = await services.auth.signIn({ email: account.email, password: account.password }, context);
			setCookies(context, setCookie);
			return { personId };
		}),

	/** The Superadmin has been through the wizard's remaining steps: setup is finished for good. */
	finish: onInstall("install.manage").handler(async ({ context }) => {
		await context.services.setup.finish(context.person.id);
		return { stage: await context.services.setup.stage() };
	}),
};
