import { assertValidEmail, EmailInUseError, normaliseEmail } from "@webcraft/auth";
import type { Database, Transaction } from "@webcraft/db";
import { installRoles, invites, inviteWorkspaces, people, staffWorkspaces, workspaces } from "@webcraft/db/schema";
import { and, asc, eq, gt, inArray } from "drizzle-orm";

import type { Email } from "../email/index.ts";
import { isUuid } from "../ids.ts";
import { personIdOf, type Reach } from "../permissions/can.ts";
import { ASSIGNED_ROLES, STAFF_ROLE } from "../permissions/roles.ts";
import { hashToken, newToken } from "../tokens.ts";
import type { InstallScope } from "./data-layer.ts";
import { WorkspaceNotFoundError } from "./errors.ts";
import { INVITE_LIFETIME_DAYS, INVITE_LIFETIME_MS, InviteInvalidError, invitePath } from "./invites.ts";

/** A Workspace as Staff lists name it. */
export type WorkspaceRef = { id: string; name: string };

/** Which Workspaces Staff reach: all of them (including later ones), or the listed ones. */
export type StaffWorkspaces = "all" | WorkspaceRef[];

export type StaffMember = {
	id: string;
	name: string;
	email: string;
	workspaces: StaffWorkspaces;
	/** When they became Staff. */
	since: Date;
};

export type StaffInvite = {
	id: string;
	email: string;
	workspaces: StaffWorkspaces;
	invitedBy: { id: string; name: string } | null;
	createdAt: Date;
	expiresAt: Date;
};

/** The person isn't Staff. */
export class StaffNotFoundError extends Error {
	override name = "StaffNotFoundError";
	constructor() {
		super("There is no such Staff member.");
	}
}

export type StaffService = {
	/** Staff and pending Staff invites; open the Install with `staff.manage` first. */
	list(scope: InstallScope): Promise<{ staff: StaffMember[]; invites: StaffInvite[] }>;
	/**
	 * Invites a person as Staff, reaching `workspaces`, and emails them a link that works once for 7
	 * days. A pending invite to the same address is replaced. Refuses an address someone already
	 * signs in with (`EmailInUseError`): Staff never also hold a Membership.
	 */
	invite(scope: InstallScope, input: { email: string; workspaces: Reach }): Promise<StaffInvite>;
	revokeInvite(scope: InstallScope, inviteId: string): Promise<void>;
	/** Changes which Workspaces a Staff member reaches; it takes effect on their next request. */
	setWorkspaces(scope: InstallScope, personId: string, workspaces: Reach): Promise<void>;
};

type StaffOptions = {
	email: Email;
};

type Executor = Database["db"] | Transaction;

