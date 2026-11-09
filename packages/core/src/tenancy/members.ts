import { assertValidEmail, normaliseEmail } from "@webcraft/auth";
import type { Database } from "@webcraft/db";
import {
	installRoles,
	inviteSites,
	invites,
	membershipSites,
	memberships,
	people,
	sites,
	staffWorkspaces,
} from "@webcraft/db/schema";
import { and, asc, eq, gt, inArray, isNotNull, or } from "drizzle-orm";

import type { Email } from "../email/index.ts";
import { revokeTokensOutOfReach } from "../api-tokens.ts";
import { isUuid } from "../ids.ts";
import { can, holdsAccess, type MemberAccess, personIdOf, type Reach } from "../permissions/can.ts";
import { ASSIGNED_ROLES, isWorkspaceRole, WORKSPACE_ROLES, type WorkspaceRole } from "../permissions/roles.ts";
import { hashToken, newToken } from "../tokens.ts";
import type { WorkspaceScope } from "./data-layer.ts";
import { SiteNotFoundError } from "./errors.ts";
import { INVITE_LIFETIME_DAYS, INVITE_LIFETIME_MS, InviteInvalidError, invitePath } from "./invites.ts";
import { AlreadyMemberError, StaffMembershipError } from "./memberships.ts";

/** A Site as Member lists name it. */
export type SiteRef = { id: string; name: string };

/**
 * The Sites a Membership or a Member invite reaches, as the person looking may see them: all of
 * them, or the ones they can see by name, and how many more they can't see (an Owner who reaches
 * only some Sites doesn't learn the names of the others).
 */
export type SiteAccess = { sites: "all" | SiteRef[]; otherSites: number };

export type Member = SiteAccess & {
	/** The person's id. */
	id: string;
	name: string;
	email: string;
	/** Their Workspace role key: `owner`, `editor` or `author`. */
	role: string;
	/** When they joined the Workspace. */
	since: Date;
	/** Whether the person looking may change or remove them: they hold at least the Member's access. */
	manageable: boolean;
};

export type MemberInvite = SiteAccess & {
	id: string;
	email: string;
	/** The Workspace role key the invite grants. */
	role: string;
	invitedBy: { id: string; name: string } | null;
	createdAt: Date;
	expiresAt: Date;
	/** Whether the person looking may resend or revoke it: they hold at least the access it grants. */
	manageable: boolean;
};

/**
 * What the person looking may grant, one entry per Workspace role they may give: whether they may
 * give it on every Site (including later ones), and on which Sites. Nobody grants more than they hold.
 */
export type AccessOffer = { role: WorkspaceRole; allSites: boolean; sites: string[] };

/** The Members screen: Members, pending Member invites, the Staff assigned, and what may be granted. */
export type MembersOverview = {
	members: Member[];
	invites: MemberInvite[];
	/** Staff assigned to the Workspace, including Staff assigned to every Workspace. Read-only here. */
	staff: { id: string; name: string }[];
	offer: AccessOffer[];
};

/** The person holds no Membership in this Workspace. */
export class MemberNotFoundError extends Error {
	override name = "MemberNotFoundError";
	constructor() {
		super("There is no such Member in this Workspace.");
	}
}

/**
 * Why access was refused: `grant` gives more than the person holds; `manage` touches a Member (or an
 * invite) with access the person doesn't hold.
 */
export type AccessProblem = "grant" | "manage";

/** Nobody grants more access than they hold, in role or in Sites, nor manages someone who holds more. */
export class AccessNotHeldError extends Error {
	override name = "AccessNotHeldError";
	readonly problem: AccessProblem;
	constructor(problem: AccessProblem) {
		super(
			problem === "grant"
				? "You can't give more access than you hold, in role or in Sites."
				: "This Member has access you don't hold, so you can't change or remove them.",
		);
		this.problem = problem;
	}
}

