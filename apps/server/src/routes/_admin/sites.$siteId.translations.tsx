import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";
import { TranslationsPage } from "../../ui/translations/TranslationsPage.tsx";

/** The language whose tab is open; the first one other than the Default language when none is given. */
const search = z.object({ language: z.string().min(2).max(35).optional().catch(undefined) });

export const Route = createFileRoute("/_admin/sites/$siteId/translations")({
	staticData: { crumb: "translations.pageTitle", width: "wide" },
	validateSearch: search,
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("entry.edit")) return null;
		const api = await getApi();
		const { siteId } = params;
		const workspaceId = context.place.level === "site" ? context.place.workspace.id : null;
		const [overview, { lines }, terms] = await Promise.all([
			api.translations.overview({ siteId }),
			api.translations.queue({ siteId }),
			// The Protected terms are notes beside a translation: without them the screen still works.
			workspaceId
				? api.protectedTerms
						.list({ workspaceId, siteId })
						.then(({ terms: listed }) => listed.map(({ term, matchCase }) => ({ term, matchCase })))
						.catch(() => [])
				: Promise.resolve([]),
		]);
		return { overview, lines, terms };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "translations.pageTitle") }],
	}),
	component: TranslationsRoute,
});

/** Site › Translations (Content): each language's progress, and what waits in it for a person. */
function TranslationsRoute() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { language } = Route.useSearch();
	const { place } = Route.useRouteContext();
	const navigate = useNavigate({ from: Route.fullPath });
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<TranslationsPage
			siteId={siteId}
			overview={data.overview}
			lines={data.lines}
			terms={data.terms}
			permissions={place.permissions}
			language={language}
			onLanguage={(code) => void navigate({ search: { language: code }, replace: true, resetScroll: false })}
		/>
	);
}
