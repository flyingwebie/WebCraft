import { createFileRoute, redirect } from "@tanstack/react-router";

import { getApi } from "../ui/api.ts";
import { pageTitle } from "../ui/i18n.tsx";
import { ApprovalPage } from "../ui/oauth/ApprovalPage.tsx";

/**
 * The approval page an AI client sends the person to (OAuth 2.1's authorization endpoint): signed
 * in, they see the client's name and where it sends them back, and approve it for one Workspace,
 * with the Sites, Toolsets and access they choose, or deny it. The web process serves this page
 * with headers that keep it out of other sites' frames.
 */
export const Route = createFileRoute("/oauth/authorize")({
	beforeLoad: ({ context, location }) => {
		const { shell } = context;
		if (shell.setup.stage === "claim") throw redirect({ to: "/setup" });
		if (!shell.person) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
		return { person: shell.person };
	},
	// The request's parameters exactly as the client wrote them: never read as JSON.
	loaderDeps: ({ search }) => ({ search }),
	loader: async ({ location }) => {
		const parameters = Object.fromEntries(new URLSearchParams(location.searchStr));
		const api = await getApi();
		const answer = await api.oauth.check({ parameters });
		if (answer.check.kind === "redirect") throw redirect({ href: answer.check.to });
		return { ...answer, parameters };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "oauth.pageTitle") }] }),
	component: ApprovalRoute,
});

function ApprovalRoute() {
	const data = Route.useLoaderData();
	const { person } = Route.useRouteContext();
	return <ApprovalPage data={data} person={person} />;
}