export function createStaff(options: StaffOptions): StaffService {
	const { email } = options;

	/** The Workspaces each invite assigns, by invite id, sorted by name. */
	const inviteWorkspaceRefs = async (executor: Executor, inviteIds: string[]) => {
		const refs = new Map<string, WorkspaceRef[]>();
		if (inviteIds.length === 0) return refs;
		const rows = await executor
			.select({ inviteId: inviteWorkspaces.inviteId, id: workspaces.id, name: workspaces.name })
			.from(inviteWorkspaces)
			.innerJoin(workspaces, eq(workspaces.id, inviteWorkspaces.workspaceId))
			.where(inArray(inviteWorkspaces.inviteId, inviteIds))
			.orderBy(asc(workspaces.name));
		for (const row of rows) refs.set(row.inviteId, [...(refs.get(row.inviteId) ?? []), { id: row.id, name: row.name }]);
		return refs;
	};

	const pendingInvites = async (
		executor: Executor,
		now: Date,
		where?: ReturnType<typeof eq>,
	): Promise<StaffInvite[]> => {
		const rows = await executor
			.select({
				id: invites.id,
				email: invites.email,
				allWorkspaces: invites.allWorkspaces,
				createdAt: invites.createdAt,
				expiresAt: invites.expiresAt,
				inviterId: people.id,
				inviterName: people.name,
			})
			.from(invites)
			.leftJoin(people, eq(people.id, invites.invitedBy))
			.where(and(inArray(invites.role, ASSIGNED_ROLES), gt(invites.expiresAt, now), where))
			.orderBy(asc(invites.email));
		const refs = await inviteWorkspaceRefs(
			executor,
			rows.map((row) => row.id),
		);
		return rows.map((row) => ({
			id: row.id,
			email: row.email,
			workspaces: row.allWorkspaces ? "all" : (refs.get(row.id) ?? []),
			invitedBy: row.inviterId && row.inviterName ? { id: row.inviterId, name: row.inviterName } : null,
			createdAt: row.createdAt,
			expiresAt: row.expiresAt,
		}));
	};

	const assertWorkspacesExist = async (executor: Executor, reach: Reach) => {
		if (reach === "all" || reach.length === 0) return;
		const ids = [...new Set(reach)];
		if (!ids.every((id) => isUuid(id))) throw new WorkspaceNotFoundError();
		const found = await executor.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.id, ids));
		if (found.length !== ids.length) throw new WorkspaceNotFoundError();
	};

	const describeReach = (reach: Reach) => (reach === "all" ? "all" : [...new Set(reach)]);

	const staff: StaffService = {
		async list(scope) {
			const rows = await scope.db
				.select({
					id: people.id,
					name: people.name,
					email: people.email,
					allWorkspaces: installRoles.allWorkspaces,
					since: installRoles.createdAt,
				})
				.from(installRoles)
				.innerJoin(people, eq(people.id, installRoles.personId))
				.where(inArray(installRoles.role, ASSIGNED_ROLES))
				.orderBy(asc(people.name));
			const assigned = rows.length
				? await scope.db
						.select({ personId: staffWorkspaces.personId, id: workspaces.id, name: workspaces.name })
						.from(staffWorkspaces)
						.innerJoin(workspaces, eq(workspaces.id, staffWorkspaces.workspaceId))
						.where(
							inArray(
								staffWorkspaces.personId,
								rows.map((row) => row.id),
							),
						)
						.orderBy(asc(workspaces.name))
				: [];
			return {
				staff: rows.map((row) => ({
					id: row.id,
					name: row.name,
					email: row.email,
					workspaces: row.allWorkspaces
						? "all"
						: assigned.filter((ref) => ref.personId === row.id).map(({ id, name }) => ({ id, name })),
					since: row.since,
				})),
				invites: await pendingInvites(scope.db, scope.now()),
			};
		},

		async invite(scope, input) {
			assertValidEmail(input.email);
			const address = normaliseEmail(input.email);
			const token = newToken();
			const invite = await scope.transaction(async (tx) => {
				const [existing] = await tx.db.select({ id: people.id }).from(people).where(eq(people.email, address));
				if (existing) throw new EmailInUseError(`Another person already signs in with ${address}.`);
				await assertWorkspacesExist(tx.db, input.workspaces);
				// One pending Staff invite per address: a new invite replaces the earlier one and its link.
				await tx.db.delete(invites).where(and(eq(invites.email, address), inArray(invites.role, ASSIGNED_ROLES)));
				const now = tx.now();
				const [created] = await tx.db
					.insert(invites)
					.values({
						email: address,
						tokenHash: await hashToken(token),
						role: STAFF_ROLE,
						allWorkspaces: input.workspaces === "all",
						invitedBy: personIdOf(scope.access.actor),
						createdAt: now,
						expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
					})
					.returning({ id: invites.id });
				if (!created) throw new Error("The invite was not saved.");
				if (input.workspaces !== "all" && input.workspaces.length > 0) {
					await tx.db
						.insert(inviteWorkspaces)
						.values([...new Set(input.workspaces)].map((workspaceId) => ({ inviteId: created.id, workspaceId })));
				}
				await tx.audit("staff.invite", { email: address, workspaces: describeReach(input.workspaces) });
				const [invite] = await pendingInvites(tx.db, now, eq(invites.id, created.id));
				if (!invite) throw new Error("The invite was not saved.");
				return invite;
			});
			// A security email: it always goes, in the Install's default Admin language (the invitee has
			// no account yet), and links only into the admin.
			await email.send({
				type: "staff-invite",
				to: { email: address },
				data: {
					inviterName: invite.invitedBy?.name ?? "WebCraft",
					acceptPath: invitePath(token),
					expiresInDays: INVITE_LIFETIME_DAYS,
				},
				related: { kind: "invite", id: invite.id },
			});
			return invite;
		},

		async revokeInvite(scope, inviteId) {
			if (!isUuid(inviteId)) throw new InviteInvalidError();
			await scope.transaction(async (tx) => {
				const [removed] = await tx.db
					.delete(invites)
					.where(and(eq(invites.id, inviteId), inArray(invites.role, ASSIGNED_ROLES)))
					.returning({ email: invites.email });
				if (!removed) throw new InviteInvalidError();
				await tx.audit("staff.revokeInvite", { email: removed.email });
			});
		},

		async setWorkspaces(scope, personId, reach) {
			if (!isUuid(personId)) throw new StaffNotFoundError();
			await scope.transaction(async (tx) => {
				const [role] = await tx.db
					.select({ role: installRoles.role })
					.from(installRoles)
					.where(and(eq(installRoles.personId, personId), inArray(installRoles.role, ASSIGNED_ROLES)))
					.for("update");
				if (!role) throw new StaffNotFoundError();
				await assertWorkspacesExist(tx.db, reach);
				await tx.db
					.update(installRoles)
					.set({ allWorkspaces: reach === "all" })
					.where(eq(installRoles.personId, personId));
				await tx.db.delete(staffWorkspaces).where(eq(staffWorkspaces.personId, personId));
				if (reach !== "all" && reach.length > 0) {
					const now = tx.now();
					await tx.db
						.insert(staffWorkspaces)
						.values([...new Set(reach)].map((workspaceId) => ({ personId, workspaceId, createdAt: now })));
				}
				await tx.audit("staff.changeWorkspaces", { staffId: personId, workspaces: describeReach(reach) });
			});
		},
	};

	return staff;
}
