import { createFileRoute } from "@tanstack/react-router";

import { AiClientsPage } from "../../ui/account/AiClients.tsx";
import { getApi } from "../../ui/api.ts";
import { pageTitle } from "../../ui/i18n.tsx";

/** Your account › AI clients: the AI clients you approved to act as you through the MCP server. */
export const Route = createFileRoute("/_admin/account/ai-clients")({
	staticData: { crumb: "account.aiClients.pageTitle" },
	loader: async () => (await getApi()).aiClients.list(),
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "account.aiClients.pageTitle") }],
	}),
	component: AiClientsRoute,
});

function AiClientsRoute() {
	return <AiClientsPage data={Route.useLoaderData()} />;
}
