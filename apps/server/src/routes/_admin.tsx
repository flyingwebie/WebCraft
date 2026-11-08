import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AdminShell } from "../ui/shell/AdminShell.tsx";
import type { AdminPlace } from "../ui/shell/levels.ts";

/** Every page of the admin shell: only for signed-in people, once the Install has its Superadmin. */
export const Route = createFileRoute("/_admin")({
	beforeLoad: ({ context, location }) => {
		const { shell } = context;
		if (shell.setup.stage === "claim") throw redirect({ to: "/setup" });
		if (!shell.person) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
		return { person: shell.person };
	},
	component: AdminLayout,
});

/** The Install level is the only one until Workspaces and Sites exist; their routes set their own place. */
const INSTALL: AdminPlace = { level: "install" };

function AdminLayout() {
	const { shell, person } = Route.useRouteContext();
	return (
		<AdminShell shell={shell} person={person} place={INSTALL}>
			<Outlet />
		</AdminShell>
	);
}
