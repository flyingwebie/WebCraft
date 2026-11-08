import { z } from "zod";

import { onInstall, sensitive } from "../context.ts";
import { email, id, reach } from "../inputs.ts";

/** Staff: the agency's people, reaching the Workspaces they are assigned to. Only the Superadmin manages them. */
export const staff = {
	/** Staff with the Workspaces they reach, and pending Staff invites. */
	list: onInstall("staff.manage").handler(({ context }) => context.services.staff.list(context.install)),

	/**
	 * Invites a person as Staff, reaching some Workspaces or all of them: they get an email with a link
	 * that works once for 7 days. Inviting the same address again replaces the earlier invite.
	 */
	invite: onInstall("staff.manage")
		// Sensitive: it grants a role.
		.use(sensitive)
		.input(z.object({ email, workspaces: reach }))
		.handler(async ({ context, input }) => ({
			invite: await context.services.staff.invite(context.install, input),
		})),

	/** Withdraws a pending invite: its link stops working. */
	revokeInvite: onInstall("staff.manage")
		.input(z.object({ inviteId: id }))
		.handler(async ({ context, input }) => {
			await context.services.staff.revokeInvite(context.install, input.inviteId);
			return { ok: true as const };
		}),

	/** Changes which Workspaces a Staff member reaches. */
	setWorkspaces: onInstall("staff.manage")
		// Sensitive: it changes what a person can reach.
		.use(sensitive)
		.input(z.object({ personId: id, workspaces: reach }))
		.handler(async ({ context, input }) => {
			await context.services.staff.setWorkspaces(context.install, input.personId, input.workspaces);
			return { ok: true as const };
		}),
};
