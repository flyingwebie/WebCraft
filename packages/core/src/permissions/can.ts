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
 * A Module acting by itself: in one of its background jobs, events or Site routes. It acts in one
 * place at a time, the Site (or the Workspace, for Workspace-level Modules) where it is switched on
 * and runs now. There it holds `site.view` / `workspace.view` and the Permissions it adds; nothing
 * anywhere else, and never a Permission of WebCraft's own beyond seeing the place.
 */
export type ModuleActor = {
	kind: "module";
	moduleId: string;
	/** The keys of the Permissions it adds, such as `sample.notes.edit`. */
	permissions: readonly string[];
	place: { level: "workspace"; workspaceId: string } | { level: "site"; workspaceId: string; siteId: string };
};

/**
 * An API token: its person acting through the Management API (`/api/v1`), never with more access
 * than they have now (`person` is read fresh for every request) and limited further to the token's
 * Workspace and Sites. A token limited to some Sites holds nothing on the Workspace itself but
 * seeing it, so it can't act on the rest of the Workspace. Whether it may only read is decided per
 * procedure, where the request comes in; Sensitive actions are never its to take.
 */
export type TokenActor = {
	kind: "token";
	tokenId: string;
	person: PersonActor;
	workspaceId: string;
	sites: Reach;
};

/**
 * An OAuth grant: its person acting through an AI client they approved (the MCP server at `/mcp`),
 * never with more access than they have now (`person` is read fresh for every request) and limited
 * further to the grant's Workspace and Sites, as an API token is. Its Toolsets, whether it only
 * reads and whether it may publish are decided per procedure, where the request comes in; Sensitive
 * actions are never its to take.
 */
export type GrantActor = {
	kind: "grant";
	grantId: string;
	person: PersonActor;
	workspaceId: string;
	sites: Reach;
};

/** An API client: an API token or an OAuth grant, its person acting within its limits. */
export type ClientActor = TokenActor | GrantActor;

/**
 * Who `can()` is asked about: a person, a Module, an API token or an OAuth grant, each limited by
 * what stands behind it.
 */
export type Actor = PersonActor | ModuleActor | ClientActor;

/**
 * A Permission a Module adds (ADR 0028): named under the Module's id (`sample.notes.edit`), checked
 * at the Module's level, and held by the built-in roles it lists (the Superadmin always among them).
 */
export type AddedPermission = {
	readonly key: string;
	readonly levels: readonly Level[];
	readonly roles: readonly string[];
};

/** The person behind an actor (an API token's or grant's is the person who made it), or null for a Module. */
export function personIdOf(actor: Actor): string | null {
	switch (actor.kind) {
		case "person":
			return actor.personId;
		case "token":
		case "grant":
			return actor.person.personId;
		case "module":
			return null;
	}
}

/**
 * The person behind an actor, for what only a person does (confirming an action, writing a value
 * that records who wrote it). Throws for any other actor, which never gets that far.
 */
export function actingPerson(actor: Actor): string {
	const personId = personIdOf(actor);
	if (personId === null) throw new TypeError(`Only a person can do this, not a ${actor.kind}.`);
	return personId;
}

/**
 * Whether `actor` may do `permission` on `resource`. The one permission check: every procedure goes
 * through it (most of them through the data layer). Throws a TypeError when the Permission isn't
 * checked at the resource's level, such as `entry.publish` on a whole Workspace.
 */
export function can(actor: Actor, permission: Permission | AddedPermission, resource: Resource): boolean {
	const key = typeof permission === "string" ? permission : permission.key;
	const levels: readonly Level[] = typeof permission === "string" ? PERMISSIONS[permission] : permission.levels;
	if (!levels.includes(resource.level)) {
		throw new TypeError(
			`The Permission ${key} is checked on ${levels.join(" or ")}, not on ${describeLevel(resource.level)}.`,
		);
	}
	switch (actor.kind) {
		case "person":
			return rolesReaching(actor, resource).some((role) =>
				typeof permission === "string"
					? roleDefinition(role)?.permissions.includes(permission)
					: roleDefinition(role) !== undefined && permission.roles.includes(role),
			);
		case "module":
			return (
				moduleReaches(actor, resource) && (MODULE_VIEW_PERMISSIONS.includes(key) || actor.permissions.includes(key))
			);
		case "token":
		case "grant":
			return clientReaches(actor, resource, key) && can(actor.person, permission, resource);
	}
}

/**
 * Whether `resource` is within an API client's limits (an API token's or an OAuth grant's): its
 * Workspace, and there only the Sites it lists. One listing some Sites sees its Workspace and
 * nothing more of it.
 */
function clientReaches(actor: ClientActor, resource: Resource, key: string): boolean {
	if (resource.level === "install" || resource.workspaceId !== actor.workspaceId) return false;
	if (resource.level === "site") return includes(actor.sites, resource.siteId);
	return actor.sites === "all" || key === "workspace.view";
}

/** What a Module holds wherever it acts, so it can open its place. */
const MODULE_VIEW_PERMISSIONS: readonly string[] = ["workspace.view", "site.view"];

