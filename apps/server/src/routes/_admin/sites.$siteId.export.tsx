import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { SiteExportPage } from "../../ui/site-transfer/SiteExport.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/export")({
	staticData: { crumb: "siteExport.pageTitle" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("site.export")) return null;
		const api = await getApi();
		return api.siteExports.list({ siteId: params.siteId });
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "siteExport.pageTitle") }],
	}),
	component: SiteExportRoute,
});

/** Site › Export (Site settings, Staff): the Site as one file, and its exports' download links. */
function SiteExportRoute() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return <SiteExportPage siteId={siteId} initial={data.exports} />;
}
