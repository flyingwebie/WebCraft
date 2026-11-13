import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { SiteImportsPage } from "../../ui/site-transfer/SiteImports.tsx";

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/site-imports/")({
	staticData: { crumb: "siteImports.pageTitle" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("site.import")) return null;
		const api = await getApi();
		return api.siteImports.list({ workspaceId: params.workspaceId });
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "siteImports.pageTitle") }],
	}),
	component: SiteImportsRoute,
});

/** Workspace › Site imports (Staff): a Site export uploaded and imported as a new Site, with its report. */
function SiteImportsRoute() {
	const t = useT();
	const data = Route.useLoaderData();
	const { workspaceId } = Route.useParams();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return <SiteImportsPage workspaceId={workspaceId} initial={data.imports} />;
}
