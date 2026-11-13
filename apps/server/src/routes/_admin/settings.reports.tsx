import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { InstallBrandingPage } from "../../ui/reports/Branding.tsx";

export const Route = createFileRoute("/_admin/settings/reports")({
	staticData: { crumb: "branding.installPageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("install.manage")) return null;
		return (await (await getApi()).reportBranding.install.get()).branding;
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "branding.installPageTitle") }],
	}),
	component: InstallReportsSettings,
});

/** Install settings › Reports: the agency brand on Reports and Share links, and what shows on them. */
function InstallReportsSettings() {
	const t = useT();
	const branding = Route.useLoaderData();
	if (!branding) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return <InstallBrandingPage key={JSON.stringify(branding)} branding={branding} />;
}
