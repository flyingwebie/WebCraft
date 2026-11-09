import { createFileRoute } from "@tanstack/react-router";

import { DashboardsPage, dashboardsData } from "../../ui/dashboards/DashboardsPage.tsx";
import { pageTitle } from "../../ui/i18n.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/dashboards/")({
	staticData: { crumb: "dashboards.pageTitle" },
	loader: ({ context, params }) =>
		dashboardsData({ siteId: params.siteId }, context.place.permissions.includes("dashboard.manage")),
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "dashboards.pageTitle") }] }),
	component: SiteDashboards,
});

/** Site › Dashboards: the Site's Dashboards the person sees, and, for Staff, new ones and templates. */
function SiteDashboards() {
	const { siteId } = Route.useParams();
	return <DashboardsPage place={{ siteId }} data={Route.useLoaderData()} />;
}
