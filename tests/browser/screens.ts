/**
 * Every admin screen the browser checks, in light and dark: axe-core for WCAG 2.2 A and AA plus
 * keyboard use (see checks.ts). A new screen is one more line here.
 *
 * - `path`: where the screen is on the admin host; a function of the shared fixture for screens
 *   inside a Workspace or Site, such as `({ siteId }) => `/sites/${siteId}``.
 * - `as`: who looks at it: `superadmin` and `staff` sign in first, `signed-out` doesn't.
 */
export type Screen = {
	name: string;
	path: string | ((fixture: ScreenFixture) => string);
	as: "superadmin" | "staff" | "signed-out";
};

/**
 * What every screen check shares, made once by `admin-screens.browser.ts`: a Workspace with a Site,
 * a Staff member assigned to it, and a pending Staff invite.
 */
export type ScreenFixture = { workspaceId: string; siteId: string; inviteToken: string };

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
	{ name: "Site › Overview", path: ({ siteId }) => `/sites/${siteId}`, as: "staff" },
	{ name: "Install settings › Email (SMTP), not set", path: "/settings/email", as: "superadmin" },
	{ name: "Install › Email log", path: "/email-log", as: "superadmin" },
	{ name: "Your account", path: "/account", as: "superadmin" },
	{ name: "Accept an invite", path: ({ inviteToken }) => `/invite?token=${inviteToken}`, as: "signed-out" },
	{ name: "Accept an invite (link no longer works)", path: "/invite?token=used-up", as: "signed-out" },
];
