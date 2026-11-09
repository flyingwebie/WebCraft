import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { ServicesListPage } from "../../ui/reports/ServicesList.tsx";

export const Route = createFileRoute("/_admin/services")({
	staticData: { crumb: "servicesList.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("servicesList.edit")) return null;
		return (await (await getApi()).servicesList.get()).services;
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "servicesList.pageTitle") }],
	}),
	component: ServicesRoute,
});

/** The Services list: what the agency offers, written once for the Install by Staff. */
function ServicesRoute() {
	const t = useT();
	const services = Route.useLoaderData();
	if (!services) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return <ServicesListPage key={JSON.stringify(services)} services={services} />;
}