export type MembersService = {
	/** The Members screen; open the Workspace with `member.manage` first. */
	list(scope: WorkspaceScope): Promise<MembersOverview>;
	/**
	 * Invites a person into the scope's Workspace (open it with `member.invite`) with a Workspace role,
	 * reaching all its Sites or the listed ones, and emails them a link that works once for 7 days, in
	 * their Admin language when they have an account. A pending invite to the same address is
	 * replaced. Refuses more access than the inviter holds (`AccessNotHeldError`), Staff and the
	 * Superadmin (`StaffMembershipError`), and people who are already Members (`AlreadyMemberError`).
	 */
	invite(scope: WorkspaceScope, input: { email: string; role: string; sites: Reach }): Promise<MemberInvite>;
	/** Sends a pending invite again with a new link, valid for 7 more days; the earlier link stops working. */
	resendInvite(scope: WorkspaceScope, inviteId: string): Promise<MemberInvite>;
	/** Withdraws a pending invite: its link stops working. */
	revokeInvite(scope: WorkspaceScope, inviteId: string): Promise<void>;
	/**
	 * Changes a Member's role and Sites (open the Workspace with `member.manage`); it takes effect on
	 * their next request. The person changing it must hold both the Member's access and the new one.
	 */
	changeAccess(scope: WorkspaceScope, personId: string, access: MemberAccess): Promise<Member>;
	/**
	 * Removes a Member from the Workspace (open it with `member.manage`); they lose it on their next
	 * request. Their account stays, with any Memberships in other Workspaces.
	 */
	remove(scope: WorkspaceScope, personId: string): Promise<void>;
};

/** A Site of the Workspace, and whether the person looking can see it. */
type KnownSite = SiteRef & { visible: boolean };

type InviteRow = typeof invites.$inferSelect;

