import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { WorkspaceBrandingPage } from "../../ui/reports/Branding.tsx";

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/report-branding")({
	staticData: { crumb: "branding.workspacePageTitle" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("reportBranding.manage")) return null;
		return (await (await getApi()).reportBranding.workspace.get({ workspaceId: params.workspaceId })).branding;
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "branding.workspacePageTitle") }],
	}),
	component: WorkspaceReportBranding,
});

/** Workspace › Report branding: the Workspace's agency and client brand on Reports and Share links. */
function WorkspaceReportBranding() {
	const t = useT();
	const branding = Route.useLoaderData();
	const { workspaceId } = Route.useParams();
	if (!branding) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return <WorkspaceBrandingPage key={JSON.stringify(branding)} workspaceId={workspaceId} branding={branding} />;
}
