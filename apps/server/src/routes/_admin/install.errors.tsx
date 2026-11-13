import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { ErrorLogScreen } from "../../ui/health/ErrorLog.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

/** Install › Error log (the Superadmin): unexpected failures, grouped by cause. */
export const Route = createFileRoute("/_admin/install/errors")({
	staticData: { crumb: "errorLog.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("installHealth.manage")) return null;
		const api = await getApi();
		return { first: await api.errorLog.list({}) };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "errorLog.pageTitle") }] }),
	component: ErrorLogPage,
});

function ErrorLogPage() {
	const t = useT();
	const data = Route.useLoaderData();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("errorLog.heading")}>{t("errorLog.intro", { days: data.first.keptDays })}</PageHeader>
			<ErrorLogScreen first={data.first} />
		</>
	);
}
