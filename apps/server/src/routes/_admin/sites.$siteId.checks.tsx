import { createFileRoute } from "@tanstack/react-router";
import { getApi } from "../../ui/api.ts";
import { ChecksScreen } from "../../ui/checks/ChecksScreen.tsx";
import { pageTitle } from "../../ui/i18n.tsx";

/** Site › Checks: the Site's open Checks, by kind. */
export const Route = createFileRoute("/_admin/sites/$siteId/checks")({
	staticData: { crumb: "shell.nav.checks" },
	loader: async ({ params }) => (await getApi()).checks.list({ siteId: params.siteId }),
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "checks.heading") }] }),
	component: Page,
});
function Page() {
	const { checks } = Route.useLoaderData();
	const { place } = Route.useRouteContext();
	return <ChecksScreen checks={checks} postTypes={place.level === "site" ? place.postTypes : []} />;
}
