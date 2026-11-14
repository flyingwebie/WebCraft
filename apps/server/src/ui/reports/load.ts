import type { ApiClient } from "@webcraft/api";

import type { LoaderCrumb } from "../shell/Breadcrumbs.tsx";
import type { ReportPlace } from "./model.ts";
import type { ReportsData } from "./ReportsPage.tsx";

/**
 * What a Dashboard's Reports page loads: the Dashboard's name, its Reports, what each of them sent
 * (newest first, all together) and an entry opened for review (`review`).
 */
export async function loadReports(
	api: ApiClient,
	place: ReportPlace,
	dashboardId: string,
	options: { review?: string },
): Promise<ReportsData & { crumb: string; crumbs: LoaderCrumb[] }> {
	const { dashboard } = await api.dashboards.get({ ...place, dashboardId });
	const { reports } = await api.reports.list({ ...place, dashboardId });
	const histories = await Promise.all(
		reports.map((report) => api.reports.history({ ...place, reportId: report.id }).then((answer) => answer.sends)),
	);
	const sent = histories.flat().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	const review = options.review
		? await api.reports.sends.get({ ...place, sendId: options.review }).then(
				(answer) => answer.send,
				() => null,
			)
		: null;
	return {
		dashboard: { id: dashboard.id, name: dashboard.name },
		reports,
		sent,
		review,
		crumb: dashboard.name,
		// "… › Site analytics › Reports": the Reports page isn't nested under its Dashboard's.
		crumbs: [
			{
				label: dashboard.name,
				pathname:
					"siteId" in place
						? `/sites/${place.siteId}/dashboards/${dashboard.id}`
						: `/workspaces/${place.workspaceId}/dashboards/${dashboard.id}`,
			},
			{ message: "reports.heading" },
		],
	};
}
