import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ImportFlow } from "../../ui/imports/ImportFlow.tsx";

const parent = getRouteApi("/_admin/sites/$siteId/imports/$importId");

export const Route = createFileRoute("/_admin/sites/$siteId/imports/$importId/")({
	component: RunAgainPage,
});

/** Run an Import again: a new file, with the Import's settings kept (columns matched by name). */
function RunAgainPage() {
	const { import: existing } = parent.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (place.level !== "site") return null;
	return (
		<ImportFlow
			siteId={siteId}
			postTypes={place.postTypes}
			languages={place.languages}
			existing={existing}
			canRemoveLive={place.permissions.includes("structure.edit")}
		/>
	);
}
