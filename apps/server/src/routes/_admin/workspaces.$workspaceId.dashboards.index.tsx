import { createFileRoute } from "@tanstack/react-router";

import { DashboardsPage, dashboardsData } from "../../ui/dashboards/DashboardsPage.tsx";
import { pageTitle } from "../../ui/i18n.tsx";

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/dashboards/")({
	staticData: { crumb: "dashboards.pageTitle" },
	loader: ({ context, params }) =>
		dashboardsData({ workspaceId: params.workspaceId }, context.place.permissions.includes("dashboard.manage")),
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "dashboards.pageTitle") }] }),
	component: WorkspaceDashboards,
});

/** Workspace › Dashboards: Workspace Dashboards, adding up the Workspace's Sites. */
function WorkspaceDashboards() {
	const { workspaceId } = Route.useParams();
	return <DashboardsPage place={{ workspaceId }} data={Route.useLoaderData()} />;
}
