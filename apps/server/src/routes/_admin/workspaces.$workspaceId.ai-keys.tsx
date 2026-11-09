import { createFileRoute } from "@tanstack/react-router";

import { AiKeysPage } from "../../ui/ai/AiKeysPage.tsx";
import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/ai-keys")({
	staticData: { crumb: "aiKeys.pageTitle" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("aiKey.manage")) return null;
		const api = await getApi();
		return api.aiKeys.get({ workspaceId: params.workspaceId });
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "aiKeys.pageTitle") }],
	}),
	component: AiKeysRoute,
});

/** Workspace › AI keys: the Workspace's own AI key, the shared one assigned to it, and what each Site spent. */
function AiKeysRoute() {
	const t = useT();
	const view = Route.useLoaderData();
	const { workspaceId } = Route.useParams();
	if (!view) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return <AiKeysPage key={JSON.stringify(view.own)} workspaceId={workspaceId} view={view} />;
}
