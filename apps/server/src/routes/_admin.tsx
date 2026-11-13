import { createFileRoute, Outlet, redirect, useMatches } from "@tanstack/react-router";

import { AdminShell } from "../ui/shell/AdminShell.tsx";
import type { AdminPlace } from "../ui/shell/levels.ts";

/**
 * Every page of the admin shell: only for signed-in people, once the Install has its Superadmin.
 * Pages are at the Install level unless a route below sets `place` in its context, as the Workspace
 * (`workspaces.$workspaceId.tsx`) and Site (`sites.$siteId.tsx`) routes do.
 */
export const Route = createFileRoute("/_admin")({
	beforeLoad: ({ context, location }) => {
		const { shell } = context;
		if (shell.setup.stage === "claim") throw redirect({ to: "/setup" });
		if (!shell.person) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
		// Someone who must use two-factor authentication sets it up before anything else.
		if (shell.twoFactor?.mustSetUp) throw redirect({ to: "/two-factor", search: { redirect: location.href } });
		const place: AdminPlace = { level: "install", permissions: shell.permissions };
		return { person: shell.person, place };
	},
	component: AdminLayout,
});

function AdminLayout() {
	const { shell, person, place: install } = Route.useRouteContext();
	// The deepest route that knows where it is decides the level.
	const place = useMatches({
		select: (matches) =>
			matches
				.map((match) => (match.context as { place?: AdminPlace } | undefined)?.place)
				.filter((found): found is AdminPlace => Boolean(found))
				.at(-1),
	});
	return (
		<AdminShell shell={shell} person={person} place={place ?? install}>
			<Outlet />
		</AdminShell>
	);
}
