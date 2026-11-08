import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { useFormatter } from "use-intl";

import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/")({
	staticData: { crumb: "site.pageTitle" },
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "site.pageTitle") }] }),
	component: SiteOverviewPage,
});

/** Site › Overview: the Site's first page. Its Content, Structure and settings arrive with their screens. */
function SiteOverviewPage() {
	const t = useT();
	const format = useFormatter();
	const { site, place } = Route.useRouteContext();
	const workspace = place.level === "site" ? place.workspace.name : "";
	return (
		<>
			<PageHeader heading={site.name}>{t("site.intro", { workspace })}</PageHeader>
			<Card className="max-w-2xl">
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
						<dd>{format.dateTime(site.createdAt, { dateStyle: "medium" })}</dd>
					</dl>
				</CardContent>
			</Card>
		</>
	);
}
