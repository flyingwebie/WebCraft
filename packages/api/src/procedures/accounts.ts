import { z } from "zod";

import { onInstall, sensitive } from "../context.ts";
import { id } from "../inputs.ts";

/**
 * People's accounts, for the Superadmin: deactivating the account of someone who left, Staff or
 * Member, and reactivating it. What the person made, and their Audit log entries, stay theirs.
 */
export const accounts = {
	/**
	 * Deactivates a person's account (a Sensitive action): they can no longer sign in, their sessions,
	 * API tokens, AI clients and CLI sign-ins end and the invites they sent are withdrawn, at once.
	 * Never the last Superadmin, nor the person themselves (`ACCOUNT_DEACTIVATION_REFUSED`).
	 */
	deactivate: onInstall("account.deactivate")
		.use(sensitive("account.deactivate"))
		.input(z.object({ personId: id }))
		.handler(async ({ context, input }) => ({
			ended: await context.services.accounts.deactivate(context.install, input.personId),
		})),

	/**
	 * Reactivates an account (a Sensitive action): the person signs in again with the password, second
	 * factors and roles they had. API tokens and AI clients that ended stay ended.
	 */
	reactivate: onInstall("account.deactivate")
		.use(sensitive("account.reactivate"))
		.input(z.object({ personId: id }))
		.handler(async ({ context, input }) => {
			await context.services.accounts.reactivate(context.install, input.personId);
			return { ok: true as const };
		}),
};
