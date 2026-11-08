import { z } from "zod";

import { procedure, setCookies } from "../context.ts";
import { adminLanguage, password, personName } from "../inputs.ts";

const token = z.string().max(512);

/** Invite links, for the person who got one: they aren't signed in yet. */
export const invites = {
	/** What the invite offers: the address, the role, who sent it and until when it works. */
	get: procedure.input(z.object({ token })).handler(({ context, input }) => context.services.invites.get(input.token)),

	/** Accepts the invite: creates the account with the role it grants, and signs the person in. */
	accept: procedure
		.input(z.object({ token, name: personName, password, adminLanguage }))
		.handler(async ({ context, input }) => {
			const { services } = context;
			const { token: inviteToken, ...account } = input;
			const { personId, email } = await services.invites.accept(inviteToken, account, context.via);
			const { setCookie } = await services.auth.signIn({ email, password: account.password }, context.headers);
			setCookies(context, setCookie);
			return { personId };
		}),
};
