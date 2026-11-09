import { createFileRoute, Outlet } from "@tanstack/react-router";

import { useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";

/**
 * Site › Imports: the Site's Imports, the steps of a new one, and each run's progress and Import
 * report. For Staff, Owners and Editors (`import.run`); anyone else is told they can't open it.
 */
export const Route = createFileRoute("/_admin/sites/$siteId/imports")({
	staticData: { crumb: "imports.pageTitle", wide: true },
	component: ImportsLayout,
});

function ImportsLayout() {
	const t = useT();
	const { place } = Route.useRouteContext();
	if (!place.permissions.includes("import.run")) {
		return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	}
	return <Outlet />;
}
