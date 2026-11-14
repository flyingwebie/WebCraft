import { createFileRoute, redirect } from "@tanstack/react-router";

import { DashboardsPage, dashboardsData } from "../../ui/dashboards/DashboardsPage.tsx";
import { pageTitle } from "../../ui/i18n.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/dashboards/")({
	staticData: { crumb: "dashboards.pageTitle" },
	// The Dashboards open on the first one; "New Dashboard" (this address) opens over it as a dialog.
	// With none yet, the list says so and offers New Dashboard.
	loader: async ({ context, params }) => {
		const canManage = context.place.permissions.includes("dashboard.manage");
		const data = await dashboardsData({ siteId: params.siteId }, canManage);
		const [first] = data.dashboards;
		if (first) {
			throw redirect({
				to: "/sites/$siteId/dashboards/$dashboardId",
				params: { siteId: params.siteId, dashboardId: first.id },
				search: canManage ? { new: true } : {},
				replace: true,
			});
		}
		return data;
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "dashboards.pageTitle") }] }),
	component: SiteDashboards,
});

/** Site › Dashboards: the Site's Dashboards the person sees, and, for Staff, new ones and templates. */
function SiteDashboards() {
	const { siteId } = Route.useParams();
	return <DashboardsPage place={{ siteId }} data={Route.useLoaderData()} />;
}
