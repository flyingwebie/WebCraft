import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { AuditLogScreen } from "../../ui/audit/AuditLog.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

/**
 * Workspace › Audit log: the Workspace's entries (Staff and Owners, and the Superadmin); an Owner
 * reaching some Sites reads only the Workspace's own entries and those Sites'.
 */
export const Route = createFileRoute("/_admin/workspaces/$workspaceId/audit-log")({
	staticData: { crumb: "audit.pageTitle" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("audit.view")) return null;
		const api = await getApi();
		const [first, { people }] = await Promise.all([
			api.audit.list({ workspaceId: params.workspaceId }),
			api.audit.people({ workspaceId: params.workspaceId }),
		]);
		return { first, people };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "audit.pageTitle") }] }),
	component: WorkspaceAuditLogPage,
});

function WorkspaceAuditLogPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { workspaceId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("audit.heading")}>{t("audit.introWorkspace", { days: data.first.keptDays })}</PageHeader>
			<AuditLogScreen
				key={workspaceId}
				workspaceId={workspaceId}
				first={data.first}
				people={data.people}
				sites={place.sites}
			/>
		</>
	);
}
