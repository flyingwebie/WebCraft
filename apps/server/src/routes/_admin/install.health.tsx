import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { InstallHealthScreen } from "../../ui/health/InstallHealth.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

/** Install › Install health (the Superadmin): worked out when it opens, then every part and the failed jobs. */
export const Route = createFileRoute("/_admin/install/health")({
	staticData: { crumb: "installHealth.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("installHealth.manage")) return null;
		const api = await getApi();
		const [report, { queues }] = await Promise.all([
			api.installHealth.get({ refresh: true }),
			api.installHealth.queues(),
		]);
		return { report, queues };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "installHealth.pageTitle") }] }),
	component: InstallHealthPage,
});

function InstallHealthPage() {
	const t = useT();
	const data = Route.useLoaderData();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("installHealth.heading")}>{t("installHealth.intro")}</PageHeader>
			<InstallHealthScreen report={data.report} queues={data.queues} />
		</>
	);
}
