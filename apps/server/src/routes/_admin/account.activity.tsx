import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { ActivityList } from "../../ui/audit/AuditLog.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";

/**
 * Your account › Activity: what you did on the Install, and what the Superadmin or Staff did as you
 * while impersonating you, newest first.
 */
export const Route = createFileRoute("/_admin/account/activity")({
	staticData: { crumb: "activity.pageTitle" },
	loader: async () => (await getApi()).me.activity({}),
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "activity.pageTitle") }] }),
	component: ActivityPage,
});

function ActivityPage() {
	const t = useT();
	const first = Route.useLoaderData();
	const { shell } = Route.useRouteContext();
	const impersonated = shell.impersonation?.person.name;
	return (
		<>
			<PageHeader heading={t("activity.heading")}>
				{impersonated ? t("activity.introImpersonating", { name: impersonated }) : t("activity.intro")}
			</PageHeader>
			<ActivityList first={first} />
		</>
	);
}
