import { createFileRoute } from "@tanstack/react-router";

import { ApiTokensPage } from "../../ui/account/ApiTokens.tsx";
import { getApi } from "../../ui/api.ts";
import { pageTitle } from "../../ui/i18n.tsx";

/** Your account › API tokens: the tokens scripts and AI clients act as you with, through `/api/v1`. */
export const Route = createFileRoute("/_admin/account/api-tokens")({
	staticData: { crumb: "account.apiTokens.pageTitle" },
	loader: async () => (await getApi()).apiTokens.list(),
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "account.apiTokens.pageTitle") }],
	}),
	component: ApiTokensRoute,
});

function ApiTokensRoute() {
	return <ApiTokensPage data={Route.useLoaderData()} />;
}
