import type { Database } from "@webcraft/db";
import { installRoles, people, sites, staffWorkspaces, workspaces } from "@webcraft/db/schema";
import { asc, eq, inArray } from "drizzle-orm";

import { can, workspacesReached } from "../permissions/can.ts";
import { ASSIGNED_ROLES } from "../permissions/roles.ts";
import type { Access, InstallScope, Workspace } from "./data-layer.ts";

/** The longest Workspace name, in characters. */
export const WORKSPACE_NAME_MAX_LENGTH = 100;

/** A Workspace in a list: how many of its Sites the person reaches, and the Staff assigned to it. */
export type WorkspaceSummary = Workspace & {
	siteCount: number;
	/**
	 * Staff assigned to it, including Staff assigned to every Workspace, by name; only for those who
	 * manage its Members (`member.manage`), empty for everyone else.
	 */
	staff: { id: string; name: string }[];
};

/** Creates a Workspace (needs `workspace.create` on the Install) and records it in the Audit log. */
export function createWorkspace(scope: InstallScope, input: { name: string }): Promise<Workspace> {
	const name = input.name.trim();
	if (!name || name.length > WORKSPACE_NAME_MAX_LENGTH) {
		throw new TypeError(`A Workspace's name needs 1 to ${WORKSPACE_NAME_MAX_LENGTH} characters.`);
	}
	return scope.transaction(async (tx) => {
		const [workspace] = await tx.db
			.insert(workspaces)
			.values({ name, createdAt: tx.now() })
			.returning({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt });
		if (!workspace) throw new Error("The new Workspace was not saved.");
		await tx.audit("workspace.create", { name }, { workspaceId: workspace.id });
		return workspace;
	});
}

/**
 * The Workspaces the actor can see (`workspace.view`), by name. An Install-level list, so it reads
 * across Workspaces, but only those the actor reaches.
 */
/** The Workspaces an actor may see (`workspace.view`), by name. */
export async function visibleWorkspaces(
	db: Database["db"],
	actor: Access["actor"],
): Promise<{ id: string; name: string; createdAt: Date }[]> {
	const reached = workspacesReached(actor);
	if (reached !== "all" && reached.length === 0) return [];
	const rows = await db
		.select({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt })
		.from(workspaces)
		.where(reached === "all" ? undefined : inArray(workspaces.id, [...reached]))
		.orderBy(asc(workspaces.name), asc(workspaces.createdAt));
	return rows.filter((row) => can(actor, "workspace.view", { level: "workspace", workspaceId: row.id }));
}

export async function listWorkspaces(database: Database, access: Access): Promise<WorkspaceSummary[]> {
	const { db } = database;
	const { actor } = access;
	const visible = await visibleWorkspaces(db, actor);
	if (visible.length === 0) return [];
	const ids = visible.map((row) => row.id);

	const [siteRows, staffRows] = await Promise.all([
		db.select({ id: sites.id, workspaceId: sites.workspaceId }).from(sites).where(inArray(sites.workspaceId, ids)),
		db
			.selectDistinct({
				id: people.id,
				name: people.name,
				allWorkspaces: installRoles.allWorkspaces,
				workspaceId: staffWorkspaces.workspaceId,
			})
			.from(installRoles)
			.innerJoin(people, eq(people.id, installRoles.personId))
			.leftJoin(staffWorkspaces, eq(staffWorkspaces.personId, installRoles.personId))
			.where(inArray(installRoles.role, ASSIGNED_ROLES))
			.orderBy(asc(people.name)),
	]);

	return visible.map((workspace) => {
		const siteCount = siteRows.filter(
			(site) =>
				site.workspaceId === workspace.id &&
				can(actor, "site.view", { level: "site", workspaceId: workspace.id, siteId: site.id }),
		).length;
		// Who in the agency reaches the Workspace is for the people who manage its Members (Owners,
		// Staff), not for every Editor and Author.
		const staff = new Map<string, { id: string; name: string }>();
		if (can(actor, "member.manage", { level: "workspace", workspaceId: workspace.id })) {
			for (const row of staffRows) {
				if (row.allWorkspaces || row.workspaceId === workspace.id) staff.set(row.id, { id: row.id, name: row.name });
			}
		}
		return { ...workspace, siteCount, staff: [...staff.values()] };
	});
}
