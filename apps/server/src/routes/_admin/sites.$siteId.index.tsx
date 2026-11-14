import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { SiteOverview } from "../../ui/content/SiteOverview.tsx";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";

/** How many of the Site's newest Audit log entries "Recent activity" shows. */
const ACTIVITY = 5;

export const Route = createFileRoute("/_admin/sites/$siteId/")({
	staticData: { crumb: "site.pageTitle", width: "wide" },
	// `publishAll=1` opens Publish all at once (the shell reads it); "Drafts and changes" links there.
	validateSearch: z.object({ publishAll: z.string().max(1).optional().catch(undefined) }),
	loader: async ({ params, context }) => {
		const api = await getApi();
		const workspaceId = context.place.level === "site" ? context.place.workspace.id : undefined;
		// Only those who read the Workspace's Audit log (Staff, Owners) get "Recent activity"; it is
		// never asked for the others, so they meet no refusal.
		const readsAudit = async () =>
			workspaceId !== undefined &&
			(await api.workspaces.get({ workspaceId }).then(
				({ permissions }) => permissions.includes("audit.view"),
				() => false,
			));
		const [{ reviews }, domains, activity] = await Promise.all([
			api.reviews.list({ siteId: params.siteId }),
			api.domains.list({ siteId: params.siteId }),
			readsAudit().then((reads) =>
				reads ? api.audit.list({ workspaceId, siteId: params.siteId, limit: ACTIVITY }).catch(() => null) : null,
			),
		]);
		return { reviews, domains, activity };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "site.pageTitle") }] }),
	component: SiteOverviewPage,
});

/**
 * Site › Overview: the Site's first page: what waits for review (GLOSSARY.md › Review), the Drafts
 * waiting to be published, recent activity, quick actions and the Site's domain, languages and
 * Staging address. Its other Content, Structure and settings have their own screens.
 */
function SiteOverviewPage() {
	const t = useT();
	const { site, place } = Route.useRouteContext();
	const data = Route.useLoaderData();
	if (place.level !== "site") return null;
	return (
		<>
			<PageHeader heading={site.name}>{t("site.intro", { workspace: place.workspace.name })}</PageHeader>
			<SiteOverview
				siteId={site.id}
				data={data}
				languages={place.languages}
				postTypes={place.postTypes}
				permissions={place.permissions}
				drafts={place.drafts}
			/>
		</>
	);
}
