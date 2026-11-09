import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { DomainsPage } from "../../ui/domains/Domains.tsx";
import { pageTitle } from "../../ui/i18n.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/domains")({
	staticData: { crumb: "domains.pageTitle" },
	loader: async ({ params }) => {
		const api = await getApi();
		const [domains, { settings }] = await Promise.all([
			api.domains.list({ siteId: params.siteId }),
			api.languages.list({ siteId: params.siteId }),
		]);
		return { domains, languageNames: Object.fromEntries(settings.languages.map(({ code, name }) => [code, name])) };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "domains.pageTitle") }],
	}),
	component: DomainsRoute,
});

/**
 * Site › Domains & Staging (Site settings): Staff change the Site's domains here; anyone else who
 * sees the Site and follows a link here (the Domain check's email to Owners) sees their state.
 */
function DomainsRoute() {
	const { domains, languageNames } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	return (
		<DomainsPage
			siteId={siteId}
			data={domains}
			canEdit={place.permissions.includes("structure.edit")}
			languageNames={languageNames}
		/>
	);
}
