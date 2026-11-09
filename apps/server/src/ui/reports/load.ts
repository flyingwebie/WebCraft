import type { ApiClient } from "@webcraft/api";

import type { ReportPlace } from "./model.ts";
import type { ReportsData } from "./ReportsPage.tsx";

/**
 * What a Dashboard's Reports page loads: the Dashboard's name, its Reports, the history of the one
 * chosen (the first unless `report` names one) and an entry opened for review (`review`).
 */
export async function loadReports(
	api: ApiClient,
	place: ReportPlace,
	dashboardId: string,
	options: { report?: string; review?: string },
): Promise<ReportsData & { crumb: string }> {
	const { dashboard } = await api.dashboards.get({ ...place, dashboardId });
	const { reports } = await api.reports.list({ ...place, dashboardId });
	const report = reports.find((each) => each.id === options.report) ?? reports[0];
	const sends = report ? (await api.reports.history({ ...place, reportId: report.id })).sends : [];
	const review = options.review
		? await api.reports.sends.get({ ...place, sendId: options.review }).then(
				(answer) => answer.send,
				() => null,
			)
		: null;
	return {
		dashboard: { id: dashboard.id, name: dashboard.name },
		reports,
		selected: report ? { report, sends } : null,
		review,
		crumb: dashboard.name,
	};
}
