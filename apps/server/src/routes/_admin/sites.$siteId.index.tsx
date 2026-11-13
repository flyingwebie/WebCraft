import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";

import { getApi } from "../../ui/api.ts";
import { formatUtcDate } from "../../ui/format.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { WaitingForReview } from "../../ui/review/Review.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/")({
	staticData: { crumb: "site.pageTitle" },
	loader: async ({ params }) => {
		const api = await getApi();
		return { reviews: (await api.reviews.list({ siteId: params.siteId })).reviews };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "site.pageTitle") }] }),
	component: SiteOverviewPage,
});

/**
 * Site › Overview: the Site's first page: what waits for review (GLOSSARY.md › Review), with a link to
 * each item, and the Site's details. Its other Content, Structure and settings have their own screens.
 */
function SiteOverviewPage() {
	const t = useT();
	const { site, place } = Route.useRouteContext();
	const { reviews } = Route.useLoaderData();
	const workspace = place.level === "site" ? place.workspace.name : "";
	return (
		<>
			<PageHeader heading={site.name}>{t("site.intro", { workspace })}</PageHeader>
			<div className="grid max-w-2xl gap-6">
				<WaitingForReview siteId={site.id} reviews={reviews} />
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("site.details")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-sm">
							<dt className="text-muted-foreground">{t("site.name")}</dt>
							<dd>{site.name}</dd>
							<dt className="text-muted-foreground">{t("site.slug")}</dt>
							<dd className="font-mono">{site.slug}</dd>
							<dt className="text-muted-foreground">{t("site.workspace")}</dt>
							<dd>{workspace}</dd>
							<dt className="text-muted-foreground">{t("site.created")}</dt>
							<dd>{formatUtcDate(site.createdAt)}</dd>
						</dl>
					</CardContent>
				</Card>
			</div>
		</>
	);
}
