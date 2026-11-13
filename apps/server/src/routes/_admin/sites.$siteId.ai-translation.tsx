import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { AiTranslationSettings } from "../../ui/translations/AiTranslationSettings.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/ai-translation")({
	staticData: { crumb: "aiTranslation.pageTitle" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("translation.manage") || context.place.level !== "site") return null;
		const api = await getApi();
		const { siteId } = params;
		const [overview, { terms }] = await Promise.all([
			api.translations.overview({ siteId }),
			api.protectedTerms.list({ workspaceId: context.place.workspace.id, siteId }),
		]);
		return { overview, terms, workspaceId: context.place.workspace.id };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "aiTranslation.pageTitle") }],
	}),
	component: AiTranslationRoute,
});

/** Site settings › AI translation: the AI key in use, Protected terms, each language's mode and this month's usage. */
function AiTranslationRoute() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<AiTranslationSettings
			siteId={siteId}
			workspaceId={data.workspaceId}
			overview={data.overview}
			terms={data.terms}
			permissions={place.permissions}
		/>
	);
}
