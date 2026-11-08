import { type Auth, assertValidEmail, EmailInUseError, normaliseEmail } from "@webcraft/auth";
import type { Database, Transaction } from "@webcraft/db";
import { installRoles, invites, inviteWorkspaces, people, staffWorkspaces, workspaces } from "@webcraft/db/schema";
import { and, asc, eq, gt, inArray } from "drizzle-orm";

import type { AdminLanguageCode } from "../admin-languages.ts";
import { type AuditVia, recordAudit } from "../audit.ts";
import type { Clock } from "../clock.ts";
import type { Email } from "../email/index.ts";
import type { InstallSettings } from "../install-settings.ts";
import type { Reach } from "../permissions/can.ts";
import { ROLES, STAFF_ROLE } from "../permissions/roles.ts";
import { hashToken, newToken } from "../tokens.ts";
import type { InstallScope } from "./data-layer.ts";
import { WorkspaceNotFoundError } from "./errors.ts";

/** How long an invite link works. */
export const INVITE_LIFETIME_DAYS = 7;

const INVITE_LIFETIME_MS = INVITE_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

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

/** What the person opening an invite link sees. */
export type InviteDetails = {
	email: string;
	/** The role key the invite grants, such as `staff`. */
	role: string;
	installName: string | null;
	invitedBy: string | null;
	expiresAt: Date;
};

/** The invite link doesn't work: it was used, revoked, replaced or has expired, or never existed. */
export class InviteInvalidError extends Error {
	override name = "InviteInvalidError";
	constructor() {
		super("This invite link doesn't work any more. Ask for a new invite.");
	}
}

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

export type InvitesService = {
	/** What an invite link offers; `InviteInvalidError` when it doesn't work. */
	get(token: string): Promise<InviteDetails>;
	/** Accepts an invite: creates the person's account with the role it grants. */
	accept(
		token: string,
		account: { name: string; password: string; adminLanguage: AdminLanguageCode },
		via: AuditVia,
	): Promise<{ personId: string; email: string }>;
};

type StaffOptions = {
	database: Database;
	auth: Auth;
	email: Email;
	settings: InstallSettings;
	clock: Clock;
};

/** The roles that reach Workspaces by assignment. */
const ASSIGNED_ROLES = Object.entries(ROLES)
	.filter(([, role]) => role.reach === "assigned-workspaces")
	.map(([key]) => key);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Executor = Database["db"] | Transaction;

export function createStaffServices(options: StaffOptions): { staff: StaffService; invites: InvitesService } {
	const { database, auth, email, settings, clock } = options;
	const { db } = database;

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

	const pendingInvites = async (executor: Executor, where?: ReturnType<typeof eq>): Promise<StaffInvite[]> => {
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
			.where(and(inArray(invites.role, ASSIGNED_ROLES), gt(invites.expiresAt, clock.now()), where))
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

	/** The invite a token opens, if it still works. */
	const findInvite = async (executor: Executor, token: string) => {
		const [row] = await executor
			.select()
			.from(invites)
			.where(and(eq(invites.tokenHash, await hashToken(token)), gt(invites.expiresAt, clock.now())));
		return row;
	};

	const assertWorkspacesExist = async (executor: Executor, reach: Reach) => {
		if (reach === "all" || reach.length === 0) return;
		const ids = [...new Set(reach)];
		if (!ids.every((id) => UUID.test(id))) throw new WorkspaceNotFoundError();
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
				invites: await pendingInvites(scope.db),
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
						invitedBy: personOf(scope),
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
				const [invite] = await pendingInvites(tx.db, eq(invites.id, created.id));
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
					acceptPath: `/invite?token=${token}`,
					expiresInDays: INVITE_LIFETIME_DAYS,
				},
				related: { kind: "invite", id: invite.id },
			});
			return invite;
		},

		async revokeInvite(scope, inviteId) {
			if (!UUID.test(inviteId)) throw new InviteInvalidError();
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
			if (!UUID.test(personId)) throw new StaffNotFoundError();
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

	const invitesService: InvitesService = {
		async get(token) {
			const invite = await findInvite(db, token);
			if (!invite) throw new InviteInvalidError();
			const [inviter] = invite.invitedBy
				? await db.select({ name: people.name }).from(people).where(eq(people.id, invite.invitedBy))
				: [];
			return {
				email: invite.email,
				role: invite.role,
				installName: (await settings.read()).name,
				invitedBy: inviter?.name ?? null,
				expiresAt: invite.expiresAt,
			};
		},

		async accept(token, account, via) {
			return db.transaction(async (tx) => {
				const found = await findInvite(tx, token);
				if (!found) throw new InviteInvalidError();
				// Two people opening the same link at once: the second waits here, then finds it gone.
				const [invite] = await tx.select().from(invites).where(eq(invites.id, found.id)).for("update");
				// Only Staff invites exist so far; Member invites will be accepted into a Membership instead.
				if (!invite || !ASSIGNED_ROLES.includes(invite.role)) throw new InviteInvalidError();
				const assigned = invite.allWorkspaces
					? []
					: (
							await tx
								.select({ workspaceId: inviteWorkspaces.workspaceId })
								.from(inviteWorkspaces)
								.where(eq(inviteWorkspaces.inviteId, invite.id))
						).map((row) => row.workspaceId);
				const { personId } = await auth.createPerson(tx, { ...account, email: invite.email });
				const now = clock.now();
				await tx
					.insert(installRoles)
					.values({ personId, role: invite.role, allWorkspaces: invite.allWorkspaces, createdAt: now });
				if (assigned.length > 0) {
					await tx
						.insert(staffWorkspaces)
						.values(assigned.map((workspaceId) => ({ personId, workspaceId, createdAt: now })));
				}
				await tx.delete(invites).where(eq(invites.id, invite.id));
				await recordAudit(tx, now, {
					personId,
					via,
					workspaceId: null,
					siteId: null,
					action: "staff.join",
					details: { email: invite.email, workspaces: invite.allWorkspaces ? "all" : assigned },
				});
				return { personId, email: invite.email };
			});
		},
	};

	return { staff, invites: invitesService };
}

function personOf(scope: InstallScope): string | null {
	const { actor } = scope.access;
	return actor.kind === "person" ? actor.personId : null;
}
