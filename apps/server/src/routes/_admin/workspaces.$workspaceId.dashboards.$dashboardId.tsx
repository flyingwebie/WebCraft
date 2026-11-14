import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { DashboardScreen } from "../../ui/dashboards/DashboardScreen.tsx";
import { rangeFromSearch, rangeToSearch } from "../../ui/dashboards/model.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitleOf } from "../../ui/i18n.tsx";

/**
 * The address keeps what the person is looking at: the days explored in place of the Dashboard's
 * (`?range=last7Days`, `?range=2026-03-01_2026-03-31`), whether it compares with the period before
 * (`?compare=true`), and New Dashboard open over it (`?new=true`).
 */
const search = z.object({
	range: z.string().max(40).optional().catch(undefined),
	compare: z.boolean().optional().catch(undefined),
	new: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/dashboards/$dashboardId")({
	staticData: { width: "wide" },
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
	const search = Route.useSearch();
	const navigate = useNavigate();
	const go = (next: typeof search) =>
		void navigate({
			to: "/workspaces/$workspaceId/dashboards/$dashboardId",
			params: { workspaceId, dashboardId },
			search: next,
			replace: true,
		});
	return (
		<DashboardScreen
			place={{ workspaceId }}
			dashboard={dashboard}
			catalog={catalog}
			explored={rangeFromSearch(search.range)}
			onExplore={(next) => go({ ...search, range: next ? rangeToSearch(next) : undefined })}
			compare={search.compare === true}
			onCompare={(compare) => go({ ...search, compare: compare || undefined })}
			creating={search.new === true && dashboard.canManage}
			onCreating={(creating) => go({ ...search, new: creating || undefined })}
			workspaceName={place.level === "workspace" ? place.workspace.name : ""}
			sitesCount={place.level === "workspace" ? place.sites.length : 0}
			sharing={{
				reports: place.permissions.includes("report.view")
					? { to: "/workspaces/$workspaceId/dashboards/$dashboardId/reports", params: { workspaceId, dashboardId } }
					: null,
				shareLinks: place.permissions.includes("shareLink.view"),
				manageShareLinks: place.permissions.includes("shareLink.manage"),
				language: shell.language.code,
			}}
			listPath={async () => {
				// After a Dashboard is deleted: the first one left, or the list when none is.
				const { dashboards } = await (await getApi()).dashboards.list({ workspaceId });
				const [first] = dashboards;
				if (first) {
					await navigate({
						to: "/workspaces/$workspaceId/dashboards/$dashboardId",
						params: { workspaceId, dashboardId: first.id },
					});
				} else {
					await navigate({ to: "/workspaces/$workspaceId/dashboards", params: { workspaceId } });
				}
			}}
		/>
	);
}
