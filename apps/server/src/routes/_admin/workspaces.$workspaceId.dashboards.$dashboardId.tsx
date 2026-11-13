import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { DashboardScreen } from "../../ui/dashboards/DashboardScreen.tsx";
import { rangeFromSearch, rangeToSearch } from "../../ui/dashboards/model.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitleOf } from "../../ui/i18n.tsx";

/** The days being explored, in place of the Dashboard's. */
const search = z.object({ range: z.string().max(40).optional().catch(undefined) });

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/dashboards/$dashboardId")({
	staticData: { wide: true },
	validateSearch: search,
	loader: async ({ params }) => {
		const api = await getApi();
		try {
			const place = { workspaceId: params.workspaceId };
			const { dashboard } = await api.dashboards.get({ ...place, dashboardId: params.dashboardId });
			const catalog = dashboard.canManage ? (await api.dashboards.catalog(place)).kinds : null;
			return { dashboard, catalog, crumb: dashboard.name };
		} catch (error) {
			if (errorCode(error) === "DASHBOARD_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	head: ({ match, loaderData }) => ({
		meta: [{ title: pageTitleOf(match.context.shell.language.code, loaderData?.crumb) }],
	}),
	component: WorkspaceDashboard,
});

/** One Workspace Dashboard: its Widgets add up the Workspace's Sites the person sees. */
function WorkspaceDashboard() {
	const { workspaceId, dashboardId } = Route.useParams();
	const { dashboard, catalog } = Route.useLoaderData();
	const { place, shell } = Route.useRouteContext();
	const { range } = Route.useSearch();
	const navigate = useNavigate();
	return (
		<DashboardScreen
			place={{ workspaceId }}
			dashboard={dashboard}
			catalog={catalog}
			explored={rangeFromSearch(range)}
			onExplore={(next) =>
				void navigate({
					to: "/workspaces/$workspaceId/dashboards/$dashboardId",
					params: { workspaceId, dashboardId },
					search: { range: next ? rangeToSearch(next) : undefined },
					replace: true,
				})
			}
			workspaceName={place.level === "workspace" ? place.workspace.name : ""}
			sharing={{
				reports: place.permissions.includes("report.view")
					? { to: "/workspaces/$workspaceId/dashboards/$dashboardId/reports", params: { workspaceId, dashboardId } }
					: null,
				shareLinks: place.permissions.includes("shareLink.view"),
				manageShareLinks: place.permissions.includes("shareLink.manage"),
				language: shell.language.code,
			}}
			listPath={async () => {
				await navigate({ to: "/workspaces/$workspaceId/dashboards", params: { workspaceId } });
			}}
		/>
	);
}
