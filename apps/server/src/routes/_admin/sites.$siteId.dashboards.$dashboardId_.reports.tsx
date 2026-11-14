import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitleOf, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { loadReports } from "../../ui/reports/load.ts";
import { ReportsPage } from "../../ui/reports/ReportsPage.tsx";

/**
 * An entry opened for review (`review`); `report` is what older links named to show one Report's
 * history, which the page now shows with every other Report's.
 */
const search = z.object({
	report: z.uuid().optional().catch(undefined),
	review: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_admin/sites/$siteId/dashboards/$dashboardId_/reports")({
	validateSearch: search,
	loaderDeps: ({ search: { review } }) => ({ review }),
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
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<ReportsPage
			key={data.review?.id ?? "reports"}
			place={{ siteId }}
			data={data}
			canManage={place.permissions.includes("report.manage")}
			canEditRecipients={place.permissions.includes("reportRecipients.edit")}
		/>
	);
}
