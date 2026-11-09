import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";

import { pageTitleOf } from "../../ui/i18n.tsx";
import { MODULE_PAGES, ModulePage } from "../../ui/modules/pages.tsx";

/** The tab a Module's page opens on, kept in the address so a link (or a check) can open it. */
const search = z.object({ tab: z.string().max(40).optional().catch(undefined) });

/** A Module's admin page on a Site: only where the Module runs and the person may open it. */
export const Route = createFileRoute("/_admin/sites/$siteId/m/$moduleId/$")({
	beforeLoad: ({ context, params }) => {
		const page =
			context.place.level === "site"
				? context.place.modulePages.find(
						(candidate) => candidate.moduleId === params.moduleId && candidate.path === params._splat,
					)
				: undefined;
		if (!page) throw notFound();
		return { modulePage: page };
	},
	validateSearch: search,
	// The page's name is the Module's label for it; its screen loads what it shows for the place.
	loader: async ({ context, params }) => ({
		crumb: context.modulePage.label,
		data: await MODULE_PAGES[params.moduleId]?.[params._splat ?? ""]?.load?.(params.siteId),
	}),
	head: ({ match }) => ({
		meta: [{ title: pageTitleOf(match.context.shell.language.code, match.context.modulePage.label) }],
	}),
	component: SiteModulePage,
});

function SiteModulePage() {
	const { place } = Route.useRouteContext();
	const { moduleId, _splat } = Route.useParams();
	const { data } = Route.useLoaderData();
	const { tab } = Route.useSearch();
	return <ModulePage place={place} moduleId={moduleId} path={_splat ?? ""} data={data} tab={tab} />;
}
