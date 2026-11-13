import { createFileRoute } from "@tanstack/react-router";

import { InstallAiSettings } from "../../ui/ai/InstallAiSettings.tsx";
import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/settings/ai")({
	staticData: { crumb: "sharedAiKeys.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("install.manage")) return null;
		const api = await getApi();
		return api.sharedAiKeys.list();
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "sharedAiKeys.pageTitle") }],
	}),
	component: InstallAiRoute,
});

/** Install settings › AI: shared AI keys, which Workspace each is assigned to with its monthly cap. */
function InstallAiRoute() {
	const t = useT();
	const data = Route.useLoaderData();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return <InstallAiSettings data={data} />;
}
