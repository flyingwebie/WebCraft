import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { CrawlersSettings } from "../../ui/seo/CrawlersSettings.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/crawlers")({
	staticData: { crumb: "shell.nav.crawlers" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("aiCrawlers.manage")) return null;
		const api = await getApi();
		const { siteId } = params;
		const [{ settings }, { domains }] = await Promise.all([
			api.seoSettings.get({ siteId }),
			api.domains.list({ siteId }),
		]);
		const primary = domains.find((domain) => domain.role === "primary" && domain.verifiedAt !== null);
		return {
			settings,
			origin: primary ? `https://${primary.name}` : null,
			canEditLines: context.place.permissions.includes("structure.edit"),
		};
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "shell.nav.crawlers") }] }),
	component: CrawlersPage,
});

/** Site settings › Crawlers: what search engines and AI crawlers may read (Staff and Owners). */
function CrawlersPage() {
	const t = useT();
	const loaded = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!loaded) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	return (
		<>
			<PageHeader heading={t("seo.crawlers.heading")}>{t("seo.crawlers.intro")}</PageHeader>
			<CrawlersSettings
				key={JSON.stringify(loaded.settings)}
				siteId={siteId}
				settings={loaded.settings}
				origin={loaded.origin}
				canEditLines={loaded.canEditLines}
			/>
		</>
	);
}
