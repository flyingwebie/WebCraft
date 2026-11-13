import { installRoles, membershipSites, memberships, staffWorkspaces } from "@webcraft/db/schema";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

import { ASSIGNED_ROLES, type Permission, roleDefinition } from "../permissions/roles.ts";
import type { Executor, Site, Workspace } from "./data-layer.ts";

/**
 * The Site's Owners: the Members of its Workspace who reach the Site and whose role manages the
 * Workspace's Members (`member.manage`, which only Owners hold in v1). Checked by Permission, never
 * by role name (ADR 0028).
 */
export async function siteOwners(scope: {
	db: Executor;
	site: Pick<Site, "id">;
	workspace: Pick<Workspace, "id">;
}): Promise<string[]> {
	return siteMembersHolding(scope, "member.manage");
}

/**
 * The Members of the Site's Workspace who reach the Site and whose role holds `permission` (those who
 * may publish its Content: `entry.publish`, Owners and Editors). Checked by Permission, never by role
 * name (ADR 0028).
 */
export async function siteMembersHolding(
	scope: { db: Executor; site: Pick<Site, "id">; workspace: Pick<Workspace, "id"> },
	permission: Permission,
): Promise<string[]> {
	const rows = await scope.db
		.selectDistinct({ personId: memberships.personId, role: memberships.role })
		.from(memberships)
		.leftJoin(
			membershipSites,
			and(eq(membershipSites.membershipId, memberships.id), eq(membershipSites.siteId, scope.site.id)),
		)
		.where(
			and(
				eq(memberships.workspaceId, scope.workspace.id),
				or(eq(memberships.allSites, true), isNotNull(membershipSites.siteId)),
			),
		);
	return rows
		.filter((row) => roleDefinition(row.role)?.permissions.includes(permission) ?? false)
		.map((row) => row.personId);
}

/**
 * The Staff who reach the Site: those assigned to its Workspace, or to every Workspace. Checked by
 * the role's reach (assigned Workspaces), never by its name.
 */
export async function siteStaff(scope: { db: Executor; workspace: Pick<Workspace, "id"> }): Promise<string[]> {
	const rows = await scope.db
		.selectDistinct({ personId: installRoles.personId })
		.from(installRoles)
		.leftJoin(
			staffWorkspaces,
			and(eq(staffWorkspaces.personId, installRoles.personId), eq(staffWorkspaces.workspaceId, scope.workspace.id)),
		)
		.where(
			and(
				inArray(installRoles.role, ASSIGNED_ROLES),
				or(eq(installRoles.allWorkspaces, true), isNotNull(staffWorkspaces.personId)),
			),
		);
	return rows.map((row) => row.personId);
}

/**
 * The Workspace's Owners: its Members whose role manages the Workspace's Members (`member.manage`,
 * which only Owners hold in v1), whichever Sites they reach.
 */
export async function workspaceOwners(scope: { db: Executor; workspace: Pick<Workspace, "id"> }): Promise<string[]> {
	const rows = await scope.db
		.select({ personId: memberships.personId, role: memberships.role })
		.from(memberships)
		.where(eq(memberships.workspaceId, scope.workspace.id));
	return rows
		.filter((row) => roleDefinition(row.role)?.permissions.includes("member.manage") ?? false)
		.map((row) => row.personId);
}
