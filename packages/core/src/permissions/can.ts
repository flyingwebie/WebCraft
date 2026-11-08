import { ALL_PERMISSIONS, type Level, PERMISSIONS, type Permission, roleDefinition } from "./roles.ts";

/** What a Permission is checked on: the Install, one Workspace, or one Site of a Workspace. */
export type Resource =
	| { level: "install" }
	| { level: "workspace"; workspaceId: string }
	| { level: "site"; workspaceId: string; siteId: string };

/** The Install itself, as a resource. */
export const INSTALL: Resource = { level: "install" };

/** Which Workspaces or Sites something reaches: all of them, or the listed ids. */
export type Reach = "all" | readonly string[];

/** A Membership as `can()` sees it: a role key in one Workspace, and the Sites it reaches. */
export type ActorMembership = { workspaceId: string; role: string; sites: Reach };

/**
 * A person acting with their own access: their Install-level role (Superadmin or Staff, with the
 * Workspaces Staff are assigned to) and their Memberships. Staff never hold a Membership.
 */
export type PersonActor = {
	kind: "person";
	personId: string;
	/** Their Install-level role key and the Workspaces it is assigned to, or null for people with none. */
	installRole: { role: string; workspaces: Reach } | null;
	memberships: readonly ActorMembership[];
};

/**
 * Who `can()` is asked about. Only people exist so far. Later kinds slot in here, each limited by
 * what stands behind it: an API token acts as its person within one Workspace and its Toolsets; an
 * OAuth grant is a person plus scope, Toolsets and "may publish"; a Module holds the Permissions its
 * manifest declares and the Superadmin approved.
 */
export type Actor = PersonActor;

/**
 * Whether `actor` may do `permission` on `resource`. The one permission check: every procedure goes
 * through it (most of them through the data layer). Throws a TypeError when the Permission isn't
 * checked at the resource's level, such as `entry.publish` on a whole Workspace.
 */
export function can(actor: Actor, permission: Permission, resource: Resource): boolean {
	const levels: readonly Level[] = PERMISSIONS[permission];
	if (!levels.includes(resource.level)) {
		throw new TypeError(
			`The Permission ${permission} is checked on ${levels.join(" or ")}, not on ${describeLevel(resource.level)}.`,
		);
	}
	switch (actor.kind) {
		case "person":
			return rolesReaching(actor, resource).some((role) => roleDefinition(role)?.permissions.includes(permission));
	}
}

/** Every Permission `actor` holds on `resource`, in the order of `PERMISSIONS`. */
export function permissionsOn(actor: Actor, resource: Resource): Permission[] {
	return ALL_PERMISSIONS.filter(
		(permission) =>
			(PERMISSIONS[permission] as readonly Level[]).includes(resource.level) && can(actor, permission, resource),
	);
}

/**
 * The Workspaces `actor` holds any role in: "all" for the Superadmin and Staff assigned to every
 * Workspace. Listing Workspaces starts here, then keeps those `can(actor, "workspace.view", …)` allows.
 */
export function workspacesReached(actor: Actor): Reach {
	const { installRole, memberships } = actor;
	const reach = installRole ? roleDefinition(installRole.role)?.reach : undefined;
	if (reach === "install") return "all";
	const staffWorkspaces = reach === "assigned-workspaces" ? installRole?.workspaces : [];
	if (staffWorkspaces === "all") return "all";
	return [...new Set([...(staffWorkspaces ?? []), ...memberships.map((membership) => membership.workspaceId)])];
}

/** The role keys `actor` holds whose reach covers `resource`. */
function rolesReaching(actor: PersonActor, resource: Resource): string[] {
	const roles: string[] = [];
	const { installRole } = actor;
	if (installRole) {
		const reach = roleDefinition(installRole.role)?.reach;
		const covered =
			reach === "install" ||
			(reach === "assigned-workspaces" &&
				resource.level !== "install" &&
				includes(installRole.workspaces, resource.workspaceId));
		if (covered) roles.push(installRole.role);
	}
	if (resource.level !== "install") {
		for (const membership of actor.memberships) {
			if (membership.workspaceId !== resource.workspaceId) continue;
			if (roleDefinition(membership.role)?.reach !== "membership") continue;
			if (resource.level === "site" && !includes(membership.sites, resource.siteId)) continue;
			roles.push(membership.role);
		}
	}
	return roles;
}

function includes(reach: Reach, id: string): boolean {
	return reach === "all" || reach.includes(id);
}

function describeLevel(level: Level): string {
	return level === "install" ? "the Install" : `a ${level === "workspace" ? "Workspace" : "Site"}`;
}
