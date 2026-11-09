import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitleOf, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { loadReports } from "../../ui/reports/load.ts";
import { ReportsPage } from "../../ui/reports/ReportsPage.tsx";

/** Whose history shows (the first Report's unless given), and an entry of it opened for review. */
const search = z.object({
	report: z.uuid().optional().catch(undefined),
	review: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_admin/sites/$siteId/dashboards/$dashboardId_/reports")({
	validateSearch: search,
	loaderDeps: ({ search: { report, review } }) => ({ report, review }),
	loader: async ({ params, deps, context }) => {
		if (!context.place.permissions.includes("report.view")) return null;
		try {
			return await loadReports(await getApi(), { siteId: params.siteId }, params.dashboardId, deps);
		} catch (error) {
			if (errorCode(error) === "DASHBOARD_NOT_FOUND") throw notFound();
			throw error;
		}
	},
	head: ({ match, loaderData }) => ({
		meta: [{ title: pageTitleOf(match.context.shell.language.code, loaderData?.crumb, match.context.site.name) }],
	}),
	component: SiteReports,
});

/** Site › Dashboards › one › Reports: the Dashboard's Reports and their history. */
function SiteReports() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId, dashboardId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<ReportsPage
			key={`${data.selected?.report.id}-${data.review?.id}`}
			place={{ siteId }}
			data={data}
			canManage={place.permissions.includes("report.manage")}
			canEditRecipients={place.permissions.includes("reportRecipients.edit")}
			dashboardPath={{ to: "/sites/$siteId/dashboards/$dashboardId", params: { siteId, dashboardId } }}
		/>
	);
}
