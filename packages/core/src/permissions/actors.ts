import type { Database, Transaction } from "@webcraft/db";
import { installRoles, membershipSites, memberships, people, staffWorkspaces } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import type { ActorMembership, PersonActor } from "./can.ts";

type Executor = Database["db"] | Transaction;

/**
 * A person's access as `can()` needs it: their Install-level role with the Workspaces it reaches,
 * and their Memberships with the Sites each reaches. Read fresh for every request, so a change to
 * someone's access takes effect on their next request. This reads one person's own access across
 * Workspaces, which is why it doesn't go through the Workspace data layer.
 *
 * A person whose account is deactivated holds no role anywhere, whatever their rows say: nothing
 * acts as them (a session, an API token, an AI client, an impersonation) until they are reactivated.
 */
export async function loadPersonActor(executor: Executor, personId: string): Promise<PersonActor> {
	const deactivation = () =>
		executor.select({ deactivatedAt: people.deactivatedAt }).from(people).where(eq(people.id, personId));
	const roles = () =>
		executor
			.select({ role: installRoles.role, allWorkspaces: installRoles.allWorkspaces })
			.from(installRoles)
			.where(eq(installRoles.personId, personId));
	const memberRows = () =>
		executor
			.select({
				id: memberships.id,
				workspaceId: memberships.workspaceId,
				role: memberships.role,
				allSites: memberships.allSites,
			})
			.from(memberships)
			.where(eq(memberships.personId, personId));
	const siteRowsOf = () =>
		executor
			.select({ membershipId: membershipSites.membershipId, siteId: membershipSites.siteId })
			.from(membershipSites)
			.innerJoin(memberships, eq(memberships.id, membershipSites.membershipId))
			.where(eq(memberships.personId, personId));
	// On the pool the three run side by side; a transaction has one connection, which takes one at a time.
	const [personRows, roleRows, membershipRows, siteRows] = isTransaction(executor)
		? [await deactivation(), await roles(), await memberRows(), await siteRowsOf()]
		: await Promise.all([deactivation(), roles(), memberRows(), siteRowsOf()]);
	if (personRows[0]?.deactivatedAt) return { kind: "person", personId, installRole: null, memberships: [] };

	let installRole: PersonActor["installRole"] = null;
	const [role] = roleRows;
	if (role) {
		const assigned = role.allWorkspaces
			? "all"
			: (
					await executor
						.select({ workspaceId: staffWorkspaces.workspaceId })
						.from(staffWorkspaces)
						.where(eq(staffWorkspaces.personId, personId))
				).map((row) => row.workspaceId);
		installRole = { role: role.role, workspaces: assigned };
	}

	const membershipList: ActorMembership[] = membershipRows.map((membership) => ({
		workspaceId: membership.workspaceId,
		role: membership.role,
		sites: membership.allSites
			? "all"
			: siteRows.filter((row) => row.membershipId === membership.id).map((row) => row.siteId),
	}));

	return { kind: "person", personId, installRole, memberships: membershipList };
}

/** Whether an executor is a transaction (one connection) rather than the pool. */
function isTransaction(executor: Executor): boolean {
	return "rollback" in executor;
}
