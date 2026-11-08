import { z } from "zod";

import { sensitive, signedIn } from "../context.ts";
import { email, id, memberSites, workspaceRole } from "../inputs.ts";

/**
 * Members: client people in a Workspace, each holding one Membership (a Workspace role and the Sites
 * it reaches). Staff and Owners manage them; nobody grants more access than they hold.
 */
export const members = {
	/**
	 * The Workspace's Members, pending Member invites, the Staff assigned to it (read-only), and which
	 * roles and Sites the person may grant.
	 */
	list: signedIn.input(z.object({ workspaceId: id })).handler(async ({ context, input }) => {
		const workspace = await context.services.data.workspace(context.access, input.workspaceId, "member.manage");
		return context.services.members.list(workspace);
	}),

	/**
	 * Invites a person as Owner, Editor or Author, reaching all Sites (including later ones) or chosen
	 * ones: they get an email with a link that works once for 7 days. Inviting the same address into
	 * the same Workspace again replaces the earlier invite.
	 */
	invite: signedIn
		.use(sensitive("member.invite"))
		.input(z.object({ workspaceId: id, email, role: workspaceRole, sites: memberSites }))
		.handler(async ({ context, input }) => {
			const { workspaceId, ...invite } = input;
			const workspace = await context.services.data.workspace(context.access, workspaceId, "member.invite");
			return { invite: await context.services.members.invite(workspace, invite) };
		}),

	/** Sends a pending invite again with a new link, valid for 7 more days; the earlier link stops working. */
	resendInvite: signedIn.input(z.object({ workspaceId: id, inviteId: id })).handler(async ({ context, input }) => {
		const workspace = await context.services.data.workspace(context.access, input.workspaceId, "member.invite");
		return { invite: await context.services.members.resendInvite(workspace, input.inviteId) };
	}),

	/** Withdraws a pending invite: its link stops working. */
	revokeInvite: signedIn.input(z.object({ workspaceId: id, inviteId: id })).handler(async ({ context, input }) => {
		const workspace = await context.services.data.workspace(context.access, input.workspaceId, "member.invite");
		await context.services.members.revokeInvite(workspace, input.inviteId);
		return { ok: true as const };
	}),

	/** Changes a Member's role and Sites; it takes effect on their next request. */
	changeAccess: signedIn
		.use(sensitive("member.changeAccess"))
		.input(z.object({ workspaceId: id, personId: id, role: workspaceRole, sites: memberSites }))
		.handler(async ({ context, input }) => {
			const workspace = await context.services.data.workspace(context.access, input.workspaceId, "member.manage");
			return {
				member: await context.services.members.changeAccess(workspace, input.personId, {
					role: input.role,
					sites: input.sites,
				}),
			};
		}),

	/** Removes a Member from the Workspace; it takes effect on their next request. Their account stays. */
	remove: signedIn
		.use(sensitive("member.remove"))
		.input(z.object({ workspaceId: id, personId: id }))
		.handler(async ({ context, input }) => {
			const workspace = await context.services.data.workspace(context.access, input.workspaceId, "member.manage");
			await context.services.members.remove(workspace, input.personId);
			return { ok: true as const };
		}),
};
