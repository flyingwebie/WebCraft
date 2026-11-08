import { z } from "zod";

import { procedure, setCookies, signedIn } from "../context.ts";
import { adminLanguage, password, personName } from "../inputs.ts";

const token = z.string().max(512);

/** Invite links, for the person who got one: they aren't signed in yet. */
export const invites = {
	/**
	 * What the invite offers: the address, the role, who sent it, the Workspace (for a Member invite),
	 * until when it works, and whether the address already has an account.
	 */
	get: procedure.input(z.object({ token })).handler(({ context, input }) => context.services.invites.get(input.token)),

	/**
	 * Accepts the invite by creating the account with the access it grants (a Staff role or a
	 * Membership), and signs the person in. An address that already has an account joins with `join`.
	 */
	accept: procedure
		.input(z.object({ token, name: personName, password, adminLanguage }))
		.handler(async ({ context, input }) => {
			const { services } = context;
			const { token: inviteToken, ...account } = input;
			const { personId, email, workspaceId } = await services.invites.accept(inviteToken, account, context.via);
			const { setCookie } = await services.auth.signIn({ email, password: account.password }, context.headers);
			setCookies(context, setCookie);
			// The Workspace a Member invite let them into, for the admin to open; null for Staff.
			return { personId, workspaceId };
		}),

	/**
	 * Accepts a Member invite with the signed-in person's own account: adds the Membership it grants.
	 * The invite must be to the address they sign in with.
	 */
	join: signedIn
		.input(z.object({ token }))
		.handler(({ context, input }) => context.services.invites.join(input.token, context.person.id, context.via)),
};
