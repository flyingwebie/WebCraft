import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitleOf, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { loadReports } from "../../ui/reports/load.ts";
import { ReportsPage } from "../../ui/reports/ReportsPage.tsx";

const search = z.object({
	report: z.uuid().optional().catch(undefined),
	review: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/dashboards/$dashboardId_/reports")({
	validateSearch: search,
	loaderDeps: ({ search: { report, review } }) => ({ report, review }),
	loader: async ({ params, deps, context }) => {
		if (!context.place.permissions.includes("report.view")) return null;
		try {
			return await loadReports(await getApi(), { workspaceId: params.workspaceId }, params.dashboardId, deps);
		} catch (error) {
			const code = errorCode(error);
			if (code === "DASHBOARD_NOT_FOUND") throw notFound();
			// A Workspace Dashboard's Reports add up every Site: only those who see each one open them.
			if (code === "FORBIDDEN") return null;
			throw error;
		}
	},
	head: ({ match, loaderData }) => ({
		meta: [{ title: pageTitleOf(match.context.shell.language.code, loaderData?.crumb) }],
	}),
	component: WorkspaceReports,
});

/** Workspace › Dashboards › one › Reports. */
function WorkspaceReports() {
	const t = useT();
	const data = Route.useLoaderData();
	const { workspaceId, dashboardId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("reports.forbiddenWorkspace")} />;
	return (
		<ReportsPage
			key={`${data.selected?.report.id}-${data.review?.id}`}
			place={{ workspaceId }}
			data={data}
			canManage={place.permissions.includes("report.manage")}
			canEditRecipients={place.permissions.includes("reportRecipients.edit")}
			dashboardPath={{
				to: "/workspaces/$workspaceId/dashboards/$dashboardId",
				params: { workspaceId, dashboardId },
			}}
		/>
	);
}
