import { createFileRoute } from "@tanstack/react-router";
import { AccessibilityStatement } from "../../ui/AccessibilityStatement.tsx";
import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
export const Route = createFileRoute("/_admin/sites/$siteId/accessibility-statement")({
	staticData: { crumb: "statement.heading" },
	loader: async ({ params, context }) =>
		context.place.permissions.includes("structure.edit")
			? (await getApi()).accessibilityStatement.get({ siteId: params.siteId })
			: null,
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "statement.heading") }] }),
	component: Page,
});
function Page() {
	const t = useT();
	const loaded = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (!loaded || place.level !== "site")
		return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("statement.heading")}>{t("statement.intro")}</PageHeader>
			<AccessibilityStatement siteId={siteId} languages={place.languages} settings={loaded.settings} />
		</>
	);
}
