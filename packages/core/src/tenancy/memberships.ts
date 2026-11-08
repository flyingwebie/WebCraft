import type { Database, Transaction } from "@webcraft/db";
import { installRoles, membershipSites, memberships } from "@webcraft/db/schema";
import { and, eq } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import type { Reach } from "../permissions/can.ts";
import { isWorkspaceRole } from "../permissions/roles.ts";

/** Staff (and the Superadmin) reach Workspaces through their Install-level role, never a Membership. */
export class StaffMembershipError extends Error {
	override name = "StaffMembershipError";
	constructor() {
		super("Staff never hold a Membership: they reach Workspaces by assignment. Invite someone else as a Member.");
	}
}

/** One person holds at most one Membership per Workspace. */
export class AlreadyMemberError extends Error {
	override name = "AlreadyMemberError";
	constructor() {
		super("This person is already a Member of the Workspace. Change their role or Sites instead.");
	}
}

export type NewMembership = {
	personId: string;
	workspaceId: string;
	/** A Workspace role key: `owner`, `editor` or `author`. */
	role: string;
	/** The Sites of the Workspace it reaches: all of them (including later ones), or the listed ones. */
	sites?: Reach;
};

export type MembershipsService = {
	/**
	 * Gives a person a Membership in a Workspace, inside the caller's transaction when given one.
	 * Refuses Staff and the Superadmin (`StaffMembershipError`), a person who already holds a
	 * Membership in the Workspace (`AlreadyMemberError`), and roles that aren't Workspace roles.
	 * Accepting a Member invite calls this.
	 */
	add(membership: NewMembership, tx?: Transaction): Promise<void>;
};

export function createMemberships({ database, clock }: { database: Database; clock: Clock }): MembershipsService {
	return {
		async add({ personId, workspaceId, role, sites = "all" }, outer) {
			if (!isWorkspaceRole(role)) throw new TypeError(`${role} is not a Workspace role.`);
			const work = async (tx: Transaction) => {
				const [installRole] = await tx
					.select({ role: installRoles.role })
					.from(installRoles)
					.where(eq(installRoles.personId, personId));
				if (installRole) throw new StaffMembershipError();
				const [existing] = await tx
					.select({ id: memberships.id })
					.from(memberships)
					.where(and(eq(memberships.personId, personId), eq(memberships.workspaceId, workspaceId)));
				if (existing) throw new AlreadyMemberError();
				const [created] = await tx
					.insert(memberships)
					.values({ personId, workspaceId, role, allSites: sites === "all", createdAt: clock.now() })
					.returning({ id: memberships.id });
				if (!created) throw new Error("The Membership was not saved.");
				if (sites !== "all" && sites.length > 0) {
					await tx
						.insert(membershipSites)
						.values([...new Set(sites)].map((siteId) => ({ membershipId: created.id, workspaceId, siteId })));
				}
			};
			if (outer) await work(outer);
			else await database.db.transaction(work);
		},
	};
}
