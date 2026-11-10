import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { SiteBrandingPage } from "../../ui/reports/Branding.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/report-branding")({
	staticData: { crumb: "branding.sitePageTitle" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("reportBranding.manage")) return null;
		return (await (await getApi()).reportBranding.site.get({ siteId: params.siteId })).branding;
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "branding.sitePageTitle") }],
	}),
	component: SiteReportBranding,
});

/** Site › Report branding: the Site's client brand on its Reports and Share links. */
function SiteReportBranding() {
	const t = useT();
	const branding = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!branding) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return <SiteBrandingPage key={JSON.stringify(branding)} siteId={siteId} branding={branding} />;
}
