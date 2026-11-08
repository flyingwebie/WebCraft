import type { Auth } from "@webcraft/auth";
import type { Database, Transaction } from "@webcraft/db";
import {
	installRoles,
	inviteSites,
	invites,
	inviteWorkspaces,
	people,
	staffWorkspaces,
	workspaces,
} from "@webcraft/db/schema";
import { and, eq, gt } from "drizzle-orm";

import type { AdminLanguageCode } from "../admin-languages.ts";
import { type AuditVia, recordAudit } from "../audit.ts";
import type { Clock } from "../clock.ts";
import type { InstallSettings } from "../install-settings.ts";
import { ASSIGNED_ROLES, isWorkspaceRole } from "../permissions/roles.ts";
import { hashToken } from "../tokens.ts";
import type { MembershipsService } from "./memberships.ts";

/** How long an invite link works. */
export const INVITE_LIFETIME_DAYS = 7;

export const INVITE_LIFETIME_MS = INVITE_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

/** The path in the admin where an invite link opens. */
export function invitePath(token: string): string {
	return `/invite?token=${token}`;
}

/** What the person opening an invite link sees. */
export type InviteDetails = {
	email: string;
	/** The role key the invite grants: `staff`, or a Workspace role such as `editor`. */
	role: string;
	installName: string | null;
	invitedBy: string | null;
	expiresAt: Date;
	/** The Workspace a Member invite is for; null for a Staff invite. */
	workspace: { name: string } | null;
	/**
	 * Whether someone already signs in with the invite's address: they sign in and join the
	 * Workspace (`join`), rather than creating an account (`accept`).
	 */
	hasAccount: boolean;
};

/** The invite link doesn't work: it was used, revoked, replaced or has expired, or never existed. */
export class InviteInvalidError extends Error {
	override name = "InviteInvalidError";
	constructor() {
		super("This invite link doesn't work any more. Ask for a new invite.");
	}
}

/** The invite was sent to another address than the one the person signs in with. */
export class InviteForAnotherAccountError extends Error {
	override name = "InviteForAnotherAccountError";
	constructor() {
		super("This invite was sent to another email address. Sign in with that address to accept it.");
	}
}

export type InvitesService = {
	/** What an invite link offers; `InviteInvalidError` when it doesn't work. */
	get(token: string): Promise<InviteDetails>;
	/**
	 * Accepts an invite by creating the person's account with the access it grants: a Staff role, or
	 * a Membership. Refuses an address someone already signs in with (`EmailInUseError`): they join
	 * with `join` once signed in.
	 */
	accept(
		token: string,
		account: { name: string; password: string; adminLanguage: AdminLanguageCode },
		via: AuditVia,
	): Promise<{ personId: string; email: string; workspaceId: string | null }>;
	/**
	 * Accepts a Member invite with the signed-in person's existing account, adding the Membership it
	 * grants. The invite must be to the address they sign in with (`InviteForAnotherAccountError`).
	 */
	join(token: string, personId: string, via: AuditVia): Promise<{ workspaceId: string }>;
};

type InvitesOptions = {
	database: Database;
	auth: Auth;
	settings: InstallSettings;
	clock: Clock;
	memberships: MembershipsService;
};

type Executor = Database["db"] | Transaction;

type InviteRow = typeof invites.$inferSelect;

export function createInvites(options: InvitesOptions): InvitesService {
	const { database, auth, settings, clock, memberships } = options;
	const { db } = database;

	/** The invite a token opens, if it still works. */
	const findInvite = async (executor: Executor, token: string) => {
		const [row] = await executor
			.select()
			.from(invites)
			.where(and(eq(invites.tokenHash, await hashToken(token)), gt(invites.expiresAt, clock.now())));
		return row;
	};

	/**
	 * The invite a token opens, locked until the transaction ends: two people opening the same link
	 * at once, the second waits here, then finds it gone.
	 */
	const lockInvite = async (tx: Transaction, token: string) => {
		const found = await findInvite(tx, token);
		if (!found) throw new InviteInvalidError();
		const [invite] = await tx.select().from(invites).where(eq(invites.id, found.id)).for("update");
		if (!invite) throw new InviteInvalidError();
		return invite;
	};

	/** Gives a person the Membership a Member invite grants, records it, and uses the invite up. */
	const joinWorkspace = async (tx: Transaction, invite: InviteRow, personId: string, via: AuditVia) => {
		const { workspaceId } = invite;
		if (!workspaceId || !isWorkspaceRole(invite.role)) throw new InviteInvalidError();
		const sites = invite.allSites
			? "all"
			: (
					await tx
						.select({ siteId: inviteSites.siteId })
						.from(inviteSites)
						.where(and(eq(inviteSites.inviteId, invite.id), eq(inviteSites.workspaceId, workspaceId)))
				).map((row) => row.siteId);
		await memberships.add({ personId, workspaceId, role: invite.role, sites }, tx);
		await tx.delete(invites).where(eq(invites.id, invite.id));
		await recordAudit(tx, clock.now(), {
			personId,
			via,
			workspaceId,
			siteId: null,
			action: "member.join",
			details: { email: invite.email, role: invite.role, sites },
		});
		return { workspaceId };
	};

	/** Gives a new person the Staff role a Staff invite grants, records it, and uses the invite up. */
	const joinStaff = async (tx: Transaction, invite: InviteRow, personId: string, via: AuditVia) => {
		const assigned = invite.allWorkspaces
			? []
			: (
					await tx
						.select({ workspaceId: inviteWorkspaces.workspaceId })
						.from(inviteWorkspaces)
						.where(eq(inviteWorkspaces.inviteId, invite.id))
				).map((row) => row.workspaceId);
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
	};

	return {
		async get(token) {
			const invite = await findInvite(db, token);
			if (!invite) throw new InviteInvalidError();
			const [[inviter], [workspace], [account]] = await Promise.all([
				invite.invitedBy
					? db.select({ name: people.name }).from(people).where(eq(people.id, invite.invitedBy))
					: Promise.resolve([]),
				invite.workspaceId
					? db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, invite.workspaceId))
					: Promise.resolve([]),
				db.select({ id: people.id }).from(people).where(eq(people.email, invite.email)),
			]);
			return {
				email: invite.email,
				role: invite.role,
				installName: (await settings.read()).name,
				invitedBy: inviter?.name ?? null,
				expiresAt: invite.expiresAt,
				workspace: workspace ? { name: workspace.name } : null,
				hasAccount: account !== undefined,
			};
		},

		async accept(token, account, via) {
			return db.transaction(async (tx) => {
				const invite = await lockInvite(tx, token);
				const staff = ASSIGNED_ROLES.includes(invite.role);
				if (!staff && !invite.workspaceId) throw new InviteInvalidError();
				const { personId } = await auth.createPerson(tx, { ...account, email: invite.email });
				if (staff) {
					await joinStaff(tx, invite, personId, via);
					return { personId, email: invite.email, workspaceId: null };
				}
				const { workspaceId } = await joinWorkspace(tx, invite, personId, via);
				return { personId, email: invite.email, workspaceId };
			});
		},

		async join(token, personId, via) {
			return db.transaction(async (tx) => {
				const invite = await lockInvite(tx, token);
				if (!invite.workspaceId) throw new InviteInvalidError();
				const [person] = await tx.select({ email: people.email }).from(people).where(eq(people.id, personId));
				if (person?.email !== invite.email) throw new InviteForAnotherAccountError();
				return joinWorkspace(tx, invite, personId, via);
			});
		},
	};
}
