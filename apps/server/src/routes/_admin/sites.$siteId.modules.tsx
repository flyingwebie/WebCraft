import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PlaceModules } from "../../ui/modules/PlaceModules.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/modules")({
	staticData: { crumb: "modules.place.pageTitle" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("module.manage")) return null;
		const api = await getApi();
		return api.modules.siteList({ siteId: params.siteId });
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "modules.place.pageTitle") }],
	}),
	component: SiteModulesPage,
});

/** Site › Modules: Staff switch the Site-level Modules on or off for this Site, and remove their data. */
function SiteModulesPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("modules.place.siteHeading")}>{t("modules.place.siteIntro")}</PageHeader>
			<PlaceModules place={{ level: "site", siteId }} modules={data.modules} />
		</>
	);
}
