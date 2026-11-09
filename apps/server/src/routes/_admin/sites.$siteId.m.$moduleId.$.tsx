import { createFileRoute, notFound } from "@tanstack/react-router";

import { pageTitle } from "../../ui/i18n.tsx";
import { ModulePage } from "../../ui/modules/pages.tsx";

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
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "modules.pageTitle") }],
	}),
	component: SiteModulePage,
});

function SiteModulePage() {
	const { place } = Route.useRouteContext();
	const { moduleId, _splat } = Route.useParams();
	return <ModulePage place={place} moduleId={moduleId} path={_splat ?? ""} />;
}
