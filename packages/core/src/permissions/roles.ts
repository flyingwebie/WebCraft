/**
 * Permissions and the built-in roles (ADR 0028).
 *
 * `can()` checks named Permissions, never role names. Each Permission says at which level it is
 * checked: on the Install, on a Workspace or on a Site. Each built-in role is a Permission set in
 * `ROLES`, one row per role; `tests/permissions/roles.test.ts` has one test per row.
 *
 * Adding a Permission: add it to `PERMISSIONS` with its level, add it to the roles that hold it,
 * and update the role tests.
 */

/** The levels a Permission is checked at. */
export type Level = "install" | "workspace" | "site";

/**
 * Every Permission, with the levels it is checked at. Permissions of later features are listed
 * here already where they define a role (who publishes, who invites Members, who changes Structure).
 */
export const PERMISSIONS = {
	/** Install settings and the Master key confirmation. */
	"install.manage": ["install"],
	"workspace.create": ["install"],
	/** Invite Staff, choose their Workspaces, revoke Staff invites. */
	"staff.manage": ["install"],
	/** Read the Audit log: the whole Install's, or one Workspace's. */
	"audit.view": ["install", "workspace"],
	/** Approve Modules (what they ask for), withdraw approvals, and read the Module log. */
	"module.approve": ["install"],
	/** See a Workspace and open it in the admin. */
	"workspace.view": ["workspace"],
	"site.create": ["workspace"],
	/** Invite Members, and resend or revoke Member invites. Nobody grants more access than they hold. */
	"member.invite": ["workspace"],
	/** See the Workspace's Members, change their role and Sites, and remove them. */
	"member.manage": ["workspace"],
	/**
	 * Switch Modules on and off, and remove their data: Workspace-level Modules on a Workspace,
	 * Site-level Modules on a Site.
	 */
	"module.manage": ["workspace", "site"],
	/** Set or remove a Workspace's Media storage quota (Staff: it keeps one client from filling the server). */
	"quota.manage": ["workspace"],
	/** Set, replace, test and remove the Workspace's own AI key, and its monthly cap (Staff and Owners). */
	"aiKey.manage": ["workspace"],
	/** See what AI costs: tokens and estimated cost per key and Site (Staff and Owners only). */
	"aiUsage.view": ["workspace", "site"],
	/** Change the Protected terms AI translation leaves as written: the Workspace's, or a Site's. */
	"protectedTerms.edit": ["workspace", "site"],
	/** See a Site and open it in the admin, and on its Staging address. */
	"site.view": ["site"],
	/** Set or remove the Site's staging password, which lets people without an account see its Staging address. */
	"staging.manage": ["site"],
	/** Change a Site's Structure: Post Types, Fields, Templates, Components, the Design system, settings. */
	"structure.edit": ["site"],
	/**
	 * Choose what the Site's robots.txt says to AI crawlers (allow all, allow search but block training,
	 * block all): Staff and Owners (spec story 119). Staff's own robots.txt lines stay `structure.edit`.
	 */
	"aiCrawlers.manage": ["site"],
	/** Edit Content and save Drafts. */
	"entry.edit": ["site"],
	"entry.publish": ["site"],
	/**
	 * Change a Form's emails (Content): where its Submissions are sent (Notification recipients and
	 * routing), the Notifications' words and the Auto-reply, in their Draft, and publish them. Never
	 * Authors: recipients decide who gets the Site's leads.
	 */
	"formEmails.edit": ["site"],
	/** Delete an Entry, removing the links other Entries make to it. */
	"entry.delete": ["site"],
	/** Upload to the Site's Media library, and change your own uploads. */
	"media.upload": ["site"],
	/** Change every file in the Site's Media library, and its folders. */
	"media.manage": ["site"],
	/**
	 * Bring outside content into a Site as Drafts: create and run Imports, stop and undo Import runs,
	 * and read Import reports (Staff, Owners and Editors; a source can ask for more, such as Staff only).
	 */
	"import.run": ["site"],
	/**
	 * Set each language's Translation mode (Automatic, Review, Manual) and start AI translation of the
	 * whole Site (Translate now), which spends the Workspace's AI budget: Staff and Owners.
	 */
	"translation.manage": ["site"],
	/**
	 * Build Dashboards: a Site's, from the Widget catalog, and a Workspace's, adding up its Sites; make
	 * Dashboard templates from them, and choose who else sees each (Staff).
	 */
	"dashboard.manage": ["workspace", "site"],
	/**
	 * See every Dashboard of a Site or Workspace and export its Widgets as CSV files (Staff and Owners).
	 * Editors and Authors see the Dashboards Staff show to everyone who works on the Site, and only those.
	 */
	"dashboard.view": ["workspace", "site"],
} as const satisfies Record<string, readonly Level[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Every Permission, in the order of `PERMISSIONS`. */
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** The built-in role keys. Memberships and Install-level roles store these as text. */
export const ROLE_KEYS = ["superadmin", "staff", "owner", "editor", "author"] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

/**
 * Where a role is held and what it reaches:
 * - `install`: an Install-level role reaching the whole Install (the Superadmin).
 * - `assigned-workspaces`: an Install-level role reaching the Workspaces its holder is assigned to,
 *   some or all of them, and their Sites (Staff).
 * - `membership`: a Workspace role, held on a Membership, reaching that Workspace and the Sites the
 *   Membership reaches.
 */
export type RoleReach = "install" | "assigned-workspaces" | "membership";

export type RoleDefinition = { reach: RoleReach; permissions: readonly Permission[] };

/**
 * The role table: each built-in role is a Permission set. Built-in keys are reserved and never
 * editable; custom roles, later, are new rows with new keys.
 */
export const ROLES: Record<RoleKey, RoleDefinition> = {
	superadmin: { reach: "install", permissions: ALL_PERMISSIONS },
	staff: {
		reach: "assigned-workspaces",
		permissions: [
			"audit.view",
			"workspace.view",
			"site.create",
			"member.invite",
			"member.manage",
			"module.manage",
			"quota.manage",
			"aiKey.manage",
			"aiUsage.view",
			"protectedTerms.edit",
			"site.view",
			"staging.manage",
			"structure.edit",
			"aiCrawlers.manage",
			"entry.edit",
			"entry.publish",
			"formEmails.edit",
			"entry.delete",
			"media.upload",
			"media.manage",
			"import.run",
			"translation.manage",
			"dashboard.manage",
			"dashboard.view",
		],
	},
	owner: {
		reach: "membership",
		permissions: [
			"audit.view",
			"workspace.view",
			"member.invite",
			"member.manage",
			"aiKey.manage",
			"aiUsage.view",
			"protectedTerms.edit",
			"site.view",
			"staging.manage",
			"aiCrawlers.manage",
			"entry.edit",
			"entry.publish",
			"formEmails.edit",
			"entry.delete",
			"media.upload",
			"media.manage",
			"import.run",
			"translation.manage",
			"dashboard.view",
		],
	},
	editor: {
		reach: "membership",
		permissions: [
			"workspace.view",
			"protectedTerms.edit",
			"site.view",
			"entry.edit",
			"entry.publish",
			"formEmails.edit",
			"entry.delete",
			"media.upload",
			"media.manage",
			"import.run",
		],
	},
	author: {
		reach: "membership",
		permissions: ["workspace.view", "site.view", "entry.edit", "media.upload"],
	},
};

/** The role key of the Superadmin. */
export const SUPERADMIN_ROLE = "superadmin" satisfies RoleKey;

/** The role key of Staff. */
export const STAFF_ROLE = "staff" satisfies RoleKey;

/** The roles that reach Workspaces by assignment (Staff), rather than through a Membership. */
export const ASSIGNED_ROLES: readonly string[] = ROLE_KEYS.filter((key) => ROLES[key].reach === "assigned-workspaces");

/** The Workspace roles a Membership can hold. */
export const WORKSPACE_ROLES = ["owner", "editor", "author"] as const satisfies readonly RoleKey[];

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** The definition of a stored role key, or undefined for a key WebCraft doesn't know (it grants nothing). */
export function roleDefinition(key: string): RoleDefinition | undefined {
	return Object.hasOwn(ROLES, key) ? ROLES[key as RoleKey] : undefined;
}

export function isWorkspaceRole(key: string): key is WorkspaceRole {
	return (WORKSPACE_ROLES as readonly string[]).includes(key);
}

export function isPermission(value: string): value is Permission {
	return Object.hasOwn(PERMISSIONS, value);
}
