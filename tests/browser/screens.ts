/**
 * Every admin screen the browser checks, in light and dark: axe-core for WCAG 2.2 A and AA plus
 * keyboard use (see checks.ts). A new screen is one more line here.
 *
 * - `path`: where the screen is on the admin host; a function of the shared fixture for screens
 *   inside a Workspace or Site, such as `({ siteId }) => `/sites/${siteId}``.
 * - `as`: who looks at it: `superadmin`, `staff` (assigned to the Workspace) and `owner` (an Owner
 *   of the Workspace reaching one of its Sites) sign in first, `signed-out` doesn't.
 */
export type Screen = {
	name: string;
	path: string | ((fixture: ScreenFixture) => string);
	as: "superadmin" | "staff" | "owner" | "signed-out";
};

/**
 * What every screen check shares, made once by `admin-screens.browser.ts`: a Workspace with two
 * Sites, a Staff member assigned to it, Members, a pending Staff invite, a pending Member invite
 * to a person who already has an account, and the sample Modules: one approved (on every Site by
 * default), one waiting for approval.
 */
export type ScreenFixture = {
	workspaceId: string;
	siteId: string;
	inviteToken: string;
	joinToken: string;
	/** A photo in the Site's Media library, in a folder, with its sizes made, used by a published Entry. */
	mediaId: string;
	/** A document in the Site's Trash. */
	trashedMediaId: string;
};

export const ADMIN_SCREENS: readonly Screen[] = [
	{ name: "Sign in", path: "/sign-in", as: "signed-out" },
	{ name: "Page not found", path: "/no-such-page", as: "signed-out" },
	{ name: "Install › Overview", path: "/", as: "superadmin" },
	{ name: "Install › Workspaces", path: "/workspaces", as: "superadmin" },
	{ name: "Install › Workspaces (Staff)", path: "/workspaces", as: "staff" },
	{ name: "Install › Staff", path: "/staff", as: "superadmin" },
	{ name: "Install settings › General", path: "/settings/general", as: "superadmin" },
	{ name: "Install settings › Security", path: "/settings/security", as: "superadmin" },
	{ name: "Workspace › Sites", path: ({ workspaceId }) => `/workspaces/${workspaceId}`, as: "superadmin" },
	{ name: "Workspace › Sites (Staff)", path: ({ workspaceId }) => `/workspaces/${workspaceId}`, as: "staff" },
	{ name: "Workspace › Members", path: ({ workspaceId }) => `/workspaces/${workspaceId}/members`, as: "superadmin" },
	{ name: "Workspace › Members (Staff)", path: ({ workspaceId }) => `/workspaces/${workspaceId}/members`, as: "staff" },
	{ name: "Workspace › Members (Owner)", path: ({ workspaceId }) => `/workspaces/${workspaceId}/members`, as: "owner" },
	{ name: "Site › Overview", path: ({ siteId }) => `/sites/${siteId}`, as: "staff" },
	{ name: "Site › Media", path: ({ siteId }) => `/sites/${siteId}/media`, as: "staff" },
	{ name: "Site › Imports, none yet (Staff)", path: ({ siteId }) => `/sites/${siteId}/imports`, as: "staff" },
	{ name: "Site › Imports, none yet (Owner)", path: ({ siteId }) => `/sites/${siteId}/imports`, as: "owner" },
	{
		name: "Site › Media, a file's details",
		path: ({ siteId, mediaId }) => `/sites/${siteId}/media?file=${mediaId}`,
		as: "owner",
	},
	{ name: "Site › Media, no match", path: ({ siteId }) => `/sites/${siteId}/media?q=nothing-matches`, as: "staff" },
	{ name: "Site › Media, the Trash", path: ({ siteId }) => `/sites/${siteId}/media?trash=true`, as: "staff" },
	{
		name: "Site › Media, a file in the Trash",
		path: ({ siteId, trashedMediaId }) => `/sites/${siteId}/media?trash=true&file=${trashedMediaId}`,
		as: "staff",
	},
	{ name: "Install settings › Storage", path: "/settings/storage", as: "superadmin" },
	{ name: "Install settings › Backups, with a failed one", path: "/settings/backups", as: "superadmin" },
	{ name: "Install settings › Email (SMTP), not set", path: "/settings/email", as: "superadmin" },
	{ name: "Install › Email log", path: "/email-log", as: "superadmin" },
	{ name: "Your account", path: "/account", as: "superadmin" },
	{ name: "Accept an invite", path: ({ inviteToken }) => `/invite?token=${inviteToken}`, as: "signed-out" },
	{
		name: "Accept an invite with an existing account",
		path: ({ joinToken }) => `/invite?token=${joinToken}`,
		as: "signed-out",
	},
	{ name: "Accept an invite (link no longer works)", path: "/invite?token=used-up", as: "signed-out" },
	{ name: "Install settings › Modules", path: "/settings/modules", as: "superadmin" },
	{ name: "Workspace › Modules (Staff)", path: ({ workspaceId }) => `/workspaces/${workspaceId}/modules`, as: "staff" },
	{ name: "Site › Modules (Staff)", path: ({ siteId }) => `/sites/${siteId}/modules`, as: "staff" },
	{ name: "Site › Languages (Staff)", path: ({ siteId }) => `/sites/${siteId}/languages`, as: "staff" },
	{ name: "Site › Consent banner (Staff)", path: ({ siteId }) => `/sites/${siteId}/consent-banner`, as: "staff" },
	{ name: "Site › Consent banner (Owner)", path: ({ siteId }) => `/sites/${siteId}/consent-banner`, as: "owner" },
	{ name: "Site › Libraries, none yet (Staff)", path: ({ siteId }) => `/sites/${siteId}/libraries`, as: "staff" },
	{
		name: "Site › Outside scripts, none yet (Staff)",
		path: ({ siteId }) => `/sites/${siteId}/outside-scripts`,
		as: "staff",
	},
	{
		name: "Site › Domains & Staging (Staff), no domain yet",
		path: ({ siteId }) => `/sites/${siteId}/domains`,
		as: "staff",
	},
	{ name: "Site › Domains & Staging (Owner)", path: ({ siteId }) => `/sites/${siteId}/domains`, as: "owner" },
	{ name: "Site › Webhooks, none yet (Staff)", path: ({ siteId }) => `/sites/${siteId}/webhooks`, as: "staff" },
	{ name: "Site › a Module's page", path: ({ siteId }) => `/sites/${siteId}/m/sample/notes`, as: "owner" },
	{ name: "Site › Post Types & Fields (Pages)", path: ({ siteId }) => `/sites/${siteId}/post-types`, as: "staff" },
	{ name: "Site › Loops, none yet", path: ({ siteId }) => `/sites/${siteId}/loops`, as: "staff" },
	{ name: "Site › Globals, none defined yet", path: ({ siteId }) => `/sites/${siteId}/globals`, as: "owner" },
];
