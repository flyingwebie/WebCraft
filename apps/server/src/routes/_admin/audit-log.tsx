import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { AuditLogScreen } from "../../ui/audit/AuditLog.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

/** Install › Audit log: the whole Install's, its own entries too (the Superadmin). */
export const Route = createFileRoute("/_admin/audit-log")({
	staticData: { crumb: "audit.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("audit.view")) return null;
		const api = await getApi();
		const [first, { people }] = await Promise.all([api.audit.list({}), api.audit.people({})]);
		return { first, people };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "audit.pageTitle") }] }),
	component: InstallAuditLogPage,
});

function InstallAuditLogPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { shell } = Route.useRouteContext();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("audit.heading")}>{t("audit.introInstall", { days: data.first.keptDays })}</PageHeader>
			<AuditLogScreen first={data.first} people={data.people} workspaces={shell.workspaces} />
		</>
	);
}
