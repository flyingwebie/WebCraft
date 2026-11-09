import { z } from "zod";

import { onWorkspace, sensitive, signedIn } from "../context.ts";
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
		.input(z.object({ workspaceId: id, email, role: workspaceRole, sites: memberSites }))
		.use(onWorkspace("member.invite"))
		.use(sensitive("member.invite"))
		.handler(async ({ context, input }) => {
			const { workspaceId: _, ...invite } = input;
			return { invite: await context.services.members.invite(context.workspace, invite) };
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

	/**
	 * Two-factor authentication in the Workspace: whether its Members must use it, and which second
	 * factors each Member has (for the Members screen).
	 */
	twoFactor: signedIn.input(z.object({ workspaceId: id })).handler(async ({ context, input }) => {
		const workspace = await context.services.data.workspace(context.access, input.workspaceId, "member.manage");
		return context.services.twoFactor.workspaceStatus(workspace);
	}),

	/**
	 * Requires two-factor authentication of the Workspace's Members, or stops requiring it (Owners and
	 * Staff). Members without it are sent to add it right after signing in; Staff follow the Install's
	 * own switch. Switching it on needs your own first.
	 */
	requireTwoFactor: signedIn
		.input(z.object({ workspaceId: id, required: z.boolean() }))
		.use(onWorkspace("twoFactor.require"))
		.use(sensitive("twoFactorRequirement.change"))
		.handler(({ context, input }) =>
			context.services.twoFactor.setWorkspaceRequirement(context.workspace, input.required),
		),

	/**
	 * Resets a Member's two-factor authentication when they lost it (Staff and the Superadmin): their
	 * authenticator app, passkeys and backup codes go, every session of theirs ends, and they are
	 * emailed. They sign in with their password and set it up again.
	 */
	resetTwoFactor: signedIn
		.input(z.object({ workspaceId: id, personId: id }))
		.use(onWorkspace("twoFactor.reset"))
		.use(sensitive("twoFactor.reset"))
		.handler(async ({ context, input }) => {
			await context.services.twoFactor.resetMember(context.workspace, input.personId);
			return { ok: true as const };
		}),

	/** Changes a Member's role and Sites; it takes effect on their next request. */
	changeAccess: signedIn
		.input(z.object({ workspaceId: id, personId: id, role: workspaceRole, sites: memberSites }))
		.use(onWorkspace("member.manage"))
		.use(sensitive("member.changeAccess"))
		.handler(async ({ context, input }) => {
			return {
				member: await context.services.members.changeAccess(context.workspace, input.personId, {
					role: input.role,
					sites: input.sites,
				}),
			};
		}),

	/** Removes a Member from the Workspace; it takes effect on their next request. Their account stays. */
	remove: signedIn
		.input(z.object({ workspaceId: id, personId: id }))
		.use(onWorkspace("member.manage"))
		.use(sensitive("member.remove"))
		.handler(async ({ context, input }) => {
			await context.services.members.remove(context.workspace, input.personId);
			return { ok: true as const };
		}),
};
