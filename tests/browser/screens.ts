/**
 * Every admin screen the browser checks, in light and dark: axe-core for WCAG 2.2 A and AA plus
 * keyboard use (see checks.ts). A new screen is one more line here.
 *
 * - `path`: where the screen is on the admin host.
 * - `as`: who looks at it: `superadmin` signs in first, `signed-out` doesn't.
 */
export type Screen = { name: string; path: string; as: "superadmin" | "signed-out" };

export const ADMIN_SCREENS: readonly Screen[] = [
	{ name: "Sign in", path: "/sign-in", as: "signed-out" },
	{ name: "Page not found", path: "/no-such-page", as: "signed-out" },
	{ name: "Install › Overview", path: "/", as: "superadmin" },
	{ name: "Install settings › General", path: "/settings/general", as: "superadmin" },
	{ name: "Your account", path: "/account", as: "superadmin" },
];
