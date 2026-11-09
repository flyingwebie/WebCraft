import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { pageTitle } from "../../ui/i18n.tsx";
import { ImportFlow } from "../../ui/imports/ImportFlow.tsx";

/** The source the new Import starts with: `csv`, or a Module's (`wordpress-import.export`). */
const search = z.object({ source: z.string().max(100).optional().catch(undefined) });

export const Route = createFileRoute("/_admin/sites/$siteId/imports/new")({
	validateSearch: search,
	staticData: { crumb: "imports.flow.newTitle" },
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "imports.flow.newTitle") }] }),
	component: NewImportPage,
});

/** A new Import: its source, mapping and preview, then its first run. */
function NewImportPage() {
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	const { source } = Route.useSearch();
	if (place.level !== "site") return null;
	return (
		<ImportFlow
			siteId={siteId}
			postTypes={place.postTypes}
			languages={place.languages}
			existing={null}
			initialSource={source}
		/>
	);
}
