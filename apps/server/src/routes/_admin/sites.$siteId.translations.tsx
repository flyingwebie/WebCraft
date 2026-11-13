import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { TranslationsPage } from "../../ui/translations/TranslationsPage.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/translations")({
	staticData: { crumb: "translations.pageTitle" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("entry.edit")) return null;
		const api = await getApi();
		const { siteId } = params;
		const [overview, { lines }] = await Promise.all([
			api.translations.overview({ siteId }),
			api.translations.queue({ siteId }),
		]);
		return { overview, lines };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "translations.pageTitle") }],
	}),
	component: TranslationsRoute,
});

/** Site › Translations (Content): each language's Translation mode and progress, and the Review queue. */
function TranslationsRoute() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<TranslationsPage siteId={siteId} overview={data.overview} lines={data.lines} permissions={place.permissions} />
	);
}
