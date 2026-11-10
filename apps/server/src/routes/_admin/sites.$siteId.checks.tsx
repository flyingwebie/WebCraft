import { createFileRoute } from "@tanstack/react-router";
import { getApi } from "../../ui/api.ts";
import { Checks } from "../../ui/Checks.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
export const Route = createFileRoute("/_admin/sites/$siteId/checks")({
	staticData: { crumb: "shell.nav.checks" },
	loader: async ({ params }) => (await getApi()).checks.list({ siteId: params.siteId }),
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "checks.heading") }] }),
	component: Page,
});
function Page() {
	const t = useT();
	const { checks } = Route.useLoaderData();
	return (
		<>
			<PageHeader heading={t("checks.heading")} />
			<Checks checks={checks} />
		</>
	);
}
