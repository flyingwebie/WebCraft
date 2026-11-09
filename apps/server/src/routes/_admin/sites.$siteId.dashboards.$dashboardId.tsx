import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { DashboardScreen } from "../../ui/dashboards/DashboardScreen.tsx";
import { rangeFromSearch, rangeToSearch } from "../../ui/dashboards/model.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitleOf } from "../../ui/i18n.tsx";

/** The days being explored (`?range=last7Days`, `?range=2026-03-01_2026-03-31`), in place of the Dashboard's. */
const search = z.object({ range: z.string().max(40).optional().catch(undefined) });

export const Route = createFileRoute("/_admin/sites/$siteId/dashboards/$dashboardId")({
	staticData: { wide: true },
	validateSearch: search,
	loader: async ({ params }) => {
		const api = await getApi();
		try {
			const { dashboard } = await api.dashboards.get({ siteId: params.siteId, dashboardId: params.dashboardId });
			const catalog = dashboard.canManage ? (await api.dashboards.catalog({ siteId: params.siteId })).kinds : null;
			return { dashboard, catalog, crumb: dashboard.name };
		} catch (error) {
			if (errorCode(error) === "DASHBOARD_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	head: ({ match, loaderData }) => ({
		meta: [{ title: pageTitleOf(match.context.shell.language.code, loaderData?.crumb, match.context.site.name) }],
	}),
	component: SiteDashboard,
});

/** One of a Site's Dashboards. */
function SiteDashboard() {
	const { siteId, dashboardId } = Route.useParams();
	const { dashboard, catalog } = Route.useLoaderData();
	const { place } = Route.useRouteContext();
	const { range } = Route.useSearch();
	const navigate = useNavigate();
	return (
		<DashboardScreen
			place={{ siteId }}
			dashboard={dashboard}
			catalog={catalog}
			explored={rangeFromSearch(range)}
			onExplore={(next) =>
				void navigate({
					to: "/sites/$siteId/dashboards/$dashboardId",
					params: { siteId, dashboardId },
					search: { range: next ? rangeToSearch(next) : undefined },
					replace: true,
				})
			}
			workspaceName={place.level === "site" ? place.workspace.name : ""}
			listPath={async () => {
				await navigate({ to: "/sites/$siteId/dashboards", params: { siteId } });
			}}
		/>
	);
}
