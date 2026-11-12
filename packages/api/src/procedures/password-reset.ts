import { z } from "zod";

import { authEndpoint } from "../context.ts";
import { email, password } from "../inputs.ts";

const token = z.string().max(512);

/**
 * Password recovery, for a person who isn't signed in: asking for a reset link by email, and
 * choosing a new password with it. Rate-limited per client address, like every endpoint a
 * signed-out person can call.
 */
export const passwordReset = {
	/**
	 * Asks for a reset link for whoever signs in with the address. The answer is the same whether
	 * the address has an account or not; one client address may ask 5 times in 15 minutes.
	 */
	request: authEndpoint.input(z.object({ email })).handler(async ({ context, input }) => {
		await context.services.passwordResets.request(input.email, context.clientAddress);
		return { ok: true as const };
	}),

	/** Until when a reset link works (`PASSWORD_RESET_INVALID` when it doesn't), for the page that opens it. */
	check: authEndpoint
		.input(z.object({ token }))
		.handler(({ context, input }) => context.services.passwordResets.check(input.token)),

	/**
	 * Gives the link's person the new password and ends every session of theirs. Nobody is signed
	 * in by it: the person signs in next, with their second factor when they have one.
	 */
	complete: authEndpoint.input(z.object({ token, newPassword: password })).handler(async ({ context, input }) => {
		await context.services.passwordResets.complete(input.token, input.newPassword, context.via);
		return { ok: true as const };
	}),
};