/** Whether `resource` is the Module's place, or a Site of the Workspace a Workspace-level Module acts in. */
function moduleReaches(actor: ModuleActor, resource: Resource): boolean {
	if (resource.level === "install" || resource.workspaceId !== actor.place.workspaceId) return false;
	if (actor.place.level === "workspace") return true;
	return resource.level === "site" && resource.siteId === actor.place.siteId;
}

/** Every Permission `actor` holds on `resource`, in the order of `PERMISSIONS`. */
export function permissionsOn(actor: Actor, resource: Resource): Permission[] {
	return ALL_PERMISSIONS.filter(
		(permission) =>
			(PERMISSIONS[permission] as readonly Level[]).includes(resource.level) && can(actor, permission, resource),
	);
}

/** Stands for every Site of a Workspace, including Sites created later. */
const EVERY_SITE = Symbol("every Site of the Workspace");

/** What a role is looked up for: a resource, or every Site of a Workspace at once. */
type Target = Resource | { level: "site"; workspaceId: string; siteId: typeof EVERY_SITE };

/** The access a Membership gives: a Workspace role key, and the Sites of its Workspace it reaches. */
export type MemberAccess = { role: string; sites: Reach };

/**
 * Whether `actor` holds at least the access a Membership in the Workspace gives: every Permission of
 * its role on the Workspace, and on every Site it reaches (for "all", on every Site of the Workspace,
 * including Sites created later). Nobody grants more access than they hold, in role or in Sites:
 * inviting a Member or changing a Member's access needs this for the new access, and changing or
 * removing a Member needs it for the access they have now. A role key that isn't a Workspace role is
 * never held this way.
 */
export function holdsAccess(actor: Actor, workspaceId: string, access: MemberAccess): boolean {
	if (actor.kind === "token" || actor.kind === "grant") {
		// A token or grant holds what its person holds, within its Workspace and Sites.
		if (actor.workspaceId !== workspaceId) return false;
		const sites =
			access.sites === "all" ? actor.sites === "all" : access.sites.every((id) => includes(actor.sites, id));
		return sites && holdsAccess(actor.person, workspaceId, access);
	}
	if (actor.kind !== "person") return false;
	const role = roleDefinition(access.role);
	if (role?.reach !== "membership") return false;
	const checkedOn = (level: Level) =>
		role.permissions.filter((permission) => (PERMISSIONS[permission] as readonly Level[]).includes(level));
	const workspace: Resource = { level: "workspace", workspaceId };
	if (!checkedOn("workspace").every((permission) => can(actor, permission, workspace))) return false;
	const onSites = checkedOn("site");
	const targets: (string | typeof EVERY_SITE)[] = access.sites === "all" ? [EVERY_SITE] : [...access.sites];
	return targets.every((siteId) => {
		const held = rolesReaching(actor, { level: "site", workspaceId, siteId }).flatMap(
			(key) => roleDefinition(key)?.permissions ?? [],
		);
		return onSites.every((permission) => held.includes(permission));
	});
}

/**
 * The Workspaces `actor` holds any role in: "all" for the Superadmin and Staff assigned to every
 * Workspace. Listing Workspaces starts here, then keeps those `can(actor, "workspace.view", …)` allows.
 */
export function workspacesReached(actor: Actor): Reach {
	if (actor.kind === "module") return [actor.place.workspaceId];
	if (actor.kind === "token" || actor.kind === "grant") return [actor.workspaceId];
	const { installRole, memberships } = actor;
	const reach = installRole ? roleDefinition(installRole.role)?.reach : undefined;
	if (reach === "install") return "all";
	const staffWorkspaces = reach === "assigned-workspaces" ? installRole?.workspaces : [];
	if (staffWorkspaces === "all") return "all";
	return [...new Set([...(staffWorkspaces ?? []), ...memberships.map((membership) => membership.workspaceId)])];
}

/** The role keys `actor` holds whose reach covers `target`. */
function rolesReaching(actor: PersonActor, target: Target): string[] {
	const roles: string[] = [];
	const { installRole } = actor;
	if (installRole) {
		const reach = roleDefinition(installRole.role)?.reach;
		// Staff hold an Install-level role (ADR 0001): its Install-level Permissions (only the few its row
		// lists, such as writing the Services list) apply on the Install itself; the rest in the
		// Workspaces it is assigned to.
		const covered =
			reach === "install" ||
			(reach === "assigned-workspaces" &&
				(target.level === "install" || includes(installRole.workspaces, target.workspaceId)));
		if (covered) roles.push(installRole.role);
	}
	if (target.level !== "install") {
		for (const membership of actor.memberships) {
			if (membership.workspaceId !== target.workspaceId) continue;
			if (roleDefinition(membership.role)?.reach !== "membership") continue;
			if (target.level === "site" && !includes(membership.sites, target.siteId)) continue;
			roles.push(membership.role);
		}
	}
	return roles;
}

/** Whether `reach` covers `id`; only "all" covers every Site at once. */
function includes(reach: Reach, id: string | typeof EVERY_SITE): boolean {
	return reach === "all" || (typeof id === "string" && reach.includes(id));
}

function describeLevel(level: Level): string {
	return level === "install" ? "the Install" : `a ${level === "workspace" ? "Workspace" : "Site"}`;
}
