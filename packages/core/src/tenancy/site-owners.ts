import { membershipSites, memberships } from "@webcraft/db/schema";
import { and, eq, isNotNull, or } from "drizzle-orm";

import { roleDefinition } from "../permissions/roles.ts";
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
		.filter((row) => roleDefinition(row.role)?.permissions.includes("member.manage") ?? false)
		.map((row) => row.personId);
}
