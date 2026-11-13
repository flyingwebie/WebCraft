import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PlaceModules } from "../../ui/modules/PlaceModules.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/modules")({
	staticData: { crumb: "modules.place.pageTitle" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("module.manage")) return null;
		const api = await getApi();
		return api.modules.workspaceList({ workspaceId: params.workspaceId });
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "modules.place.pageTitle") }],
	}),
	component: WorkspaceModulesPage,
});

/** Workspace › Modules: Staff switch the Workspace-level Modules on or off here, and remove their data. */
function WorkspaceModulesPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { workspaceId } = Route.useParams();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("modules.place.workspaceHeading")}>{t("modules.place.workspaceIntro")}</PageHeader>
			<PlaceModules place={{ level: "workspace", workspaceId }} modules={data.modules} />
		</>
	);
}