export function createMembers({ database, email }: { database: Database; email: Email }): MembersService {
	const { db } = database;

	/** The Workspace's Sites by name, each with whether the scope's actor can see it. */
	const workspaceSites = async (scope: WorkspaceScope): Promise<KnownSite[]> => {
		const rows = await scope.select(sites, undefined, { orderBy: [asc(sites.name), asc(sites.slug)] });
		return rows.map((row) => ({ id: row.id, name: row.name, visible: canSee(scope, row.id) }));
	};

	/** The Sites a grant names, refused as not found unless each is a Site of the Workspace the actor sees. */
	const checkSites = async (scope: WorkspaceScope, reach: Reach): Promise<Reach> => {
		if (reach === "all") return "all";
		const ids = [...new Set(reach)];
		if (ids.length === 0) return [];
		if (!ids.every((id) => isUuid(id))) throw new SiteNotFoundError();
		const found = await scope.select(sites, inArray(sites.id, ids));
		if (found.length !== ids.length || !ids.every((id) => canSee(scope, id))) throw new SiteNotFoundError();
		return ids;
	};

	const membershipAccess = async (
		scope: WorkspaceScope,
		membership: { id: string; role: string; allSites: boolean },
	): Promise<MemberAccess> => ({
		role: membership.role,
		sites: membership.allSites
			? "all"
			: (await scope.select(membershipSites, eq(membershipSites.membershipId, membership.id))).map((row) => row.siteId),
	});

	const inviteAccess = async (scope: WorkspaceScope, invite: InviteRow): Promise<MemberAccess> => ({
		role: invite.role,
		sites: invite.allSites
			? "all"
			: (await scope.select(inviteSites, eq(inviteSites.inviteId, invite.id))).map((row) => row.siteId),
	});

	/** A pending invite of the scope's Workspace that still works. */
	const pendingInvite = async (scope: WorkspaceScope, inviteId: string) => {
		if (!isUuid(inviteId)) throw new InviteInvalidError();
		const invite = await scope.first(invites, and(eq(invites.id, inviteId), gt(invites.expiresAt, scope.now())));
		if (!invite) throw new InviteInvalidError();
		return invite;
	};

	/** Who signs in with an address, and their Install-level role, if anyone does. */
	const accountFor = async (address: string) => {
		const [account] = await db
			.select({ id: people.id, installRole: installRoles.role })
			.from(people)
			.leftJoin(installRoles, eq(installRoles.personId, people.id))
			.where(eq(people.email, address));
		return account;
	};

	const personName = async (personId: string | null) => {
		if (!personId) return null;
		const [person] = await db.select({ name: people.name }).from(people).where(eq(people.id, personId));
		return person?.name ?? null;
	};

	/** Emails an invite's link: in the person's Admin language when they have an account. */
	const sendInvite = async (
		scope: WorkspaceScope,
		invite: { id: string; email: string; role: WorkspaceRole },
		inviterName: string,
		token: string,
	) => {
		const account = await accountFor(invite.email);
		await email.send({
			type: "member-invite",
			to: account ? { personId: account.id } : { email: invite.email },
			data: {
				inviterName,
				workspaceName: scope.workspace.name,
				role: invite.role,
				acceptPath: invitePath(token),
				expiresInDays: INVITE_LIFETIME_DAYS,
			},
			related: { kind: "invite", id: invite.id },
		});
	};

	/** An invite as the scope's actor sees it. */
	const inviteView = async (scope: WorkspaceScope, invite: InviteRow): Promise<MemberInvite> => {
		const access = await inviteAccess(scope, invite);
		const inviterName = await personName(invite.invitedBy);
		return {
			id: invite.id,
			email: invite.email,
			role: invite.role,
			...siteAccess(access.sites, await workspaceSites(scope)),
			invitedBy: invite.invitedBy && inviterName ? { id: invite.invitedBy, name: inviterName } : null,
			createdAt: invite.createdAt,
			expiresAt: invite.expiresAt,
			manageable: holdsAccess(scope.access.actor, scope.workspace.id, access),
		};
	};

	/** The scope's Membership of a person, or `MemberNotFoundError`. */
	const membershipOf = async (scope: WorkspaceScope, personId: string) => {
		if (!isUuid(personId)) throw new MemberNotFoundError();
		const membership = await scope.first(memberships, eq(memberships.personId, personId));
		if (!membership) throw new MemberNotFoundError();
		return membership;
	};

	/** Refuses unless the scope's actor holds at least `access` (`AccessNotHeldError`). */
	const assertHolds = (scope: WorkspaceScope, access: MemberAccess, problem: AccessProblem) => {
		if (!holdsAccess(scope.access.actor, scope.workspace.id, access)) throw new AccessNotHeldError(problem);
	};

	return {
		async list(scope) {
			const { actor } = scope.access;
			const workspaceId = scope.workspace.id;
			const [known, memberRows, memberSites, inviteRows, pendingSites, staff] = await Promise.all([
				workspaceSites(scope),
				db
					.select({
						membershipId: memberships.id,
						id: people.id,
						name: people.name,
						email: people.email,
						role: memberships.role,
						allSites: memberships.allSites,
						since: memberships.createdAt,
					})
					.from(memberships)
					.innerJoin(people, eq(people.id, memberships.personId))
					.where(scope.where(memberships))
					.orderBy(asc(people.name), asc(people.email)),
				scope.select(membershipSites),
				db
					.select({
						invite: invites,
						inviterId: people.id,
						inviterName: people.name,
					})
					.from(invites)
					.leftJoin(people, eq(people.id, invites.invitedBy))
					.where(scope.where(invites, gt(invites.expiresAt, scope.now())))
					.orderBy(asc(invites.email)),
				scope.select(inviteSites),
				db
					.selectDistinct({ id: people.id, name: people.name })
					.from(installRoles)
					.innerJoin(people, eq(people.id, installRoles.personId))
					.leftJoin(
						staffWorkspaces,
						and(eq(staffWorkspaces.personId, installRoles.personId), scope.where(staffWorkspaces)),
					)
					.where(
						and(
							inArray(installRoles.role, ASSIGNED_ROLES),
							or(eq(installRoles.allWorkspaces, true), isNotNull(staffWorkspaces.personId)),
						),
					)
					.orderBy(asc(people.name), asc(people.id)),
			]);

			const members = memberRows.map((row): Member => {
				const access: MemberAccess = {
					role: row.role,
					sites: row.allSites
						? "all"
						: memberSites.filter((site) => site.membershipId === row.membershipId).map((site) => site.siteId),
				};
				return {
					id: row.id,
					name: row.name,
					email: row.email,
					role: row.role,
					...siteAccess(access.sites, known),
					since: row.since,
					manageable: holdsAccess(actor, workspaceId, access),
				};
			});

			const pending = inviteRows.map(({ invite, inviterId, inviterName }): MemberInvite => {
				const access: MemberAccess = {
					role: invite.role,
					sites: invite.allSites
						? "all"
						: pendingSites.filter((site) => site.inviteId === invite.id).map((site) => site.siteId),
				};
				return {
					id: invite.id,
					email: invite.email,
					role: invite.role,
					...siteAccess(access.sites, known),
					invitedBy: inviterId && inviterName ? { id: inviterId, name: inviterName } : null,
					createdAt: invite.createdAt,
					expiresAt: invite.expiresAt,
					manageable: holdsAccess(actor, workspaceId, access),
				};
			});

			const offer = WORKSPACE_ROLES.filter((role) => holdsAccess(actor, workspaceId, { role, sites: [] }))
				.map((role) => ({
					role,
					allSites: holdsAccess(actor, workspaceId, { role, sites: "all" }),
					sites: known
						.filter((site) => site.visible && holdsAccess(actor, workspaceId, { role, sites: [site.id] }))
						.map((site) => site.id),
				}))
				.filter((choice) => choice.allSites || choice.sites.length > 0);

			return { members, invites: pending, staff, offer };
		},

		async invite(scope, input) {
			assertValidEmail(input.email);
			const address = normaliseEmail(input.email);
			const { role } = input;
			if (!isWorkspaceRole(role)) throw new TypeError(`${role} is not a Workspace role.`);
			const reach = await checkSites(scope, input.sites);
			assertHolds(scope, { role, sites: reach }, "grant");
			const account = await accountFor(address);
			if (account?.installRole) throw new StaffMembershipError();
			if (account && (await scope.first(memberships, eq(memberships.personId, account.id)))) {
				throw new AlreadyMemberError();
			}

			const inviter = personIdOf(scope.access.actor);
			const token = newToken();
			const invite = await scope.transaction(async (tx) => {
				// One pending invite per address and Workspace: a new one replaces the earlier one and its link.
				await tx.delete(invites, eq(invites.email, address));
				const now = tx.now();
				const created = await tx.insert(invites, {
					email: address,
					tokenHash: await hashToken(token),
					role,
					allSites: reach === "all",
					invitedBy: inviter,
					createdAt: now,
					expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
				});
				for (const siteId of reach === "all" ? [] : reach)
					await tx.insert(inviteSites, { inviteId: created.id, siteId });
				await tx.audit("member.invite", { email: address, role, sites: reach });
				return created;
			});
			// A security email: it always goes, and links only into the admin.
			await sendInvite(
				scope,
				{ id: invite.id, email: address, role },
				(await personName(inviter)) ?? "WebCraft",
				token,
			);
			return inviteView(scope, invite);
		},

		async resendInvite(scope, inviteId) {
			const invite = await pendingInvite(scope, inviteId);
			assertHolds(scope, await inviteAccess(scope, invite), "manage");
			const role = invite.role;
			if (!isWorkspaceRole(role)) throw new InviteInvalidError();
			const token = newToken();
			const resent = await scope.transaction(async (tx) => {
				const [updated] = await tx.update(
					invites,
					{
						tokenHash: await hashToken(token),
						expiresAt: new Date(tx.now().getTime() + INVITE_LIFETIME_MS),
					},
					eq(invites.id, invite.id),
				);
				if (!updated) throw new InviteInvalidError();
				await tx.audit("member.resendInvite", { email: invite.email });
				return updated;
			});
			const inviterName =
				(await personName(invite.invitedBy)) ?? (await personName(personIdOf(scope.access.actor))) ?? "WebCraft";
			await sendInvite(scope, { id: invite.id, email: invite.email, role }, inviterName, token);
			return inviteView(scope, resent);
		},

		async revokeInvite(scope, inviteId) {
			const invite = await pendingInvite(scope, inviteId);
			assertHolds(scope, await inviteAccess(scope, invite), "manage");
			await scope.transaction(async (tx) => {
				if ((await tx.delete(invites, eq(invites.id, invite.id))) === 0) throw new InviteInvalidError();
				await tx.audit("member.revokeInvite", { email: invite.email });
			});
		},

		async changeAccess(scope, personId, access) {
			if (!isWorkspaceRole(access.role)) throw new TypeError(`${access.role} is not a Workspace role.`);
			const role = access.role;
			const { membership, to } = await scope.transaction(async (tx) => {
				const membership = await membershipOf(tx, personId);
				const from = await membershipAccess(tx, membership);
				assertHolds(tx, from, "manage");
				const to: MemberAccess = { role, sites: await checkSites(tx, access.sites) };
				assertHolds(tx, to, "grant");
				await tx.update(memberships, { role, allSites: to.sites === "all" }, eq(memberships.id, membership.id));
				await tx.delete(membershipSites, eq(membershipSites.membershipId, membership.id));
				for (const siteId of to.sites === "all" ? [] : to.sites) {
					await tx.insert(membershipSites, { membershipId: membership.id, siteId });
				}
				const [person] = await tx.db.select({ email: people.email }).from(people).where(eq(people.id, personId));
				const about = { memberId: personId, email: person?.email ?? null };
				if (from.role !== to.role) await tx.audit("member.changeRole", { ...about, from: from.role, to: to.role });
				if (!sameReach(from.sites, to.sites)) {
					await tx.audit("member.changeSites", { ...about, from: from.sites, to: to.sites });
				}
				// Their API tokens for Sites they no longer reach end with the change.
				await revokeTokensOutOfReach(tx.db, personId, tx.now(), byScope(tx));
				return { membership, to };
			});
			const [person] = await db
				.select({ name: people.name, email: people.email })
				.from(people)
				.where(eq(people.id, personId));
			return {
				id: personId,
				name: person?.name ?? "",
				email: person?.email ?? "",
				role: to.role,
				...siteAccess(to.sites, await workspaceSites(scope)),
				since: membership.createdAt,
				manageable: true,
			};
		},

		async remove(scope, personId) {
			await scope.transaction(async (tx) => {
				const membership = await membershipOf(tx, personId);
				const access = await membershipAccess(tx, membership);
				assertHolds(tx, access, "manage");
				await tx.delete(memberships, eq(memberships.id, membership.id));
				const [person] = await tx.db.select({ email: people.email }).from(people).where(eq(people.id, personId));
				await tx.audit("member.remove", {
					memberId: personId,
					email: person?.email ?? null,
					role: access.role,
					sites: access.sites,
				});
				// Their API tokens for this Workspace end with the Membership.
				await revokeTokensOutOfReach(tx.db, personId, tx.now(), byScope(tx));
			});
		},
	};
}

/** Who acts in a scope, as revoking someone's API tokens records it. */
function byScope(scope: WorkspaceScope) {
	return { personId: personIdOf(scope.access.actor), via: scope.access.via };
}

function canSee(scope: WorkspaceScope, siteId: string): boolean {
	return can(scope.access.actor, "site.view", { level: "site", workspaceId: scope.workspace.id, siteId });
}

/** How a reach looks to someone who knows `known`: Sites they can't see are only counted. */
function siteAccess(reach: Reach, known: readonly KnownSite[]): SiteAccess {
	if (reach === "all") return { sites: "all", otherSites: 0 };
	const reached = known.filter((site) => reach.includes(site.id));
	return {
		sites: reached.filter((site) => site.visible).map(({ id, name }) => ({ id, name })),
		otherSites: reached.filter((site) => !site.visible).length,
	};
}

function sameReach(a: Reach, b: Reach): boolean {
	if (a === "all" || b === "all") return a === b;
	return a.length === b.length && a.every((id) => b.includes(id));
}
