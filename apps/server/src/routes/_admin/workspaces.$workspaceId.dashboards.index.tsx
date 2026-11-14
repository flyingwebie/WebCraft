import { createFileRoute, redirect } from "@tanstack/react-router";

import { DashboardsPage, dashboardsData } from "../../ui/dashboards/DashboardsPage.tsx";
import { pageTitle } from "../../ui/i18n.tsx";

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/dashboards/")({
	staticData: { crumb: "dashboards.pageTitle" },
	// The Dashboards open on the first one; "New Dashboard" (this address) opens over it as a dialog.
	// With none yet, the list says so and offers New Dashboard.
	loader: async ({ context, params }) => {
		const canManage = context.place.permissions.includes("dashboard.manage");
		const data = await dashboardsData({ workspaceId: params.workspaceId }, canManage);
		const [first] = data.dashboards;
		if (first) {
			throw redirect({
				to: "/workspaces/$workspaceId/dashboards/$dashboardId",
				params: { workspaceId: params.workspaceId, dashboardId: first.id },
				search: canManage ? { new: true } : {},
				replace: true,
			});
		}
		return data;
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "dashboards.pageTitle") }] }),
	component: WorkspaceDashboards,
});

/** Workspace › Dashboards: Workspace Dashboards, adding up the Workspace's Sites. */
function WorkspaceDashboards() {
	const { workspaceId } = Route.useParams();
	return <DashboardsPage place={{ workspaceId }} data={Route.useLoaderData()} />;
}
