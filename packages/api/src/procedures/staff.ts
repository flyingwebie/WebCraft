import { z } from "zod";

import { onInstall, sensitive } from "../context.ts";
import { email, id, reach } from "../inputs.ts";

/** Staff: the agency's people, reaching the Workspaces they are assigned to. Only the Superadmin manages them. */
export const staff = {
	/** Staff with the Workspaces they reach and their second factors, and pending Staff invites. */
	list: onInstall("staff.manage").handler(async ({ context }) => {
		const { staff, invites } = await context.services.staff.list(context.install);
		const methods = await context.services.twoFactor.methodsOf(staff.map((person) => person.id));
		return { staff: staff.map((person) => ({ ...person, twoFactor: methods.get(person.id) ?? [] })), invites };
	}),

	/**
	 * Invites a person as Staff, reaching some Workspaces or all of them: they get an email with a link
	 * that works once for 7 days. Inviting the same address again replaces the earlier invite.
	 */
	invite: onInstall("staff.manage")
		.use(sensitive("staff.invite"))
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
		.use(sensitive("staff.changeWorkspaces"))
		.input(z.object({ personId: id, workspaces: reach }))
		.handler(async ({ context, input }) => {
			await context.services.staff.setWorkspaces(context.install, input.personId, input.workspaces);
			return { ok: true as const };
		}),

	/**
	 * Resets a Staff member's two-factor authentication when they lost it: their authenticator app,
	 * passkeys and backup codes go, every session of theirs ends, and they are emailed.
	 */
	resetTwoFactor: onInstall("staff.manage")
		.use(sensitive("twoFactor.reset"))
		.input(z.object({ personId: id }))
		.handler(async ({ context, input }) => {
			await context.services.twoFactor.resetStaff(context.install, input.personId);
			return { ok: true as const };
		}),
};
