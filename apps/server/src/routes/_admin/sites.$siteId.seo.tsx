import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import type { MediaItem } from "../../ui/media/preview.ts";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { SiteSeoSettings } from "../../ui/seo/SiteSeoSettings.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/seo")({
	staticData: { crumb: "shell.nav.seo" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("structure.edit")) return null;
		const api = await getApi();
		const { siteId } = params;
		const [{ settings }, { globals }] = await Promise.all([
			api.seoSettings.get({ siteId }),
			api.globals.get({ siteId }),
		]);
		const ids = [settings.defaultImage, settings.organization.logo].filter((mediaId): mediaId is string =>
			Boolean(mediaId),
		);
		const items = await Promise.all(
			ids.map((mediaId) =>
				api.media.get({ siteId, mediaId }).then(
					({ media }) => media,
					() => null,
				),
			),
		);
		const media: Record<string, MediaItem> = Object.fromEntries(
			items.filter((item): item is MediaItem => item !== null).map((item) => [item.id, item]),
		);
		return { settings, globals: globals.fields, media };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "shell.nav.seo") }] }),
	component: SeoPage,
});

/** Site › SEO: the Site's SEO settings (Structure, Staff only). */
function SeoPage() {
	const t = useT();
	const loaded = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { site } = Route.useRouteContext();
	if (!loaded) return null;
	return (
		<>
			<PageHeader heading={t("seo.site.heading")}>{t("seo.site.intro")}</PageHeader>
			<SiteSeoSettings
				key={JSON.stringify(loaded.settings)}
				siteId={siteId}
				siteName={site.name}
				settings={loaded.settings}
				globals={loaded.globals}
				media={loaded.media}
			/>
		</>
	);
}
